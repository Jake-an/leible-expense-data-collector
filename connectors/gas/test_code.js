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
    setValue() { return chain; },
  };
  return {
    _rows: rows,
    appendRow: (a) => rows.push(a.slice()),
    deleteRow: (rowNum) => rows.splice(rowNum - 1, 1),
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
global.ScriptApp = {
  getProjectTriggers: () => [],
  newTrigger: () => ({ timeBased: () => ({ onWeekDay: () => ({ atHour: () => ({ inTimezone: () => ({ create: () => {} }) }) }), everyDays: () => ({ inTimezone: () => ({ create: () => {} }) }), atHour: () => ({ everyDays: () => ({ inTimezone: () => ({ create: () => {} }) }) }) }) }),
  deleteTrigger: () => {},
  WeekDay: { MONDAY: 2 }
};
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
  'Bill To :',
  'LEIBLE COFFEE',
  'KAFFAPRO PTY LTD',
  '89 YORK ST',
  'LEIBLE COFFEE, GROUND LEVEL',
  'SYDNEY',
  'NSW              2000',
  'Deliver To:',
  'LEIBLE COFFEE',
  '89 YORK ST',
  'LEIBLE COFFEE, GROUND LEVEL',
  'SYDNEY',
  'NSW                 2000',
  'Account:                    LEI05D',
  'Ordere Picked Item Code Item Description Shipped Qty Unit Price Disc CD Net Price Line Total',
  '1 1CTN 8232BU76 CAL MILK CALLET 33.6% 8X2.5KG 1.00 CTN 890.89 21.00% 0.00 703.80 703.80',
  '1 1CTN #SP250 SANPEL 24X250ML 1.00 CTN 29.94 12.00% 3.60 29.95 29.95',
  'Pay Ref: 3429816',
  'Ex Tax: 733.75',
  'GST 2.99',
  'Total: 736.74'
].join('\n');
eq('parses real Mayers invoice — ref, date, total, location',
  parseMayersInvoice_(mayersFixture, '2026-06-17'),
  { date: '2026-06-17', total: 736.74, invoice_ref: '3429816', location: 'Leible York' });
eq('does not grab Ex Tax or Line Total as the total',
  parseMayersInvoice_(mayersFixture, '2026-06-17').total, 736.74);
eq('does not grab Pay Ref as the invoice ref',
  parseMayersInvoice_(mayersFixture, '2026-06-17').invoice_ref, '3429816');
check('falls back to received date when no date in text',
  parseMayersInvoice_('Invoice No: 9999999\nTotal: 50.00', '2026-06-17').date === '2026-06-17');
check('returns null when no total/ref found',
  parseMayersInvoice_('Hello, just a friendly note', '2026-06-17') === null);

console.log('mayersShopFromText_');
eq('York St → Leible York', mayersShopFromText_('Deliver To:\n89 YORK ST\nSYDNEY'), 'Leible York');
eq('Pitt St → Leible Pitt', mayersShopFromText_('130 PITT ST\nSYDNEY NSW 2000'), 'Leible Pitt');
eq('Blue St → Leible North', mayersShopFromText_('BLUE ST\nNORTH SYDNEY NSW 2060'), 'Leible North');
eq('Burlington → Leible Crowsnest', mayersShopFromText_('4 BURLINGTON ST\nCROWS NEST'), 'Leible Crowsnest');
eq('Crows Nest keyword → Leible Crowsnest', mayersShopFromText_('CROWS NEST NSW 2065'), 'Leible Crowsnest');
check('unknown address → UNMAPPED prefix',
  mayersShopFromText_('Deliver To:\n99 GEORGE ST\nSYDNEY').indexOf('UNMAPPED:') === 0);
eq('no address at all → empty string', mayersShopFromText_('just some random text'), '');

/* ------------------------------------------------------------------ *
 * Summary API tests
 * ------------------------------------------------------------------ */

console.log('coerceDateStr_');
eq('string passes through', coerceDateStr_('2026-06-15'), '2026-06-15');
(function () {
  // Date object built from local components → same Y-M-D back (no UTC shift)
  var d = new Date(2026, 5, 15, 0, 0, 0); // local midnight Jun 15 (month is 0-based)
  eq('Date object → local YYYY-MM-DD (no off-by-one)', coerceDateStr_(d), '2026-06-15');
})();

