// All HTTP responses, realm IDs, tokens and invoice identifiers here are fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxEvidenceReader, qboItemKey } from './qbo-sandbox.mjs';
import { InvoiceJournal, compareEvidence, reconcileInvoice } from './dealer-os.mjs';

const realmId = '12345000', reference = 'DEMO-314';
const session = { realmId, accessToken:'fictional-fixture' };
const raw = () => ({Id:'52', DocNumber:reference, TxnDate:'2026-06-12',
  CustomerRef:{value:'fixture-customer'}, CurrencyRef:{value:'CAD'}, GlobalTaxCalculation:'TaxExcluded',
  Line:[{DetailType:'SalesItemLineDetail', Description:'  First   visit  ', Amount:29.99,
    SalesItemLineDetail:{Qty:1.5, UnitPrice:19.99, ItemRef:{value:'fixture-crew'}, TaxCodeRef:{value:'H'}}},
    {DetailType:'SubTotalLineDetail', Amount:29.99, SubTotalLineDetail:{}}],
  TxnTaxDetail:{TotalTax:3.90}, TotalAmt:33.89});

function page(invoices, start = 1, extra = {}) {
  return {QueryResponse:{Invoice:invoices, startPosition:start, maxResults:invoices.length, ...extra}};
}
function fixture(responses, options = {}) {
  const requests = [];
  const reader = createSandboxEvidenceReader({realmId, authorize:async () => session, ...options,
    fetchImpl:async (url, init) => {
      requests.push({url,init});
      const body = responses.shift();
      if (body instanceof Response) return body;
      return new Response(typeof body === 'string' ? body : JSON.stringify(body),
        {status:200,headers:{'content-type':'application/json'}});
    }
  });
  return {reader,requests};
}

test('only a GET to the bound sandbox realm is allowed, and empty lookup evidence is meaningful', async () => {
  const {reader,requests} = fixture([{QueryResponse:{}}]);
  const actual = await reader.find(realmId,reference);
  assert.deepEqual(actual,[]);
  assert.equal(reader.create,undefined);
  const [{url,init}] = requests;
  assert.equal(url.origin,'https://sandbox-quickbooks.api.intuit.com');
  assert.equal(url.pathname,'/v3/company/12345000/query');
  assert.equal(url.searchParams.get('query'),"SELECT * FROM Invoice WHERE DocNumber = 'DEMO-314' ORDERBY Id STARTPOSITION 1 MAXRESULTS 100");
  assert.equal(init.method,'GET');
  assert.equal(init.redirect,'error');
  assert.equal(init.headers.Authorization,'Bearer fictional-fixture');
});

test('rejects mismatched OAuth realm, unsafe input and invalid config before any network activity', async () => {
  const {reader,requests} = fixture([],{authorize:async () => ({...session,realmId:'different'})});
  await assert.rejects(reader.find('another',reference),/realm binding/);
  await assert.rejects(reader.find(realmId,"X' OR Id=1"),/document number/);
  await assert.rejects(reader.find(realmId,reference),/authorization/);
  assert.equal(requests.length,0);
  assert.throws(() => createSandboxEvidenceReader({realmId:'https://example.invalid',authorize:()=>session}),/realm/);
});

test('collects every page and converts line and provider amounts without floating-point rounding', async () => {
  const second = {...raw(),Id:'53'};
  const {reader,requests} = fixture([page([raw()]),page([second],2),{QueryResponse:{}}],{pageSize:1});
  const rows = await reader.find(realmId,reference);
  assert.deepEqual(rows.map(r=>r.remoteId),['52','53']);
  assert.equal(requests.length,3);
  assert.match(requests[1].url.searchParams.get('query'),/STARTPOSITION 2/);
  assert.deepEqual(rows[0].lines,[{item:qboItemKey('fixture-crew','First visit'),qty:1500,rate:1999,taxCode:'H'}]);
  assert.deepEqual([rows[0].net,rows[0].tax,rows[0].total],[2999,390,3389]);
  assert.equal(compareEvidence(rows[0],rows).reason,'multiple_matches');
});

test('recovery reads the sandbox after a lost claim and links a single full-identity match', async t => {
  const {reader,requests} = fixture([page([raw()])]);
  const journal = new InvoiceJournal();
  t.after(()=>journal.close());
  journal.bind('dealer',realmId);
  journal.propose('dealer','op',{reference,customer:'fixture-customer',issueDate:'2026-06-12',currency:'CAD',
    lines:[{item:qboItemKey('fixture-crew','First visit'),qty:1500,rate:1999,taxCode:'H'}],tax:390});
  journal.approve('dealer','op','fixture-operator');
  journal.claim('dealer','op',0,10);
  const result = await reconcileInvoice(journal,reader,'dealer','op',{now:()=>11});
  assert.equal(result.state,'posted');
  assert.equal(result.evidence.remoteId,'52');
  assert.deepEqual(result.evidence.differences,[]);
  assert.equal(requests.length,1);
  assert.equal(requests[0].init.method,'GET');
});

test('partial pages, duplicate IDs, foreign entities and exhausted budgets cannot prove a match', async () => {
  const samples = [
    [[page([raw()]),page([raw()],2)],'overlap'],
    [[page([raw()]),page([],3)],'out-of-order'],
    [[page([raw()]),page([],2,{totalCount:2})],'partial'],
    [[page([raw()],1,{totalCount:2}),page([],2,{totalCount:3})],'unstable'],
    [[{QueryResponse:{Customer:[]}}],'unexpected'],
    [[{QueryResponse:{Invoice:[raw()]}}],'pagination'],
    [[{Fault:{type:'fixture'}}],'envelope'],
    [[new Response('rate-limited',{status:429})],'HTTP 429']
  ];
  for (const [responses,reason] of samples) {
    const {reader} = fixture(responses,{pageSize:1});
    await assert.rejects(reader.find(realmId,reference),new RegExp(reason));
  }
  const {reader} = fixture([page([raw()])],{pageSize:1,maxPages:1});
  await assert.rejects(reader.find(realmId,reference),/page limit/);
});

test('rejects unsupported accounting shapes, malformed evidence and unsupported numeric precision', async () => {
  const changes = [
    r=>{r.Line[0].DetailType='DiscountLineDetail'}, r=>{r.GlobalTaxCalculation='TaxInclusive'},
    r=>{r.Line[1].Amount=30}, r=>{r.Line[0].Amount=30}, r=>{r.TotalAmt=32}, r=>{r.CurrencyRef.value='USD'},
    r=>{r.Line[0].SalesItemLineDetail.Qty=1.5002}, r=>{r.Line[0].SalesItemLineDetail.UnitPrice=19.999},
    r=>{r.TxnDate='2026-02-31'}, r=>{r.Id=52}, r=>{delete r.TxnTaxDetail}, r=>{r.sparse=true},
    r=>{r.DocNumber='OTHER'}
  ];
  for (const change of changes) {
    const invoice = raw();change(invoice);
    await assert.rejects(fixture([page([invoice])]).reader.find(realmId,reference),/evidence/);
  }
  // IEEE 754 would otherwise silently parse these two unit prices as the same number.
  const wire = JSON.stringify(page([raw()])).replace('"UnitPrice":19.99','"UnitPrice":19.9900000000000000001');
  await assert.rejects(fixture([wire]).reader.find(realmId,reference),/precision/);
});
