// An independent, test-mode subscription projector. Node 22.13+ (node:sqlite).
// All dependencies are built in. Start with a workspace/subscription binding from
// a trusted checkout flow. Fixtures use Stripe-shaped Connect subscription events.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const WEEK = 7 * 24 * 3600;
const dispositions = { active: 1, trialing: 1, past_due: 2, unpaid: 2, canceled: 3 };
const supported = new Set(['customer.subscription.updated', 'customer.subscription.deleted']);

function openEnvelope(body, header, secret, now) {
  if (!Buffer.isBuffer(body) || body.length > 256 * 1024 || typeof header !== 'string') {
    throw new Error('Invalid envelope');
  }
  const fields = header.split(',').map(field => field.trim().split('='));
  const times = fields.filter(([key]) => key === 't');
  if (times.length !== 1 || !/^\d{1,12}$/.test(times[0][1])) throw new Error('Invalid timestamp');
  const posted = Number(times[0][1]);
  if (Math.abs(now - posted) > 300) throw new Error('Expired signature');
  const expected = createHmac('sha256', secret).update(times[0][1] + '.').update(body).digest();
  const valid = fields.some(([key, value]) => key === 'v1' && /^[a-f0-9]{64}$/i.test(value)
    && timingSafeEqual(expected, Buffer.from(value, 'hex')));
  if (!valid) throw new Error('Invalid signature');
  return JSON.parse(body.toString('utf8'));
}

function normalize(raw, account) {
  if (!raw || raw.account !== account || raw.livemode !== false) throw new Error('Account or mode mismatch');
  if (!supported.has(raw.type) || !Number.isSafeInteger(raw.created) || raw.created <= 0
    || !/^evt_[a-zA-Z0-9_]+$/.test(raw.id)) throw new Error('Invalid event header');
  const sub = raw.data?.object;
  if (sub?.object !== 'subscription' || !/^sub_[a-zA-Z0-9_]+$/.test(sub.id)
    || typeof sub.customer !== 'string' || !sub.customer) throw new Error('Invalid subscription');
  const status = raw.type.endsWith('.deleted') ? 'canceled' : sub.status;
  if (!Object.hasOwn(dispositions, status)) throw new Error('Unsupported transition');
  const items = sub.items?.data;
  const item = Array.isArray(items) && items.length === 1 ? items[0] : null;
  return {
    id:raw.id, account, type:raw.type, time:raw.created, subscription:sub.id,
    customer:sub.customer, status, price:item?.price?.id ?? null,
    quantity:item?.quantity ?? null,
  };
}

// Database writes contain no asynchronous or network boundary. State, delivery
// outcome and the downstream notification commit or roll back together. The
// outbox consumer must itself use notification_key as its delivery idempotency key.
export class SubscriptionProjection {
  constructor({file = ':memory:', account, secret, clock = () => Date.now() / 1000}) {
    if (!account || !secret?.length) throw new Error('A test account and endpoint secret are required');
    this.account = account;
    this.secret = secret;
    this.clock = clock;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS bindings (
        account TEXT, sub TEXT, workspace TEXT NOT NULL, customer TEXT NOT NULL,
        price TEXT NOT NULL, PRIMARY KEY(account,sub));
      CREATE TABLE IF NOT EXISTS entitlements (
        account TEXT, sub TEXT, disposition TEXT NOT NULL, position INTEGER NOT NULL,
        precedence INTEGER NOT NULL, grace_until INTEGER, PRIMARY KEY(account,sub));
      CREATE TABLE IF NOT EXISTS inbox (
        account TEXT, event_id TEXT, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(account,event_id));
      CREATE TABLE IF NOT EXISTS outbox (
        notification_key TEXT PRIMARY KEY, workspace TEXT NOT NULL, access TEXT NOT NULL,
        grace_until INTEGER);`);
  }

  bind({subscription, workspace, customer, price}) {
    this.db.prepare('INSERT INTO bindings VALUES(?,?,?,?,?)')
      .run(this.account, subscription, workspace, customer, price);
  }

  receive(body, signature, options = {}) {
    const event = normalize(openEnvelope(body, signature, this.secret, this.clock()), this.account);
    // Hash normalized business fields. JSON whitespace, key order and unrelated
    // envelope properties can change without changing the delivery's identity.
    const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT fingerprint,result FROM inbox WHERE account=? AND event_id=?')
        .get(event.account, event.id);
      let response;
      if (previous) {
        response = previous.fingerprint === digest
          ? {result:previous.result, replay:true}
          : {result:'identity-conflict', replay:false};
      } else {
        const result = this.project(event);
        // A binding can arrive after the subscription event. An ACK here would
        // make a later redelivery useless, so leave this particular key unclaimed.
        if (result !== 'retry-unbound') {
          this.db.prepare('INSERT INTO inbox VALUES(?,?,?,?)').run(event.account, event.id, digest, result);
        }
        options.beforeCommit?.(); // test seam for a crash after the writes
        response = {result, replay:false};
      }
      this.db.exec('COMMIT');
      return response;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  project(event) {
    const {account, subscription, status, time} = event;
    const binding = this.db.prepare('SELECT * FROM bindings WHERE account=? AND sub=?').get(account, subscription);
    if (!binding) return 'retry-unbound';
    if (binding.customer !== event.customer) return 'binding-conflict';
    const rank = dispositions[status];
    if (rank === 1 && (event.price !== binding.price || event.quantity !== 1)) return 'plan-mismatch';
    const current = this.snapshot(subscription);
    // Event timestamps are seconds. At equal timestamps, a cancellation wins
    // even if the grant reaches the worker last. Never sort opaque event IDs.
    if (current && (time < current.position || (time === current.position && rank <= current.precedence))) {
      return 'stale';
    }
    let access = rank === 1 ? 'active' : 'revoked';
    let grace = null;
    if (rank === 2 && current && current.disposition !== 'revoked') {
      access = 'grace';
      grace = current.grace_until ?? time + WEEK;
    }
    this.db.prepare(`INSERT INTO entitlements VALUES(?,?,?,?,?,?)
      ON CONFLICT(account,sub) DO UPDATE SET disposition=excluded.disposition,
        position=excluded.position, precedence=excluded.precedence, grace_until=excluded.grace_until`)
      .run(account, subscription, access, time, rank, grace);
    if (current?.disposition !== access || current.grace_until !== grace) {
      this.db.prepare('INSERT INTO outbox VALUES(?,?,?,?)')
        .run(JSON.stringify([account,event.id]), binding.workspace, access, grace);
    }
    return 'applied';
  }

  snapshot(subscription) {
    return this.db.prepare('SELECT * FROM entitlements WHERE account=? AND sub=?').get(this.account, subscription);
  }
  accessAt(subscription, time) {
    const state = this.snapshot(subscription);
    if (!state || state.disposition === 'revoked') return false;
    return state.grace_until == null || time < state.grace_until;
  }
  notices() { return this.db.prepare('SELECT * FROM outbox ORDER BY rowid').all(); }
  close() { this.db.close(); }
}

// Original public example entry points.
export { readinessCard } from './compatibility.mjs';
