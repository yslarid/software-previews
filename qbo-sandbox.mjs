// Read-only QuickBooks Online sandbox adapter for reconcileInvoice. Node.js 24+.
// https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice
// https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries
import { priceLine } from './dealer-os.mjs';

const origin = 'https://sandbox-quickbooks.api.intuit.com';
const failed = reason => new Error('Unusable sandbox invoice evidence: ' + reason);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value) {
  if (typeof value !== 'string' || !value.trim()) throw failed('missing text field');
  return value;
}

// The query only accepts a small, explicit subset of document-number characters.
// The session's credentials can never be forwarded to an arbitrary host or redirect.
function docNumber(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _./-]{0,20}$/.test(value)) {
    throw failed('unsupported document number');
  }
  return value;
}

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw failed('invalid invoice date');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0,10) !== value) throw failed('invalid invoice date');
  return value;
}

// Preserve JSON numeric tokens before binary floating-point can round them. Accept
// additional trailing zeros, but decline values needing finer precision than the ledger.
class NumericToken {
  constructor(source) { this.source = source; }
}

function scaled(token, places) {
  const source = token instanceof NumericToken ? token.source : undefined;
  if (typeof source !== 'string' || source.length > 40 || !/^-?\d+(\.\d+)?$/.test(source)) {
    throw failed('invalid decimal');
  }
  const [whole, fraction = ''] = source.replace(/^-/, '').split('.');
  if (/[1-9]/.test(fraction.slice(places))) throw failed('unsupported decimal precision');
  const magnitude = BigInt(whole + fraction.slice(0, places).padEnd(places, '0'));
  const value = Number(source.startsWith('-') ? -magnitude : magnitude);
  if (!Number.isSafeInteger(value)) throw failed('amount exceeds safe integer bounds');
  return value;
}

const jsonToken = (_key, value, context) => typeof value === 'number' ? new NumericToken(context.source) : value;

export function qboItemKey(id, description = '') {
  if (typeof description !== 'string') throw failed('invalid item description');
  return JSON.stringify([text(id), description.trim().replace(/\s+/g, ' ')]);
}

function decodeInvoice(raw, reference) {
  if (!isObject(raw) || raw.DocNumber !== reference || raw.sparse === true ||
      raw.CurrencyRef?.value !== 'CAD' || raw.GlobalTaxCalculation !== 'TaxExcluded') {
    throw failed('requires a complete CAD tax-exclusive invoice for the requested reference');
  }
  if (!Array.isArray(raw.Line) || !raw.Line.length) throw failed('missing invoice lines');
  let lineSum = 0n;
  const lines = [];
  for (const [i, line] of raw.Line.entries()) {
    if (!isObject(line)) throw failed('invalid line');
    const amount = scaled(line.Amount, 2);
    if (line.DetailType === 'SubTotalLineDetail' && i === raw.Line.length - 1 && lines.length) {
      if (BigInt(amount) !== lineSum) throw failed('subtotal disagrees with lines');
      continue;
    }
    if (line.DetailType !== 'SalesItemLineDetail') throw failed('unsupported invoice line type');
    const detail = line.SalesItemLineDetail;
    if (!isObject(detail)) throw failed('missing sales item detail');
    const qty = scaled(detail.Qty, 3), rate = scaled(detail.UnitPrice, 2);
    if (qty <= 0 || priceLine(BigInt(qty), BigInt(rate)) !== BigInt(amount)) {
      throw failed('line amount cannot be reproduced from quantity and rate');
    }
    lines.push({item:qboItemKey(detail.ItemRef?.value, line.Description), qty, rate,
      taxCode:text(detail.TaxCodeRef?.value)});
    lineSum += BigInt(amount);
  }
  const tax = scaled(raw.TxnTaxDetail?.TotalTax, 2), total = scaled(raw.TotalAmt, 2);
  if (!Number.isSafeInteger(Number(lineSum)) || lineSum + BigInt(tax) !== BigInt(total)) {
    throw failed('provider total cannot be reproduced');
  }
  return { remoteId:text(raw.Id), reference, customer:text(raw.CustomerRef?.value),
    issueDate:date(raw.TxnDate), currency:'CAD', lines, net:Number(lineSum), tax, total };
}

export function createSandboxEvidenceReader({ realmId, authorize, fetchImpl = fetch, pageSize = 100, maxPages = 20 }) {
  if (typeof realmId !== 'string' || !/^\d{1,32}$/.test(realmId)) throw new TypeError('Numeric sandbox realm ID required.');
  if (typeof authorize !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('Missing auth or fetch function.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
      !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new RangeError('Invalid page limits.');

  return Object.freeze({
    async find(company, reference) {
      if (company !== realmId) throw failed('realm binding mismatch');
      docNumber(reference);
      const session = await authorize(realmId);
      if (session?.realmId !== realmId || typeof session.accessToken !== 'string' ||
          !session.accessToken.length || /\s/.test(session.accessToken)) throw failed('invalid sandbox authorization');
      const invoices = [], seen = new Set();
      let expectedCount;
      for (let index = 0; index < maxPages; index++) {
        const start = 1 + index * pageSize;
        const url = new URL('/v3/company/' + realmId + '/query', origin);
        url.searchParams.set('query', "SELECT * FROM Invoice WHERE DocNumber = '" + reference +
          "' ORDERBY Id STARTPOSITION " + start + ' MAXRESULTS ' + pageSize);
        const response = await fetchImpl(url, {method:'GET', redirect:'error',
          headers:{Accept:'application/json', Authorization:'Bearer ' + session.accessToken},
          signal:AbortSignal.timeout(10000)});
        if (!response.ok) throw failed('HTTP ' + response.status);
        const envelope = JSON.parse(await response.text(), jsonToken);
        const page = envelope?.QueryResponse;
        if (envelope?.Fault || !isObject(page)) throw failed('missing query envelope');
        if (Object.keys(page).some(key => !['Invoice','startPosition','maxResults','totalCount'].includes(key))) {
          throw failed('unexpected query entity');
        }
        const rows = Object.hasOwn(page,'Invoice') ? page.Invoice : [];
        if (!Array.isArray(rows) || rows.length > pageSize) throw failed('invalid page size');
        if (rows.length && (!Object.hasOwn(page,'startPosition') || !Object.hasOwn(page,'maxResults'))) {
          throw failed('missing pagination metadata');
        }
        if (page.startPosition !== undefined && scaled(page.startPosition,0) !== start) throw failed('out-of-order page');
        if (page.maxResults !== undefined && scaled(page.maxResults,0) !== rows.length) throw failed('incomplete page');
        if (page.totalCount !== undefined) {
          const count = scaled(page.totalCount,0);
          if (count < 0 || (expectedCount !== undefined && expectedCount !== count)) throw failed('unstable result count');
          expectedCount = count;
        }
        for (const row of rows) {
          const invoice = decodeInvoice(row, reference);
          if (seen.has(invoice.remoteId)) throw failed('page overlap');
          seen.add(invoice.remoteId);
          invoices.push(invoice);
        }
        if (expectedCount !== undefined && invoices.length > expectedCount) throw failed('row count exceeded');
        if (rows.length < pageSize) {
          if (expectedCount !== undefined && expectedCount !== invoices.length) throw failed('partial response');
          return invoices;
        }
        if (expectedCount !== undefined && invoices.length === expectedCount) return invoices;
      }
      throw failed('page limit reached before end of results');
    }
  });
}
