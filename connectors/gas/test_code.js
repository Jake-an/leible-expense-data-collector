/**
 * test_code.js — Node-mock unit tests for the GAS hub.
 *
 * Loads Code.gs / square.gs / myers.gs under mocks of the Apps Script globals
 * (SpreadsheetApp, PropertiesService, ContentService) and exercises the pure
 * logic without deploying. Run locally — no clasp, no live Sheet:
 *
 *     node connectors/gas/test_code.js
 *
 * Exit 0 = all pass, exit 1 = a failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * Apps Script global mocks
 * ------------------------------------------------------------------ */

const SUPPLIERS_HEADERS = ['date', 'supplier', 'total', 'invoice_ref', 'location', 'source', 'extracted_at'];
const SALES_HEADERS = ['date', 'location', 'gross_sales', 'source', 'extracted_at'];

function makeSheet(headers) {
  const rows = [headers.slice()];
  const chain = {
    setBackground() { return chain; },
    setFontColor() { return chain; },
    setFontWeight() { return chain; },
  };
  return {
    _rows: rows,
    appendRow: (a) => rows.push(a.slice()),
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    getRange: () => chain,
    setFrozenRows() {},
  };
}

function makeSpreadsheet() {
  const sheets = {
    Suppliers: makeSheet(SUPPLIERS_HEADERS),
    Sales: makeSheet(SALES_HEADERS),
  };
  return {
    _sheets: sheets,
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; },
  };
}

let currentSS = makeSpreadsheet();
let scriptProps = {};

global.SpreadsheetApp = {
  getActiveSpreadsheet: () => currentSS,
  openById: () => currentSS,
};
global.PropertiesService = {
  getScriptProperties: () => ({ getProperty: (k) => (k in scriptProps ? scriptProps[k] : null) }),
};
global.ContentService = {
  createTextOutput: (s) => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } }),
  MimeType: { JSON: 'json' },
};
global.Logger = { log: () => {} };
// Stubs so the connector modules load cleanly (their callers aren't tested here).
global.Utilities = { formatDate: () => '2026-06-17T00:00:00+10:00' };
global.UrlFetchApp = { fetch: () => { throw new Error('UrlFetchApp not mocked'); } };
global.ScriptApp = { getProjectTriggers: () => [] };
global.GmailApp = {};
global.Drive = { Files: { insert: function () { throw new Error('Drive not mocked'); } } };
global.DocumentApp = { openById: function () { throw new Error('DocumentApp not mocked'); } };
global.DriveApp = { getFileById: function () { throw new Error('DriveApp not mocked'); } };

/* ------------------------------------------------------------------ *
 * Load the GAS source into the global scope (indirect eval)
 * ------------------------------------------------------------------ */

const GAS_DIR = __dirname;
function load(file) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(GAS_DIR, file), 'utf8'));
}
load('Code.gs');
load('square.gs');
load('mayers.gs');