console.log('aggregateSupplierRows_ with Date-object dates');
(function () {
  var rows = [
    [new Date(2026, 5, 16, 0, 0, 0), 'Food and Dairy Co', 100, 'FDC-1', 'York St', 'food_dairy_co', 'TS'],
    [new Date(2026, 5, 17, 0, 0, 0), 'Food and Dairy Co', 200, 'FDC-2', 'York St', 'food_dairy_co', 'TS'],
  ];
  var result = aggregateSupplierRows_(rows, '2026-06-15', '2026-06-21');
  eq('Date-object rows aggregate into the week', result.length, 1);
  eq('Date-object rows summed', result[0].total_spend, 300);
})();

console.log('weekStartForDate_');
eq('Monday returns itself', weekStartForDate_('2026-06-22'), '2026-06-22');
eq('Wednesday returns Monday', weekStartForDate_('2026-06-24'), '2026-06-22');
eq('Sunday returns previous Monday', weekStartForDate_('2026-06-28'), '2026-06-22');
eq('Saturday returns Monday', weekStartForDate_('2026-06-27'), '2026-06-22');
eq('Tuesday returns Monday', weekStartForDate_('2026-06-23'), '2026-06-22');

console.log('getLastCompletedWeek_');
(function () {
  // On Monday 2026-06-22, last completed week = Mon Jun 15 → Sun Jun 21
  var w = getLastCompletedWeek_('2026-06-22');
  eq('Monday: last week start', w.start, '2026-06-15');
  eq('Monday: last week end', w.end, '2026-06-21');
  // On Wednesday 2026-06-24
  var w2 = getLastCompletedWeek_('2026-06-24');
  eq('Wednesday: last week start', w2.start, '2026-06-15');
  eq('Wednesday: last week end', w2.end, '2026-06-21');
  // On Sunday 2026-06-28 (end of current week)
  var w3 = getLastCompletedWeek_('2026-06-28');
  eq('Sunday: last week start', w3.start, '2026-06-15');
  eq('Sunday: last week end', w3.end, '2026-06-21');
})();

console.log('aggregateSupplierRows_');
(function () {
  var rows = [
    // [date, supplier, total, invoice_ref, location, source, extracted_at]
    ['2026-06-16', 'Food and Dairy Co', 100, 'FDC-1', 'York St', 'food_dairy_co', 'TS'],
    ['2026-06-17', 'Food and Dairy Co', 200, 'FDC-2', 'York St', 'food_dairy_co', 'TS'],
    ['2026-06-16', 'Food and Dairy Co', 50,  'FDC-3', 'North',   'food_dairy_co', 'TS'],
    ['2026-06-18', 'Butterboy',         80,  'BB-1',  'York St', 'ordermentum',   'TS'],
    ['2026-06-10', 'Food and Dairy Co', 999, 'FDC-0', 'York St', 'food_dairy_co', 'TS'], // outside week
    ['2026-06-25', 'Food and Dairy Co', 888, 'FDC-9', 'York St', 'food_dairy_co', 'TS'], // outside week
  ];
  var result = aggregateSupplierRows_(rows, '2026-06-15', '2026-06-21');
  eq('groups into 3 buckets (FDC-York, FDC-North, Butterboy-York)', result.length, 3);

  // Sorted by key: Butterboy||York St, Food and Dairy Co||North, Food and Dairy Co||York St
  eq('Butterboy York total', result[0].total_spend, 80);
  eq('Butterboy York supplier', result[0].supplier, 'Butterboy');
  eq('FDC North total', result[1].total_spend, 50);
  eq('FDC York total (100+200)', result[2].total_spend, 300);

  var empty = aggregateSupplierRows_([], '2026-06-15', '2026-06-21');
  eq('empty rows → empty result', empty.length, 0);
})();

console.log('checkReadToken_');
(function () {
  // No token in Script Properties → deny
  scriptProps = {};
  check('no stored token → unauthorized', checkReadToken_({ token: 'abc' }).ok === false);

  // Stored token but caller sends nothing
  scriptProps = { API_READ_TOKEN: 'secret123' };
  check('no caller token → unauthorized', checkReadToken_({}).ok === false);
  check('empty caller token → unauthorized', checkReadToken_({ token: '' }).ok === false);

  // Wrong token
  check('wrong token → unauthorized', checkReadToken_({ token: 'wrong' }).ok === false);

  // Correct token
  check('correct token → ok', checkReadToken_({ token: 'secret123' }).ok === true);
})();

