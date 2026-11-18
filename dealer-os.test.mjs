import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvoiceJournal, SimulatedBooks, compareEvidence, dispatchInvoice, reconcileInvoice,
  settleDuplicate, priceLine, subtotal } from './dealer-os.mjs';

const dealer = 'north', realm = 'books-north', task = 'approval:119';
const draft = { reference: 'N-119', customer: 'Sample Deck Co.', issueDate: '2026-06-12', currency: 'CAD',
  lines: [{ item: 'Crew hours', qty: 1500, rate: 1999, taxCode: 'H' }], tax: 390 };

function setup(t, { approved = true, durable = false } = {}) {
  let path = ':memory:';
  if (durable) {
    const dir = mkdtempSync(join(tmpdir(), 'invoice-ledger-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    path = join(dir, 'demo.sqlite');
  }
  const journal = new InvoiceJournal(path);
  t.after(() => { if (journal.db.isOpen) journal.close(); });
  journal.bind(dealer, realm);
  const row = journal.propose(dealer, task, draft);
  if (approved) journal.approve(dealer, task, 'sample-operator');
  const books = new SimulatedBooks();
  return { journal, books, row, path };
}

function gate() {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  return { wait, release };
}

test('snapshot computes display-rounded cents, including the exact inverse for a credit', t => {
  const {row} = setup(t);
  assert.equal(row.snapshot.net, 2999);
  assert.equal(row.snapshot.total, 3389);
  assert.equal(priceLine(1500n, -1999n), -2999n);
  assert.equal(subtotal([{quantityThousandths: 500n, unitPriceCents: 1n},
    {quantityThousandths: 500n, unitPriceCents: 1n}]), 2n);
  assert.throws(() => priceLine(1.5, 1999n), TypeError);
});

test('repeated proposals share a request ID, while altered terms and reused numbers are rejected', t => {
  const {journal, row} = setup(t);
  assert.equal(journal.propose(dealer, task, draft).request_id, row.request_id);
  assert.throws(() => journal.propose(dealer, task, {...draft, tax: 77}), /different approval/);
  assert.throws(() => journal.propose(dealer, 'another-job', draft), /UNIQUE/);
  assert.equal(journal.history(dealer, task).length, 2);
});

test('unapproved proposals never reach the remote provider', async t => {
  const {journal, books} = setup(t, {approved:false});
  assert.equal((await dispatchInvoice(journal, books, dealer, task)).state, 'draft');
  assert.equal(books.writeCalls, 0);
});

test('two connections racing while the provider awaits I/O have one claim and one write', async t => {
  const {journal, books, path} = setup(t, {durable:true});
  const second = new InvoiceJournal(path);
  t.after(() => second.close());
  const entered = gate(), resume = gate();
  const write = books.create.bind(books);
  books.create = async (...args) => { entered.release(); await resume.wait; return write(...args); };
  const first = dispatchInvoice(journal, books, dealer, task);
  await entered.wait;
  assert.equal((await dispatchInvoice(second, books, dealer, task)).state, 'sending');
  resume.release();
  assert.equal((await first).state, 'posted');
  assert.equal(books.writeCalls, 1);
  assert.deepEqual(second.history(dealer, task).map(row => row.state), ['draft','approved','sending','posted']);
});

test('a lost acknowledgement survives journal reopen and reconciles by read only', async t => {
  const {journal, books, path} = setup(t, {durable:true});
  books.fault = 'drop_after_commit';
  assert.equal((await dispatchInvoice(journal, books, dealer, task)).state, 'uncertain');
  journal.close();
  const reopened = new InvoiceJournal(path);
  t.after(() => reopened.close());
  const recovered = await reconcileInvoice(reopened, books, dealer, task);
  assert.equal(recovered.state, 'posted');
  assert.equal(recovered.evidence.remoteId, (await books.find(realm, draft.reference))[0].remoteId);
  await dispatchInvoice(reopened, books, dealer, task);
  assert.equal(books.writeCalls, 1);
});

test('a missing provider record remains uncertain through repeated dispatch and lookup attempts', async t => {
  const {journal, books} = setup(t);
  journal.claim(dealer, task, 0, 10); // worker crash after claiming; outbound outcome is unknowable
  for (let i = 0; i < 3; i++) {
    assert.equal((await reconcileInvoice(journal, books, dealer, task, {now:()=>11})).state, 'uncertain');
    assert.equal((await dispatchInvoice(journal, books, dealer, task, {now:()=>99})).state, 'uncertain');
  }
  assert.equal(books.writeCalls, 0);
});

test('only a confirmed pre-write refusal reopens dispatch after the required delay', async t => {
  const {journal, books, row} = setup(t);
  books.fault = 'throttle';
  const options = n => ({now: () => n});
  assert.equal((await dispatchInvoice(journal, books, dealer, task, options(0))).state, 'retryable');
  assert.equal((await dispatchInvoice(journal, books, dealer, task, options(999))).state, 'retryable');
  assert.equal(books.writeCalls, 1);
  const posted = await dispatchInvoice(journal, books, dealer, task, options(1000));
  assert.equal(posted.request_id, row.request_id);
  assert.equal(posted.state, 'posted');
  assert.equal((await books.find(realm, draft.reference)).length, 1);
});

test('a matching reference present before the first write cannot be adopted by recovery', async t => {
  const {journal, books, row} = setup(t);
  books.seed(realm, row.snapshot);
  assert.equal((await dispatchInvoice(journal, books, dealer, task)).evidence.reason, 'reference_already_used');
  assert.equal((await reconcileInvoice(journal, books, dealer, task)).state, 'review');
  assert.equal(books.writeCalls, 0);
});

test('a rebound connection and another dealer cannot execute or observe this approval', async t => {
  const {journal, books} = setup(t);
  journal.bind(dealer, 'new-company');
  assert.equal((await dispatchInvoice(journal, books, dealer, task)).evidence.reason, 'company_binding_changed');
  assert.equal(await dispatchInvoice(journal, books, 'south', task), undefined);
  assert.deepEqual(journal.history('south', task), []);
  assert.equal(books.writeCalls, 0);
});

test('scope is checked again after an asynchronous provider preflight', async t => {
  const {journal, books} = setup(t);
  books.find = async () => { journal.bind(dealer, 'new-company'); return []; };
  assert.equal((await dispatchInvoice(journal, books, dealer, task)).evidence.reason, 'company_binding_changed');
  assert.equal(books.writeCalls, 0);
});

test('provider tax differences are recorded without mutating approved amounts', t => {
  const {row} = setup(t), approved = row.snapshot;
  const evidence = compareEvidence(approved, [{...approved, remoteId:'p1', tax:391, total:3390}]);
  assert.equal(evidence.state, 'posted');
  assert.deepEqual(evidence.differences, [{field:'tax', approved:390, provider:391},
    {field:'total', approved:3389, provider:3390}]);
  assert.equal(approved.total, 3389);
});

test('same amount from a different customer is a content conflict', async t => {
  const {journal, books, row} = setup(t);
  journal.claim(dealer, task, 1, 1);
  books.seed(realm, {...row.snapshot, customer:'Other customer'});
  const result = await reconcileInvoice(journal, books, dealer, task, {now:()=>10});
  assert.equal(result.state, 'review');
  assert.equal(result.evidence.reason, 'content_conflict');
  assert.equal(books.writeCalls, 0);
});

test('duplicate exact records need explicit reviewed selection; both remote records survive', async t => {
  const {journal, books, row} = setup(t);
  journal.claim(dealer, task, 1, 1);
  const first = books.seed(realm, row.snapshot), other = books.seed(realm, row.snapshot);
  const reviewed = await reconcileInvoice(journal, books, dealer, task, {now:()=>10});
  assert.equal(reviewed.evidence.reason, 'multiple_matches');
  const explanation = {operator:'sample-bookkeeper',rationale:'Verified against payment reference.'};
  await assert.rejects(settleDuplicate(journal,books,dealer,task,{...explanation,remoteId:'unreviewed'}), /outside/);
  const chosen = await settleDuplicate(journal,books,dealer,task,{...explanation,remoteId:first.remoteId});
  assert.equal(chosen.evidence.remoteId, first.remoteId);
  assert.deepEqual(chosen.evidence.remainingRemoteIds, [other.remoteId]);
  assert.equal(chosen.evidence.operator, explanation.operator);
  assert.equal((await books.find(realm, draft.reference)).length, 2);
  assert.equal(books.writeCalls, 0);
});

test('a late worker response cannot replace the result of recovery', async t => {
  const {journal, books} = setup(t);
  const entered = gate(), resume = gate();
  const write = books.create.bind(books);
  books.create = async (...args) => {
    const receipt = await write(...args);
    entered.release(); await resume.wait; return receipt;
  };
  let now = 0;
  const options = {now:()=>now, leaseMs:10};
  const first = dispatchInvoice(journal, books, dealer, task, options);
  await entered.wait;
  now = 11;
  const recovered = await reconcileInvoice(journal, books, dealer, task, options);
  resume.release();
  const stale = await first;
  assert.equal(recovered.state,'posted');
  assert.equal(stale.version, recovered.version);
  assert.equal(journal.history(dealer,task).filter(e => e.state === 'posted').length,1);
});

test('an incomplete or corrupt candidate blocks linking even when another row is an exact match', t => {
  const {row} = setup(t);
  const match = {...row.snapshot, remoteId:'remote-1'};
  const unreadable = [
    {...match, remoteId:undefined}, {...match, remoteId:' '}, {...match, remoteId:'remote-2', tax:undefined},
    {...match, remoteId:'remote-2', total:3}, {...match, remoteId:'remote-2', lines:[]},
    {...match, remoteId:'remote-2', reference:'unexpected'}, {...match}, null
  ];
  for (const bad of unreadable) {
    assert.deepEqual(compareEvidence(row.snapshot, [match,bad]), {state:'review',reason:'incomplete_evidence'});
  }
  assert.deepEqual(compareEvidence(row.snapshot, null), {state:'review',reason:'incomplete_evidence'});
});

test('a malformed provider lookup cannot authorize a first write or recovery adoption', async t => {
  const {journal, books, row} = setup(t);
  books.find = async () => ({ invoice: row.snapshot });
  const result = await dispatchInvoice(journal, books, dealer, task);
  assert.equal(result.evidence.reason, 'preflight_incomplete');
  await reconcileInvoice(journal, books, dealer, task);
  assert.equal(books.writeCalls, 0);
});

test('a partial create receipt can resolve through a later complete provider lookup without resending', async t => {
  const {journal, books} = setup(t);
  const create = books.create.bind(books);
  books.create = async (...args) => ({...await create(...args), remoteId:null});
  const review = await dispatchInvoice(journal, books, dealer, task);
  assert.equal(review.evidence.reason,'incomplete_evidence');
  assert.equal((await reconcileInvoice(journal, books, dealer, task)).state, 'posted');
  assert.equal(books.writeCalls,1);
});