/* ------------------------------------------------------------------ *
 * Tiny test harness
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) { passed++; console.log('  ok  - ' + name); }
  else { failed++; console.log('  FAIL- ' + name); }
}
function eq(name, actual, expected) {
  check(name + '  (got ' + JSON.stringify(actual) + ')',
        JSON.stringify(actual) === JSON.stringify(expected));
}
function freshSheets() { currentSS = makeSpreadsheet(); }
function doPostJson(body) {
  const out = doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(out.getContent());
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

console.log('normalizeSupplierRow');
eq('maps columns + resolves canonical supplier from source',
  normalizeSupplierRow({ date: '2026-06-15', total: '245.50', invoice_ref: 'INV-1', location: 'York St' }, 'food_dairy_co', 'TS'),
  ['2026-06-15', 'Food and Dairy Co', 245.5, 'INV-1', 'York St', 'food_dairy_co', 'TS']);
eq('per-row supplier (Ordermentum) wins over the map',
  normalizeSupplierRow({ date: '2026-06-15', total: 80, invoice_ref: 'O-9', supplier: 'Tuga Pastry' }, 'ordermentum', 'TS'),
  ['2026-06-15', 'Tuga Pastry', 80, 'O-9', '', 'ordermentum', 'TS']);
eq('unknown source falls back to the raw source name',
  normalizeSupplierRow({ date: '2026-06-15', total: 10, invoice_ref: 'X' }, 'mystery', 'TS')[1],
  'mystery');

console.log('ingestSupplierRows dedup (source + invoice_ref)');
freshSheets();
(function () {
  const sheet = ensureSheet(currentSS, 'Suppliers', SUPPLIERS_HEADERS);
  const batch = [
    { date: '2026-06-15', total: 100, invoice_ref: 'A1' },
    { date: '2026-06-15', total: 200, invoice_ref: 'A2' },
    { date: '2026-06-16', total: 999, invoice_ref: 'A1' }, // dup key A1 within batch
  ];
  const r1 = ingestSupplierRows('kent_paper', batch, 'TS', sheet);
  eq('batch of 3 with 1 dup → 2 added, 1 skipped', r1, { rowsAdded: 2, duplicatesSkipped: 1 });
  const r2 = ingestSupplierRows('kent_paper', batch, 'TS', sheet);
  eq('re-ingest same batch → 0 added (all dup vs sheet)', r2, { rowsAdded: 0, duplicatesSkipped: 3 });
})();

console.log('doPost');
freshSheets();
eq('happy path → ok, rowsAdded 2',
  doPostJson({ source: 'food_dairy_co', extracted_at: 'TS', rows: [
    { date: '2026-06-15', total: 50, invoice_ref: 'B1' },
    { date: '2026-06-15', total: 60, invoice_ref: 'B2' },
  ] }),
  { result: 'ok', rowsAdded: 2, duplicatesSkipped: 0 });

freshSheets();
eq('batch with duplicate invoice_ref → 1 added, 1 skipped',
  doPostJson({ source: 'food_dairy_co', extracted_at: 'TS', rows: [
    { date: '2026-06-15', total: 50, invoice_ref: 'C1' },
    { date: '2026-06-99', total: 77, invoice_ref: 'C1' },
  ] }),
  { result: 'ok', rowsAdded: 1, duplicatesSkipped: 1 });

freshSheets();
check('missing total → result error',
  doPostJson({ source: 'food_dairy_co', extracted_at: 'TS', rows: [{ date: '2026-06-15', invoice_ref: 'D1' }] }).result === 'error');

freshSheets();
check('missing source → result error',
  doPostJson({ extracted_at: 'TS', rows: [] }).result === 'error');

freshSheets();
(function () {
  const res = doPostJson({ source: 'mystery_co', extracted_at: 'TS', rows: [{ date: '2026-06-15', total: 5, invoice_ref: 'E1' }] });
  eq('unknown source still ingests (ok, 1 added)', res, { result: 'ok', rowsAdded: 1, duplicatesSkipped: 0 });
  const data = currentSS.getSheetByName('Suppliers').getDataRange().getValues();
  eq('unknown-source supplier defaults to raw source', data[1][1], 'mystery_co');
})();

console.log('squareSumOrderGross_');
eq('sums total_money.amount (cents) → dollars, ignores malformed',
  squareSumOrderGross_([
    { total_money: { amount: 1050 } },
    { total_money: { amount: 295 } },
    {},
    { total_money: { amount: 5 } },
  ]),
  13.5);
eq('empty → 0', squareSumOrderGross_([]), 0);

console.log('parseMayersInvoice_');
var mayersFixture = [
  'F.Mayer Imports Pty Ltd TAX INVOICE',
  'Invoice No: 3429816',
  'Invoice Date: 17-JUN-26',
  'Bill To: LEIBLE COFFEE',
  'Ordere Picked Item Code Item Description Shipped Qty Unit Price Disc CD Net Price Line Total',
  '1 1CTN 8232BU76 CAL MILK CALLET 33.6% 8X2.5KG 1.00 CTN 890.89 21.00% 0.00 703.80 703.80',
  '1 1CTN #SP250 SANPEL 24X250ML 1.00 CTN 29.94 12.00% 3.60 29.95 29.95',
  'Pay Ref: 3429816',
  'Ex Tax: 733.75',
  'GST 2.99',
  'Total: 736.74'
].join('\n');
eq('parses real Mayers invoice — ref, date (DD-MMM-YY), total',
  parseMayersInvoice_(mayersFixture, '2026-06-17'),
  { date: '2026-06-17', total: 736.74, invoice_ref: '3429816' });
eq('does not grab Ex Tax or Line Total as the total',
  parseMayersInvoice_(mayersFixture, '2026-06-17').total, 736.74);
eq('does not grab Pay Ref as the invoice ref',
  parseMayersInvoice_(mayersFixture, '2026-06-17').invoice_ref, '3429816');
check('falls back to received date when no date in text',
  parseMayersInvoice_('Invoice No: 9999999\nTotal: 50.00', '2026-06-17').date === '2026-06-17');
check('returns null when no total/ref found',
  parseMayersInvoice_('Hello, just a friendly note', '2026-06-17') === null);

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
