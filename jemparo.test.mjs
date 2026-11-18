import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionProjection } from './jemparo.mjs';

const account = 'acct_fixture', time = 1800000000, subscription = 'sub_sample';
function fixture(t, {bind = true, file = ':memory:', secret = randomBytes(32)} = {}) {
  const db = new SubscriptionProjection({file, secret, account, clock:() => time});
  t.after(() => db.close());
  const binding = {subscription, workspace:'west', customer:'cus_sample', price:'price_demo'};
  if (bind) db.bind(binding);
  function event(id, status = 'active', created = time) {
    return {id:'evt_' + id, account, livemode:false, type:'customer.subscription.updated', created,
      data:{object:{id:subscription, object:'subscription', customer:'cus_sample', status,
        items:{data:[{price:{id:'price_demo'}, quantity:1}]}}}};
  }
  function request(raw, stamp = time, spacing) {
    const body = Buffer.from(JSON.stringify(raw, null, spacing));
    const mac = createHmac('sha256',secret).update(String(stamp)+'.').update(body).digest('hex');
    return [body,`t=${stamp},v1=${mac}`];
  }
  const post = raw => db.receive(...request(raw));
  return {db, event, request, post, binding, secret};
}

test('a signed test event projects access and atomically emits one downstream notice', t => {
  const {db,post,event} = fixture(t);
  assert.equal(post(event('A')).result,'applied');
  assert.equal(db.accessAt(subscription,time),true);
  assert.equal(db.notices()[0].workspace,'west');
});
test('a redelivery with different JSON whitespace reuses the stored outcome', t => {
  const {db,post,request,event} = fixture(t);
  const e = event('A'); post(e);
  assert.deepEqual(db.receive(...request(e,time,4)),{result:'applied',replay:true});
  assert.equal(db.notices().length,1);
});
test('event ID reuse with a changed business meaning does not change entitlement', t => {
  const {db,post,event} = fixture(t); post(event('same'));
  assert.equal(post(event('same','canceled')).result,'identity-conflict');
  assert.equal(db.accessAt(subscription,time),true);
});
test('revocation wins equal timestamps in either delivery order', t => {
  for (const order of [['active','canceled'],['canceled','active']]) {
    const {db,post,event} = fixture(t);
    for (const value of order) post(event(value,value));
    assert.equal(db.accessAt(subscription,time),false);
    assert.equal(post(event('late','active',time-10)).result,'stale');
  }
});
test('a later failed payment does not extend the first grace window', t => {
  const {db,post,event} = fixture(t);
  post(event('open')); post(event('first','past_due',time+1)); post(event('again','past_due',time+100));
  const cutoff=time+1+7*86400;
  assert.equal(db.snapshot(subscription).grace_until,cutoff);
  assert.equal(db.accessAt(subscription,cutoff-1),true);
  assert.equal(db.accessAt(subscription,cutoff),false);
  post(event('renewed','active',cutoff+1)); assert.equal(db.accessAt(subscription,cutoff+1),true);
});
test('crashing after entitlement and outbox writes rolls both back and releases the event', t => {
  const {db,post,event,request} = fixture(t); const e=event('A');
  assert.throws(()=>db.receive(...request(e),{beforeCommit(){throw new Error('crash')}}),/crash/);
  assert.equal(db.snapshot(subscription),undefined); assert.equal(db.notices().length,0);
  assert.equal(post(e).result,'applied'); assert.equal(db.notices().length,1);
});
test('a missing checkout binding can be installed before retrying the same event', t => {
  const {db,post,event,binding} = fixture(t,{bind:false});
  const e=event('late');assert.equal(post(e).result,'retry-unbound');
  db.bind(binding);assert.equal(post(e).result,'applied');
});
test('trusted binding rejects another customer and the subscription plan must match', t => {
  const {db,post,event} = fixture(t);
  const foreign=event('A'); foreign.data.object.customer='cus_wrong';
  const free=event('B'); free.data.object.items.data[0].price.id='price_other';
  assert.equal(post(foreign).result,'binding-conflict');
  assert.equal(post(free).result,'plan-mismatch');
  assert.equal(db.notices().length,0);
});
test('test-mode envelope, raw-body signature and freshness are checked before projection', t => {
  const {db,event,request} = fixture(t); const e=event('signed');
  const [body,signature]=request(e);
  assert.throws(()=>db.receive(Buffer.concat([body,Buffer.from(' ')]),signature),/signature/i);
  assert.throws(()=>db.receive(...request(e,time-301)),/Expired/);
  assert.throws(()=>db.receive(...request({...e,livemode:true})),/mode mismatch/);
  assert.throws(()=>db.receive(...request({...e,account:'acct_other'})),/Account/);
  assert.equal(db.notices().length,0);
});
test('two worker connections and a restarted reader share one persisted outcome', t => {
  const tmp=mkdtempSync(join(tmpdir(),'entitlement-')); t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const file=join(tmp,'example.sqlite');
  const first=fixture(t,{file}); const second=fixture(t,{file,bind:false,secret:first.secret});
  const event=first.event('A');first.post(event);
  assert.deepEqual(second.post(event),{result:'applied',replay:true});
  assert.equal(second.db.notices().length,1);
  const reader=new SubscriptionProjection({file,account,secret:first.secret});
  try { assert.equal(reader.accessAt(subscription,time),true); } finally { reader.close(); }
});
