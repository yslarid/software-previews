// A standalone accounting integration exercise. Node.js 24+, standard library only.
// The adapter is fictional. No credentials, network calls or vendor SDK are required.
// The caller supplies an authenticated dealer and operator; authorization is outside this example.
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function priceLine(quantityThousandths, unitPriceCents) {
  if (typeof quantityThousandths !== 'bigint' || typeof unitPriceCents !== 'bigint') {
    throw new TypeError('Use integer quantities and rates expressed as bigint.');
  }
  const product = quantityThousandths * unitPriceCents;
  return (product + (product < 0n ? -500n : 500n)) / 1000n;
}

export function subtotal(lines) {
  return lines.reduce((sum, line) => sum + priceLine(line.quantityThousandths, line.unitPriceCents), 0n);
}

const cleanText = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Expected non-empty text.');
  return value.trim().replace(/\s+/g, ' ');
};

function integer(value) {
  if (!Number.isSafeInteger(value)) throw new RangeError('Expected a safe integer.');
  return value;
}

function moneyNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || BigInt(number) !== value) throw new RangeError('Amount exceeds safe range.');
  return number;
}

function invoiceContent(draft) {
  if (!Array.isArray(draft.lines) || !draft.lines.length) throw new TypeError('Invoice lines required.');
  const lines = draft.lines.map(line => {
    const qty = integer(line.qty);
    if (qty <= 0) throw new RangeError('Quantity must be positive.');
    return { item: cleanText(line.item), qty, rate: integer(line.rate), taxCode: cleanText(line.taxCode) };
  });
  return { reference: cleanText(draft.reference), customer: cleanText(draft.customer),
    issueDate: cleanText(draft.issueDate), currency: cleanText(draft.currency), lines };
}

function approval(draft) {
  const content = invoiceContent(draft);
  const net = moneyNumber(subtotal(content.lines.map(line => ({
    quantityThousandths: BigInt(line.qty), unitPriceCents: BigInt(line.rate)
  }))));
  const tax = integer(draft.tax);
  return { ...content, net, tax, total: moneyNumber(BigInt(net) + BigInt(tax)) };
}