console.log('summaryDataToObjects_');
(function () {
  var data = [
    ['week_start', 'week_end', 'supplier', 'location', 'total_spend', 'summarized_at'],
    ['2026-06-15', '2026-06-21', 'Food and Dairy Co', 'York St', 300, '2026-06-22T04:00:00+10:00'],
    ['2026-06-15', '2026-06-21', 'Butterboy', 'York St', 80, '2026-06-22T04:00:00+10:00'],
  ];
  var objs = summaryDataToObjects_(data);
  eq('returns 2 objects', objs.length, 2);
  eq('first obj supplier', objs[0].supplier, 'Food and Dairy Co');
  eq('first obj total_spend', objs[0].total_spend, 300);
  eq('second obj week_start', objs[1].week_start, '2026-06-15');
})();

console.log('filterSummaryByDateRange_');
(function () {
  var rows = [
    { week_start: '2026-06-08', supplier: 'A', total_spend: 10 },
    { week_start: '2026-06-15', supplier: 'B', total_spend: 20 },
    { week_start: '2026-06-22', supplier: 'C', total_spend: 30 },
  ];
  eq('from filter', filterSummaryByDateRange_(rows, '2026-06-15', null).length, 2);
  eq('to filter', filterSummaryByDateRange_(rows, null, '2026-06-15').length, 2);
  eq('from+to filter', filterSummaryByDateRange_(rows, '2026-06-15', '2026-06-15').length, 1);
  eq('no filter', filterSummaryByDateRange_(rows, null, null).length, 3);
})();

console.log('archiveAndPurge_');
(function () {
  var source = makeSheet(SUPPLIERS_HEADERS);
  var archive = makeSheet(SUPPLIERS_HEADERS);
  // Add rows: 2 old, 1 recent
  source.appendRow(['2026-01-01', 'Old Co', 50, 'OLD-1', '', 'test', 'TS']);
  source.appendRow(['2026-01-15', 'Old Co', 60, 'OLD-2', '', 'test', 'TS']);
  source.appendRow(['2026-06-15', 'Recent Co', 100, 'NEW-1', '', 'test', 'TS']);

  var count = archiveAndPurge_(source, archive, '2026-03-01');
  eq('archived 2 old rows', count, 2);
  eq('source has header + 1 recent row', source._rows.length, 2);
  eq('source remaining row is recent', source._rows[1][0], '2026-06-15');
  eq('archive has header + 2 archived rows', archive._rows.length, 3);
  eq('archive first row date (bottom-up order)', archive._rows[1][0], '2026-01-15');
})();

console.log('doGet (integration)');
freshSheets();
(function () {
  // Setup: create Summary tab with data
  var summSheet = makeSheet(['week_start', 'week_end', 'supplier', 'location', 'total_spend', 'summarized_at']);
  summSheet.appendRow(['2026-06-15', '2026-06-21', 'Food and Dairy Co', 'York St', 300, 'TS']);
  summSheet.appendRow(['2026-06-15', '2026-06-21', 'Butterboy', 'York St', 80, 'TS']);
  summSheet.appendRow(['2026-06-08', '2026-06-14', 'Food and Dairy Co', 'York St', 250, 'TS']);
  currentSS._sheets['Summary'] = summSheet;

  // No token → error
  scriptProps = {};
  var r1 = JSON.parse(doGet({ parameter: { token: 'abc' } }).getContent());
  eq('no stored token → error', r1.result, 'error');

  // Wrong token → error
  scriptProps = { API_READ_TOKEN: 'secret123' };
  var r2 = JSON.parse(doGet({ parameter: { token: 'wrong' } }).getContent());
  eq('wrong token → error', r2.result, 'error');

  // Valid token, explicit date range
  var r3 = JSON.parse(doGet({ parameter: { token: 'secret123', from: '2026-06-15', to: '2026-06-21' } }).getContent());
  eq('valid token + date range → ok', r3.result, 'ok');
  eq('returns 2 rows for week Jun 15', r3.count, 2);
  eq('first row supplier', r3.rows[0].supplier, 'Food and Dairy Co');

  // Valid token, wider range → all 3 rows
  var r4 = JSON.parse(doGet({ parameter: { token: 'secret123', from: '2026-06-01', to: '2026-06-30' } }).getContent());
  eq('wider range → 3 rows', r4.count, 3);
})();

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