function digest(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

// A single truncated row can conceal a second matching invoice. Validate the entire
// adapter response before interpreting a match or an empty reference lookup.
function inspectCandidates(reference, candidates) {
  if (!Array.isArray(candidates)) return null;
  const seen = new Set(), parsed = [];
  for (const row of candidates) {
    const id = row?.remoteId;
    if (typeof id !== 'string' || !id.trim() || seen.has(id) || row.reference !== reference) return null;
    if (![row.net, row.tax, row.total].every(Number.isSafeInteger)) return null;
    if (BigInt(row.net) + BigInt(row.tax) !== BigInt(row.total)) return null;
    try { parsed.push({ row, signature: digest(invoiceContent(row)) }); }
    catch { return null; }
    seen.add(id);
  }
  return parsed;
}

// A matching invoice number alone does not establish identity. Accounting systems can
// also calculate tax differently. Verify business inputs, then report computed differences.
export function compareEvidence(approved, candidates) {
  const identity = digest(invoiceContent(approved));
  const rows = inspectCandidates(approved.reference, candidates);
  if (!rows) return { state: 'review', reason: 'incomplete_evidence' };
  const exact = rows.filter(candidate => candidate.signature === identity);
  if (exact.length !== 1) {
    const reason = exact.length ? 'multiple_matches' : rows.length ? 'content_conflict' : 'not_visible';
    return { state: reason === 'not_visible' ? 'uncertain' : 'review', reason,
      candidates: candidates.map(row => row.remoteId) };
  }
  const record = exact[0].row;
  const differences = ['net', 'tax', 'total'].filter(field => approved[field] !== record[field])
    .map(field => ({ field, approved: approved[field], provider: record[field] ?? null }));
  return { state: 'posted', reason: 'identified', remoteId: record.remoteId, differences };
}

export class InvoiceJournal {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 2000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS bindings (
        tenant TEXT PRIMARY KEY, company TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invoices (
        tenant TEXT NOT NULL, task TEXT NOT NULL, company TEXT NOT NULL, reference TEXT NOT NULL,
        snapshot TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0, lease TEXT, until_ms INTEGER, retry_at INTEGER,
        evidence TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (tenant, task), UNIQUE (company, reference)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, tenant TEXT NOT NULL, task TEXT NOT NULL, state TEXT NOT NULL,
        detail TEXT NOT NULL, FOREIGN KEY (tenant, task) REFERENCES invoices(tenant, task)
      );`);
  }
  close() { this.db.close(); }

  // Transactions never span provider I/O. The version paired with each claim acts
  // as a fencing token when a delayed worker returns after recovery has begun.
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  bind(tenant, company) {
    this.db.prepare('INSERT INTO bindings VALUES (?, ?) ON CONFLICT(tenant) DO UPDATE SET company=excluded.company')
      .run(cleanText(tenant), cleanText(company));
  }
  company(tenant) { return this.db.prepare('SELECT company FROM bindings WHERE tenant=?').get(tenant)?.company; }
  log(tenant, task, state, detail) {
    this.db.prepare('INSERT INTO events(tenant,task,state,detail) VALUES (?,?,?,?)')
      .run(tenant, task, state, JSON.stringify(detail));
  }
  history(tenant, task) {
    return this.db.prepare('SELECT seq,state,detail FROM events WHERE tenant=? AND task=? ORDER BY seq')
      .all(tenant, task).map(row => ({ ...row, detail: JSON.parse(row.detail) }));
  }
  get(tenant, task) {
    const row = this.db.prepare('SELECT * FROM invoices WHERE tenant=? AND task=?').get(tenant, task);
    return row && { ...row, snapshot: JSON.parse(row.snapshot), evidence: JSON.parse(row.evidence) };
  }
  propose(tenant, task, draft) {
    const snapshot = JSON.stringify(approval(draft));
    cleanText(task);
    return this.transaction(() => {
      const company = this.company(tenant);
      if (!company) throw new Error('No company bound to this dealer.');
      const existing = this.get(tenant, task);
      if (existing) {
        if (JSON.stringify(existing.snapshot) !== snapshot || existing.company !== company) {
          throw new Error('Idempotency key already represents a different approval.');
        }
        return existing;
      }
      const reference = JSON.parse(snapshot).reference;
      this.db.prepare(`INSERT INTO invoices(tenant,task,company,reference,snapshot,request_id,state)
                       VALUES (?,?,?,?,?,?,'draft')`).run(tenant, task, company, reference, snapshot, randomUUID());
      this.log(tenant, task, 'draft', { reason: 'proposed' });
      return this.get(tenant, task);
    });
  }
  transition(expected, state, evidence, { lease = null, until = null, retryAt = null } = {}) {
    return this.transaction(() => {
      const { changes } = this.db.prepare(`UPDATE invoices SET state=?,evidence=?,lease=?,until_ms=?,
        retry_at=?,version=version+1 WHERE tenant=? AND task=? AND version=?`).run(
          state, JSON.stringify(evidence), lease, until, retryAt, expected.tenant, expected.task, expected.version);
      if (changes) this.log(expected.tenant, expected.task, state, evidence);
      return this.get(expected.tenant, expected.task);
    });
  }
  approve(tenant, task, operator) {
    const row = this.get(tenant, task);
    if (row?.state !== 'draft') throw new Error('A draft is required for approval.');
    return this.transition(row, 'approved', { reason: 'operator_approval', operator: cleanText(operator) });
  }
  claim(tenant, task, now, leaseMs) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new RangeError('Lease must be positive.');
    const row = this.get(tenant, task);
    if (!row || !['approved', 'retryable'].includes(row.state) || row.retry_at > now) return null;
    const lease = randomUUID();
    const result = this.transition(row, 'sending', { reason: 'worker_claim' }, { lease, until: now + leaseMs });
    return result?.lease === lease ? result : null;
  }
}

export class RetryBeforeWrite extends Error {
  constructor(delayMs) {
    super('Provider rejected the request before applying it.');
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new RangeError('Invalid retry interval.');
    this.delayMs = delayMs;
  }
}

export async function dispatchInvoice(journal, books, tenant, task, { now = Date.now, leaseMs = 30000 } = {}) {
  const claim = journal.claim(tenant, task, now(), leaseMs);
  if (!claim) return journal.get(tenant, task);
  const finish = (state, detail, flags) => journal.transition(claim, state, detail, flags);
  if (journal.company(tenant) !== claim.company) return finish('review', { reason: 'company_binding_changed' });

  let existing;
  try { existing = await books.find(claim.company, claim.reference); }
  catch { return finish('retryable', { reason: 'preflight_read_failed' }, { retryAt: now() + 1000 }); }
  if (!inspectCandidates(claim.reference, existing)) {
    return finish('review', { reason: 'preflight_incomplete' });
  }
  if (existing.length) {
    return finish('review', { reason: 'reference_already_used', candidates: existing.map(row => row.remoteId) });
  }

  if (journal.company(tenant) !== claim.company) return finish('review', { reason: 'company_binding_changed' });
  if (now() >= claim.until_ms || journal.get(tenant, task).lease !== claim.lease) {
    return finish('uncertain', { reason: 'lost_lease' });
  }
  try {
    const receipt = await books.create(claim.company, claim.snapshot, claim.request_id);
    const evidence = compareEvidence(claim.snapshot, [receipt]);
    return finish(evidence.state, evidence);
  } catch (error) {
    if (error instanceof RetryBeforeWrite) {
      return finish('retryable', { reason: 'confirmed_no_write' }, { retryAt: now() + error.delayMs });
    }
    return finish('uncertain', { reason: 'acknowledgement_unknown' });
  }
}

export async function reconcileInvoice(journal, books, tenant, task, { now = Date.now } = {}) {
  let row = journal.get(tenant, task);
  if (!row) return undefined;
  if (row.state === 'sending' && row.until_ms <= now()) {
    row = journal.transition(row, 'uncertain', { reason: 'expired_claim' });
  }
  if (!['uncertain', 'review'].includes(row.state)) return row;
  // A preflight collision existed before our write. Even an exact match is not ours.
  if (row.state === 'review' && !['content_conflict', 'multiple_matches', 'incomplete_evidence'].includes(row.evidence.reason)) return row;
  if (journal.company(tenant) !== row.company) return row;
  let candidates;
  try { candidates = await books.find(row.company, row.reference); }
  catch { return row; } // No new evidence. Keep the previous decision and evidence intact.
  const evidence = compareEvidence(row.snapshot, candidates);
  return journal.transition(row, evidence.state, evidence);
}

// The simulator's saved provider records survive new journal connections in the tests.
// A real connector must scope credentials to the approved company, paginate all results,
// define which refusals guarantee no mutation, and preserve its request ID on safe retries.
export class SimulatedBooks {
  constructor() {
    this.records = new Map();
    this.receipts = new Map();
    this.writeCalls = 0;
    this.fault = null;
  }
  seed(company, document) {
    const saved = { ...structuredClone(document), remoteId: randomUUID() };
    const rows = this.records.get(company) ?? [];
    rows.push(saved);
    this.records.set(company, rows);
    return structuredClone(saved);
  }
  async find(company, reference) {
    return structuredClone((this.records.get(company) ?? []).filter(row => row.reference === reference));
  }
  async create(company, invoice, requestId) {
    this.writeCalls++;
    const fault = this.fault;
    this.fault = null;
    if (fault === 'throttle') throw new RetryBeforeWrite(1000);
    const key = JSON.stringify([company, requestId]);
    if (!this.receipts.has(key)) this.receipts.set(key, this.seed(company, invoice));
    if (fault === 'drop_after_commit') throw new Error('Response lost after provider commit.');
    return structuredClone(this.receipts.get(key));
  }
}

// This selection links exactly one remote record locally. It never edits or voids
// the other invoices in the books. The operator must resolve those with accounting.
export async function settleDuplicate(journal, books, tenant, task, { remoteId, operator, rationale }) {
  const row = journal.get(tenant, task);
  if (row?.state !== 'review' || row.evidence.reason !== 'multiple_matches') {
    throw new Error('A duplicate review is required.');
  }
  const attribution = { operator: cleanText(operator), rationale: cleanText(rationale) };
  if (!row.evidence.candidates.includes(remoteId) || journal.company(tenant) !== row.company) {
    throw new Error('The record is outside the reviewed evidence.');
  }
  const candidates = await books.find(row.company, row.reference);
  if (!inspectCandidates(row.reference, candidates)) throw new Error('Provider evidence is incomplete.');
  const chosen = candidates.find(candidate => candidate.remoteId === remoteId);
  if (!chosen || journal.company(tenant) !== row.company) throw new Error('Selection is no longer available.');
  const verification = compareEvidence(row.snapshot, [chosen]);
  if (verification.state !== 'posted') throw new Error('Selected record differs from the approval.');
  return journal.transition(row, 'posted', { ...verification, reason: 'operator_linked', ...attribution,
    remainingRemoteIds: candidates.filter(item => item.remoteId !== remoteId).map(item => item.remoteId) });
}
