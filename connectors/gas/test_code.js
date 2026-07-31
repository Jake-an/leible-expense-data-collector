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

// SUPPLIERS_HEADERS / SALES_HEADERS are NOT declared here. Declaring local
// copies would shadow the globals load('Code.gs') sets below, and the two
// would silently diverge the moment a header changes in one but not the
// other. They are read off globalThis after load('Code.gs') instead, so the
// tests always exercise the actual production header arrays.

// A real Sheet parses a bare 'yyyy-MM-dd' string on write and hands it back as a
// Date. It does NOT parse an ISO datetime carrying a timezone offset
// ('2026-06-25T10:32:24+10:00'), which stays text — the live _archive tab shows
// exactly this split: date cells render as 16/11/2025, extracted_at keeps its
// +10:00. Modelling only the bare-date case mirrors production.
//
// This is load-bearing, not cosmetic: storing dates as the strings they were
// written as makes String(cell) round-trip cleanly in tests while the same
// expression yields 'Mon Jun 15 2026 00:00:00 GMT+1000...' against a real Sheet.
// A mock without this cannot fail on a missing coerceDateStr_(), which is how
// the weeklySummarize dedup shipped broken under a green suite.
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function sheetCoerceOnWrite(v) {
  if (typeof v === 'string' && BARE_DATE_RE.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m - 1, d);   // local midnight, as Sheets stores it
  }
  return v;
}

// Read a date cell the way production does. Assertions must compare the coerced
// value, not String(cell) — a Date stringifies to 'Mon Jun 15 2026 00:00:00
// GMT+1000...' and would fail against a 'yyyy-MM-dd' literal for the wrong reason.
function cellDate(v) {
  if (!(v instanceof Date)) return String(v);
  const y = v.getFullYear(), m = v.getMonth() + 1, d = v.getDate();
  return y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
}

function makeSheet(headers) {
  // A real insertSheet() yields an EMPTY sheet; ensureSheet then appends the
  // header row. Seeding [[]] here gave every inserted tab a phantom blank row 1,
  // shifting headers to row 2 and all data down one.
  const rows = (headers && headers.length) ? [headers.slice()] : [];
  // Real Sheet 1-indexed row/col growth: writing past the current bounds
  // extends the sheet rather than throwing.
  function ensureRow(rowIdx) {
    while (rows.length <= rowIdx) rows.push([]);
    return rows[rowIdx];
  }
  function setCell(rowIdx, colIdx, v) {
    const r = ensureRow(rowIdx);
    while (r.length <= colIdx) r.push(undefined);
    r[colIdx] = sheetCoerceOnWrite(v);
  }
  // getRange(row, col, numRows?, numCols?) — 1-indexed, as GAS. setValue/
  // setValues actually write into `rows` (upsertRows_'s entire mechanism is
  // getRange(row, col).setValue(v)); an unimplemented upsert and a correct
  // one must NOT produce identical sheet state.
  function makeRangeChain(row, col) {
    const chain = {
      setBackground() { return chain; },
      setFontColor() { return chain; },
      setFontWeight() { return chain; },
      setValue(v) { setCell(row - 1, col - 1, v); return chain; },
      setValues(vals) {
        vals.forEach((rowVals, ri) => {
          rowVals.forEach((v, ci) => setCell(row - 1 + ri, col - 1 + ci, v));
        });
        return chain;
      },
    };
    return chain;
  }
  return {
    _rows: rows,
    appendRow: (a) => rows.push(a.map(sheetCoerceOnWrite)),
    deleteRow: (rowNum) => rows.splice(rowNum - 1, 1),
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    getRange: (row, col) => makeRangeChain(row, col),
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

// currentSS is created after load('Code.gs') below, once SUPPLIERS_HEADERS /
// SALES_HEADERS have been read off globalThis (makeSpreadsheet() needs them).
let currentSS;
let scriptProps = {};

global.SpreadsheetApp = {
  getActiveSpreadsheet: () => currentSS,
  openById: () => currentSS,
};
// setProperty is REQUIRED, not optional: stalenessStampHeartbeat_ swallows its
// own errors by design (the watchdog must never break ingest), so a missing
// setProperty would throw a TypeError into that catch and every heartbeat test
// would pass while proving nothing.
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (k in scriptProps ? scriptProps[k] : null),
    setProperty: (k, v) => { scriptProps[k] = String(v); },
    deleteProperty: (k) => { delete scriptProps[k]; },
  }),
};

// Calendar stub — captures created events so alert behaviour is assertable.
let calendarEvents = [];
let calendarFailMode = null;   // 'byId' | 'all' | null
function makeCalEvent(title, date) {
  const ev = {
    _title: title, _date: date, _color: null, _description: '',
    getTitle: () => ev._title,
    setColor: (c) => { ev._color = c; return ev; },
    setDescription: (d) => { ev._description = d; return ev; },
  };
  return ev;
}
global.CalendarApp = {
  EventColor: { ORANGE: 'ORANGE' },
  getCalendarById: (id) => {
    if (calendarFailMode === 'byId' || calendarFailMode === 'all') return null;
    return global.CalendarApp._cal(id);
  },
  getDefaultCalendar: () => {
    if (calendarFailMode === 'all') throw new Error('no default calendar');
    return global.CalendarApp._cal('default');
  },
  _cal: (id) => ({
    _id: id,
    getEventsForDay: () => calendarEvents.slice(),
    createAllDayEvent: (title, date) => {
      const ev = makeCalEvent(title, date);
      calendarEvents.push(ev);
      return ev;
    },
  }),
};
global.ContentService = {
  createTextOutput: (s) => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } }),
  MimeType: { JSON: 'json' },
};
global.Logger = { log: () => {} };
// Stubs so the connector modules load cleanly (their callers aren't tested here).
//
// formatDate is a REAL (if minimal) implementation, not a constant: the Fault 3
// regression test needs squareDailyPull to derive a genuine 'yesterday', and
// todayStr_ needs a real 'yyyy-MM-dd' rather than an ISO datetime. Only the
// patterns this codebase actually passes are supported; anything else throws
// loudly rather than returning a plausible lie.
//
// Timezone is modelled as a fixed +10:00 (AEST). Sydney DST (+11:00) is not
// simulated — no test depends on the offset digits, and a wrong-by-an-hour
// offset cannot change a 'yyyy-MM-dd' derived from a noon-UTC anchor.
const TZ_OFFSET_MIN = 600;          // +10:00
const TZ_OFFSET_STR = '+10:00';

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function mockFormatDate(d, tz, pattern) {
  if (!(d instanceof Date) || isNaN(d.getTime())) {
    throw new Error('mock formatDate: not a valid Date: ' + String(d));
  }
  const s = new Date(d.getTime() + TZ_OFFSET_MIN * 60000);
  const ymd = s.getUTCFullYear() + '-' + pad2(s.getUTCMonth() + 1) + '-' + pad2(s.getUTCDate());
  const hms = pad2(s.getUTCHours()) + ':' + pad2(s.getUTCMinutes()) + ':' + pad2(s.getUTCSeconds());
  if (pattern === 'yyyy-MM-dd') return ymd;
  if (pattern === 'XXX') return TZ_OFFSET_STR;
  if (pattern === "yyyy-MM-dd'T'HH:mm:ssXXX") return ymd + 'T' + hms + TZ_OFFSET_STR;
  throw new Error('mock formatDate: unsupported pattern ' + pattern);
}

global.Utilities = {
  formatDate: mockFormatDate,
  sleep: () => {},                  // mayers.gs:141 — never actually wait in tests
};

// Freeze Date.now() for the duration of fn. squareDailyPull derives 'yesterday'
// from Date.now(), so this is what makes the Fault 3 regression deterministic.
const REAL_DATE_NOW = Date.now;
function withMockNow(isoInstant, fn) {
  const ms = new Date(isoInstant).getTime();
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = REAL_DATE_NOW; }
}
global.UrlFetchApp = { fetch: () => { throw new Error('UrlFetchApp not mocked'); } };
global.ScriptApp = {
  getProjectTriggers: () => [],
  newTrigger: () => ({ timeBased: () => ({ onWeekDay: () => ({ atHour: () => ({ inTimezone: () => ({ create: () => {} }) }) }), everyDays: () => ({ inTimezone: () => ({ create: () => {} }) }), atHour: () => ({ everyDays: () => ({ inTimezone: () => ({ create: () => {} }) }) }) }) }),
  deleteTrigger: () => {},
  WeekDay: { MONDAY: 2 }
};
// LockService mock. __forceLockTimeout lets a test simulate a busy lock
// (tryLock returns false) without any real timing — withScriptLock_ must
// treat that as LOCK_TIMEOUT_, not throw.
global.__forceLockTimeout = false;
global.LockService = {
  getScriptLock: () => ({
    tryLock: () => !global.__forceLockTimeout,
    releaseLock: () => {},
  }),
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

// Read the real header arrays off the global scope Code.gs just populated
// (indirect eval makes its top-level `var` declarations global properties).
// Do NOT declare local copies — that shadowing is exactly the bug this
// re-derivation exists to prevent (see comment near the top of this file).
const SUPPLIERS_HEADERS = globalThis.SUPPLIERS_HEADERS;
const SALES_HEADERS = globalThis.SALES_HEADERS;

// Now that the header arrays exist, build the mock spreadsheet.
currentSS = makeSpreadsheet();

load('square.gs');
load('mayers.gs');
load('staleness.gs');

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

console.log('mock harness: getRange/setValue can actually fail');
(function () {
  // Meta-assertion: this is the test that proves the mock can fail. Before
  // this phase, setValue() was a no-op — an unimplemented upsertRows_ and a
  // correct one produced identical sheet state under this suite.
  freshSheets();
  var sheet = currentSS.getSheetByName('Suppliers');
  sheet.getRange(2, 1).setValue('x');
  eq('getRange(2,1).setValue writes into the sheet, read back at row 2 col 1',
    sheet._rows[1][0], 'x');

  // Bare 'yyyy-MM-dd' coerces to a Date on write via getRange, same as
  // appendRow — production writes dates through both paths.
  freshSheets();
  var sheet2 = currentSS.getSheetByName('Suppliers');
  sheet2.getRange(2, 1).setValue('2026-08-03');
  check('getRange().setValue coerces a bare date string to a Date',
    sheet2._rows[1][0] instanceof Date);
  eq('...and it round-trips to the same yyyy-MM-dd',
    cellDate(sheet2._rows[1][0]), '2026-08-03');

  // Writing past the current row length extends the row rather than
  // throwing — matches a real Sheet's getRange(row, col) semantics.
  freshSheets();
  var sheet3 = currentSS.getSheetByName('Suppliers');
  var threw = false;
  try {
    sheet3.getRange(2, 5).setValue('z');
  } catch (err) {
    threw = true;
  }
  check('writing beyond current row length extends the row, does not throw', !threw);
  eq('extended row has the value at the target column',
    sheet3._rows[1][4], 'z');

  // Header parity: no local shadow of SUPPLIERS_HEADERS/SALES_HEADERS —
  // the tests use exactly the globals Code.gs declared.
  check('SUPPLIERS_HEADERS used by tests is globalThis.SUPPLIERS_HEADERS (no shadow)',
    SUPPLIERS_HEADERS === globalThis.SUPPLIERS_HEADERS);
  check('SALES_HEADERS used by tests is globalThis.SALES_HEADERS (no shadow)',
    SALES_HEADERS === globalThis.SALES_HEADERS);
})();

console.log('normalizeSupplierRow');
eq('maps columns + resolves canonical supplier from source, department defaults to Cafe',
  normalizeSupplierRow({ date: '2026-06-15', total: '245.50', invoice_ref: 'INV-1', location: 'York St' }, 'food_dairy_co', 'TS'),
  ['2026-06-15', 'Food and Dairy Co', 245.5, 'INV-1', 'York St', 'food_dairy_co', 'TS', 'Cafe']);
eq('per-row supplier (Ordermentum) wins over the map',
  normalizeSupplierRow({ date: '2026-06-15', total: 80, invoice_ref: 'O-9', supplier: 'Tuga Pastry' }, 'ordermentum', 'TS'),
  ['2026-06-15', 'Tuga Pastry', 80, 'O-9', '', 'ordermentum', 'TS', 'Cafe']);
eq('unknown source falls back to the raw source name',
  normalizeSupplierRow({ date: '2026-06-15', total: 10, invoice_ref: 'X' }, 'mystery', 'TS')[1],
  'mystery');
eq('explicit row.department wins over the default',
  normalizeSupplierRow({ date: '2026-06-15', total: 10, invoice_ref: 'X', department: 'Roastery' }, 'mystery', 'TS')[7],
  'Roastery');

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
  eq('batch of 3 with 1 dup → 2 added, 1 skipped', r1, { rowsAdded: 2, rowsUpdated: 0, duplicatesSkipped: 1 });
  const r2 = ingestSupplierRows('kent_paper', batch, 'TS', sheet);
  eq('re-ingest same batch → 0 added (all dup vs sheet)', r2, { rowsAdded: 0, rowsUpdated: 0, duplicatesSkipped: 3 });
})();

console.log('doPost');
freshSheets();
eq('happy path → ok, rowsAdded 2',
  doPostJson({ source: 'food_dairy_co', extracted_at: 'TS', rows: [
    { date: '2026-06-15', total: 50, invoice_ref: 'B1' },
    { date: '2026-06-15', total: 60, invoice_ref: 'B2' },
  ] }),
  { result: 'ok', rowsAdded: 2, rowsUpdated: 0, duplicatesSkipped: 0 });

freshSheets();
eq('batch with duplicate invoice_ref → 1 added, 1 skipped',
  doPostJson({ source: 'food_dairy_co', extracted_at: 'TS', rows: [
    { date: '2026-06-15', total: 50, invoice_ref: 'C1' },
    { date: '2026-06-99', total: 77, invoice_ref: 'C1' },
  ] }),
  { result: 'ok', rowsAdded: 1, rowsUpdated: 0, duplicatesSkipped: 1 });

freshSheets();
check('missing total → result error',
  doPostJson({ source: 'food_dairy_co', extracted_at: 'TS', rows: [{ date: '2026-06-15', invoice_ref: 'D1' }] }).result === 'error');

freshSheets();
check('missing source → result error',
  doPostJson({ extracted_at: 'TS', rows: [] }).result === 'error');

freshSheets();
(function () {
  const res = doPostJson({ source: 'mystery_co', extracted_at: 'TS', rows: [{ date: '2026-06-15', total: 5, invoice_ref: 'E1' }] });
  eq('unknown source still ingests (ok, 1 added)', res, { result: 'ok', rowsAdded: 1, rowsUpdated: 0, duplicatesSkipped: 0 });
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
  eq('Date-object rows summed', result[0].total, 300);
  eq('Date-object rows default to Cafe/spend', result[0].department + '|' + result[0].kind, 'Cafe|spend');
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
  eq('Butterboy York total', result[0].total, 80);
  eq('Butterboy York supplier', result[0].supplier, 'Butterboy');
  eq('FDC North total', result[1].total, 50);
  eq('FDC York total (100+200)', result[2].total, 300);

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
  eq('source remaining row is recent', cellDate(source._rows[1][0]), '2026-06-15');
  eq('archive has header + 2 archived rows', archive._rows.length, 3);
  eq('archive first row date (bottom-up order)', cellDate(archive._rows[1][0]), '2026-01-15');
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

/* ------------------------------------------------------------------ *
 * Step 3 — resolveDateArg_ (Fault 3: trigger event object in a date arg)
 * ------------------------------------------------------------------ */

(function testResolveDateArg() {
  console.log('\nresolveDateArg_:');

  eq('valid date passes through', resolveDateArg_('2026-07-15', 'FB'), '2026-07-15');
  eq('surrounding whitespace trimmed', resolveDateArg_('  2026-07-15  ', 'FB'), '2026-07-15');

  eq('undefined → fallback', resolveDateArg_(undefined, 'FB'), 'FB');
  eq('null → fallback', resolveDateArg_(null, 'FB'), 'FB');
  eq('empty string → fallback', resolveDateArg_('', 'FB'), 'FB');

  // THE REGRESSION: this exact shape corrupted 8 Sales rows.
  var evt = { 'week-of-year': 27.0, triggerUid: '3647519953440997376', authMode: 'FULL' };
  eq('trigger EVENT OBJECT → fallback', resolveDateArg_(evt, 'FB'), 'FB');

  eq('Date object → fallback', resolveDateArg_(new Date(), 'FB'), 'FB');
  eq('number → fallback', resolveDateArg_(20260715, 'FB'), 'FB');
  eq('dd/mm/yyyy → fallback', resolveDateArg_('05/07/2026', 'FB'), 'FB');
  eq('unpadded 2026-7-5 → fallback', resolveDateArg_('2026-7-5', 'FB'), 'FB');
  eq('ISO datetime → fallback', resolveDateArg_('2026-07-15T00:00:00Z', 'FB'), 'FB');
  eq("'yesterday' → fallback", resolveDateArg_('yesterday', 'FB'), 'FB');

  // Regex-shaped but not real calendar dates
  eq('2026-02-31 → fallback', resolveDateArg_('2026-02-31', 'FB'), 'FB');
  eq('2026-13-01 → fallback', resolveDateArg_('2026-13-01', 'FB'), 'FB');
  eq('non-leap 2026-02-29 → fallback', resolveDateArg_('2026-02-29', 'FB'), 'FB');
  eq('leap 2028-02-29 is valid', resolveDateArg_('2028-02-29', 'FB'), '2028-02-29');
})();

/* ------------------------------------------------------------------ *
 * Step 7 — addDaysStr_
 * ------------------------------------------------------------------ */

(function testAddDaysStr() {
  console.log('\naddDaysStr_:');
  eq('+6 days within month', addDaysStr_('2026-06-15', 6), '2026-06-21');
  eq('+0 days is identity', addDaysStr_('2026-06-15', 0), '2026-06-15');
  eq('month rollover', addDaysStr_('2026-06-29', 6), '2026-07-05');
  eq('year rollover', addDaysStr_('2026-12-28', 6), '2027-01-03');
  eq('leap-year February', addDaysStr_('2028-02-26', 6), '2028-03-03');
  eq('negative days', addDaysStr_('2026-07-05', -6), '2026-06-29');
})();

/* ------------------------------------------------------------------ *
 * Step 3 — squareDailyPull integration: the bug that started this
 * ------------------------------------------------------------------ */

(function testSquareDailyPullTriggerEvent() {
  console.log('\nsquareDailyPull (Fault 3 regression):');

  // A token MUST be present. With scriptProps={} every site hits the no-token
  // `continue` and NO row is ever appended — so "no garbage row written" would
  // pass identically against the buggy code. The whole point of Fault 3 is the
  // CONTENT of a row that DOES get written, so we must actually write one.
  const SITE_PROP = SQUARE_SITES[0].prop;   // only site 0 gets a token → exactly 1 row
  const REAL_URL_FETCH = global.UrlFetchApp;
  function armSquare() {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    scriptProps[SITE_PROP] = 'fake-token';
    // Minimal Square API: one location, zero orders → gross 0, one row written.
    global.UrlFetchApp = {
      fetch: (url) => ({
        getResponseCode: () => 200,
        getContentText: () => (String(url).indexOf('/locations') !== -1
          ? JSON.stringify({ locations: [{ id: 'L1', name: 'Site' }] })
          : JSON.stringify({ orders: [] })),
      }),
    };
  }

  withMockNow('2026-07-16T05:00:00Z', function () {   // 15:00 Sydney, Thu 16 Jul
    armSquare();
    var evt = { 'week-of-year': 27.0, triggerUid: '3647519953440997376', authMode: 'FULL' };
    var res = squareDailyPull(evt);

    eq('trigger event → yesterday, not the event object', res.date, '2026-07-15');

    // The row was really written — this is what corrupted the live Sales tab.
    var rows = currentSS.getSheetByName('Sales').getDataRange().getValues();
    eq('a Sales row WAS written (test is not vacuous)', rows.length, 2);
    eq('written date cell is a real date', cellDate(rows[1][0]), '2026-07-15');
    check('date cell never carries the event object',
      String(rows[1][0]).indexOf('triggerUid') === -1);
    check('date cell matches YYYY-MM-DD exactly', DATE_ARG_RE.test(cellDate(rows[1][0])));
    check('the written row is NOT flagged corrupt by the cleanup predicate',
      !salesRowIsCorrupt_(rows[1]));
  });

  // A real date argument must still be honoured, and reach the date cell.
  withMockNow('2026-07-16T05:00:00Z', function () {
    armSquare();
    eq('explicit date still honoured', squareDailyPull('2026-07-01').date, '2026-07-01');
    eq('explicit date reaches the row',
      cellDate(currentSS.getSheetByName('Sales').getDataRange().getValues()[1][0]), '2026-07-01');
  });

  // No argument at all (the intended manual call) → yesterday.
  withMockNow('2026-07-16T05:00:00Z', function () {
    armSquare();
    eq('no arg → yesterday', squareDailyPull().date, '2026-07-15');
  });

  global.UrlFetchApp = REAL_URL_FETCH;   // don't leak the fake into later suites
})();

/* ------------------------------------------------------------------ *
 * fix-silent-ingest-failures step 1 — Square API failure null-sentinel
 *
 * squareCallApi_ already returns null on any non-2xx / exception. Before this
 * fix, squareListLocations_ and squareSearchOrders_ collapsed that null into
 * [] — indistinguishable from a genuine empty result — so an outage wrote a
 * $0 Sales row AND stamped the freshness heartbeat, silencing the very
 * watchdog built to catch this. null must now propagate so the caller can
 * tell "API failed" apart from "really zero".
 * ------------------------------------------------------------------ */

(function testSquareApiFailureNullSentinel() {
  console.log('\nsquare API failure — null sentinel (not [] / not silent $0):');

  const REAL_URL_FETCH = global.UrlFetchApp;

  // --- squareListLocations_ ---
  global.UrlFetchApp = {
    fetch: () => ({ getResponseCode: () => 500, getContentText: () => 'server error' }),
  };
  eq('squareListLocations_: API failure (squareCallApi_ -> null) returns null, not []',
    squareListLocations_('tok'), null);

  global.UrlFetchApp = {
    fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ locations: [] }) }),
  };
  eq('squareListLocations_: genuine empty {locations: []} still returns []',
    squareListLocations_('tok'), []);

  // --- squareSearchOrders_ ---
  global.UrlFetchApp = {
    fetch: () => ({ getResponseCode: () => 500, getContentText: () => 'server error' }),
  };
  eq('squareSearchOrders_: API failure (squareCallApi_ -> null) returns null, not []',
    squareSearchOrders_('tok', 'L1', '2026-07-15T00:00:00+10:00', '2026-07-15T23:59:59+10:00'), null);

  global.UrlFetchApp = REAL_URL_FETCH;

  const SITE0 = SQUARE_SITES[0];
  const SITE1 = SQUARE_SITES[1];

  // Single site, API fails (locations call 500s): NO Sales row, NO heartbeat.
  withMockNow('2026-07-16T05:00:00Z', function () {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    scriptProps[SITE0.prop] = 'tok-fail';
    global.UrlFetchApp = {
      fetch: () => ({ getResponseCode: () => 500, getContentText: () => 'boom' }),
    };
    squareDailyPull();
    const rows = currentSS.getSheetByName('Sales').getDataRange().getValues();
    eq('site API failure: no Sales row appended (header only)', rows.length, 1);
    check('site API failure: heartbeat NOT stamped',
      !('LAST_INGEST_square' in scriptProps));
    global.UrlFetchApp = REAL_URL_FETCH;
  });

  // Single site, API OK but genuinely zero orders: a real closed day must
  // still record its $0 row AND stamp the heartbeat — no over-correction.
  withMockNow('2026-07-16T05:00:00Z', function () {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    scriptProps[SITE0.prop] = 'tok-ok';
    global.UrlFetchApp = {
      fetch: (url) => ({
        getResponseCode: () => 200,
        getContentText: () => (String(url).indexOf('/locations') !== -1
          ? JSON.stringify({ locations: [{ id: 'L1', name: 'Site' }] })
          : JSON.stringify({ orders: [] })),
      }),
    };
    squareDailyPull();
    const rows = currentSS.getSheetByName('Sales').getDataRange().getValues();
    eq('real closed day: a $0 Sales row IS written', rows.length, 2);
    eq('real closed day: gross is genuinely 0', rows[1][2], 0);
    check('real closed day: heartbeat IS stamped', 'LAST_INGEST_square' in scriptProps);
    global.UrlFetchApp = REAL_URL_FETCH;
  });

  // Two sites, one fails (locations 500) + one succeeds: heartbeat IS
  // stamped (>=1 healthy site), the failed site writes NO row, the healthy
  // site writes its row.
  withMockNow('2026-07-16T05:00:00Z', function () {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    scriptProps[SITE0.prop] = 'tok-fail';
    scriptProps[SITE1.prop] = 'tok-ok';
    global.UrlFetchApp = {
      fetch: (url, options) => {
        const auth = options && options.headers && options.headers['Authorization'];
        if (auth === 'Bearer tok-fail') {
          return { getResponseCode: () => 500, getContentText: () => 'boom' };
        }
        return {
          getResponseCode: () => 200,
          getContentText: () => (String(url).indexOf('/locations') !== -1
            ? JSON.stringify({ locations: [{ id: 'L2', name: 'Site2' }] })
            : JSON.stringify({ orders: [] })),
        };
      },
    };
    squareDailyPull();
    const rows = currentSS.getSheetByName('Sales').getDataRange().getValues();
    eq('mixed sites: exactly one row written (the healthy site only)', rows.length, 2);
    eq('mixed sites: the written row belongs to the healthy site', rows[1][1], SITE1.name);
    check('mixed sites: heartbeat IS stamped (>=1 site succeeded)',
      'LAST_INGEST_square' in scriptProps);
    global.UrlFetchApp = REAL_URL_FETCH;
  });
})();

/* ------------------------------------------------------------------ *
 * Step 4 — salesRowIsCorrupt_ predicate (this one deletes real money data)
 * ------------------------------------------------------------------ */

(function testSalesRowIsCorrupt() {
  console.log('\nsalesRowIsCorrupt_:');
  // Sales row shape: [date, location, gross_sales, source, extracted_at]

  check('healthy row (date as string) → keep',
    !salesRowIsCorrupt_(['2026-07-15', 'Leible York', 1234.5, 'square', 'x']));

  // Sheets hands dates back as Date objects, not strings.
  check('healthy row (date as Date object) → keep',
    !salesRowIsCorrupt_([new Date(2026, 6, 15), 'Leible York', 1234.5, 'square', 'x']));

  // THE TARGET: stringified trigger event in the date column.
  check('corrupt row (stringified event) → delete',
    salesRowIsCorrupt_(['{week-of-year=27.0, triggerUid=3647519953440997376}', 'Leible York', 0.0, 'square', 'x']));

  // The case that earns the predicate its keep: a genuinely closed trading day
  // is $0 on a VALID date. Gross==0 must never imply corruption.
  check('zero gross on a valid date → keep (closed day)',
    !salesRowIsCorrupt_(['2026-07-15', 'Leible York', 0.0, 'square', 'x']));

  check('blank date on a square row → delete',
    salesRowIsCorrupt_(['', 'Leible York', 0.0, 'square', 'x']));

  check('non-square source is never touched',
    !salesRowIsCorrupt_(['{garbage}', 'Leible York', 0.0, 'manual', 'x']));

  check('fully blank row → keep (source is not square)',
    !salesRowIsCorrupt_(['', '', '', '', '']));

  check('source matching is case/space tolerant',
    salesRowIsCorrupt_(['{garbage}', 'Leible York', 0.0, ' Square ', 'x']));
})();

/* ------------------------------------------------------------------ *
 * Step 4 — cleanupCorruptSalesRows: dry-run default, guard, deletion
 * ------------------------------------------------------------------ */

(function testCleanupCorruptSalesRows() {
  console.log('\ncleanupCorruptSalesRows:');

  const EVT = '{week-of-year=27.0, triggerUid=3647519953440997376}';
  function seed(corruptCount) {
    currentSS = makeSpreadsheet();
    const sales = currentSS.getSheetByName('Sales');
    sales.appendRow(['2026-07-14', 'Leible York', 100, 'square', 'x']);   // healthy
    for (let i = 0; i < corruptCount; i++) {
      sales.appendRow([EVT, 'Leible York', 0.0, 'square', 'x']);
    }
    sales.appendRow(['2026-07-15', 'Leible Pitt', 0.0, 'square', 'x']);   // closed day
    return sales;
  }

  // Default = dry run. Nothing may be deleted.
  var sales = seed(8);
  var before = sales.getDataRange().getValues().length;
  var dry = cleanupCorruptSalesRows();
  eq('no-arg → dry run', dry.mode, 'dryRun');
  eq('dry run finds all 8', dry.found, 8);
  eq('dry run deletes nothing', sales.getDataRange().getValues().length, before);

  // The editor Run button / a trigger event must NOT delete.
  sales = seed(8);
  before = sales.getDataRange().getValues().length;   // re-read: don't rely on the previous seed
  eq('trigger event arg → still dry run',
    cleanupCorruptSalesRows({ triggerUid: 'x', authMode: 'FULL' }).mode, 'dryRun');
  eq('trigger event arg deletes nothing', sales.getDataRange().getValues().length, before);
  eq('true → still dry run (only false applies)', cleanupCorruptSalesRows(true).mode, 'dryRun');
  eq('truthy string "false" → still dry run', cleanupCorruptSalesRows('false').mode, 'dryRun');
  eq('null → still dry run', cleanupCorruptSalesRows(null).mode, 'dryRun');
  eq('0 → still dry run', cleanupCorruptSalesRows(0).mode, 'dryRun');
  eq('after every non-false arg, nothing was deleted',
    sales.getDataRange().getValues().length, before);

  // Apply: deletes exactly the corrupt rows, keeps the healthy + closed-day rows.
  sales = seed(8);
  var applied = cleanupCorruptSalesRows(false);
  eq('apply deletes 8', applied.deleted, 8);
  var remaining = sales.getDataRange().getValues();
  eq('2 legitimate rows survive (+header)', remaining.length, 3);
  eq('healthy row survived', cellDate(remaining[1][0]), '2026-07-14');
  eq('closed-day $0 row survived', cellDate(remaining[2][0]), '2026-07-15');
  check('no corrupt row survived',
    remaining.every((r) => String(r[0]).indexOf('triggerUid') === -1));

  // Count guard: if the sheet doesn't look like we expect, refuse to delete.
  sales = seed(5);
  before = sales.getDataRange().getValues().length;
  eq('count mismatch → aborted', cleanupCorruptSalesRows(false), 'aborted');
  eq('aborted run deleted nothing', sales.getDataRange().getValues().length, before);

  // The guard is a constant, not a magic number: retarget it and apply works.
  sales = seed(5);
  var savedExpected = CLEANUP_EXPECTED_CORRUPT_ROWS;
  CLEANUP_EXPECTED_CORRUPT_ROWS = 5;
  eq('retargeted guard → applies', cleanupCorruptSalesRows(false).deleted, 5);
  CLEANUP_EXPECTED_CORRUPT_ROWS = savedExpected;
})();

/* ------------------------------------------------------------------ *
 * Step 7c — cleanupDuplicateSummaryRows (one-shot repair)
 * ------------------------------------------------------------------ */

(function testCleanupDuplicateSummaryRows() {
  console.log('\ncleanupDuplicateSummaryRows:');

  // Mirrors the live tab: the same week appended 3x by the broken dedup, plus
  // Labour rows (distinct supplier key) that must survive untouched.
  function seedSummary() {
    currentSS = makeSpreadsheet();
    const s = currentSS.insertSheet('Summary');
    s.appendRow(SUMMARY_HEADERS);
    for (const stamp of ['T1', 'T2', 'T3']) {
      s.appendRow(['2026-06-15', '2026-06-21', 'Food and Dairy Co', 'Leible Pitt', 263, stamp]);
      s.appendRow(['2026-06-15', '2026-06-21', 'Fresh and Chill', 'Leible York', 960, stamp]);
    }
    s.appendRow(['2026-06-15', '2026-06-21', 'Labour', 'york', 4830.14, 'T3']);
    return s;
  }

  var sheet = seedSummary();
  eq('seeded 7 data rows (+header)', sheet._rows.length, 8);

  // Dry run must report without touching anything.
  var dry = cleanupDuplicateSummaryRows();
  eq('dry run is the default (no arg)', dry.mode, 'dryRun');
  eq('dry run finds 4 duplicates', dry.found, 4);
  eq('dry run deletes nothing', dry.deleted, 0);
  eq('dry run leaves the sheet intact', sheet._rows.length, 8);

  // Apply: one row per key survives, Labour untouched.
  var applied = cleanupDuplicateSummaryRows(false);
  eq('apply deletes 4', applied.deleted, 4);
  var rows = sheet.getDataRange().getValues();
  eq('3 unique rows survive (+header)', rows.length, 4);
  eq('first FDCo row kept', rows[1][5], 'T1');
  eq('first F&C row kept', rows[2][5], 'T1');
  eq('Labour row survived', rows[3][2], 'Labour');
  eq('Labour total intact', rows[3][4], 4830.14);

  // Idempotent — the whole point of a repair that may be re-run.
  var again = cleanupDuplicateSummaryRows(false);
  eq('re-apply finds nothing', again.found, 0);
  eq('re-apply deletes nothing', again.deleted, 0);
  eq('sheet unchanged by re-apply', sheet.getDataRange().getValues().length, 4);

  // A same-key row with a DIFFERENT total is not a mechanical duplicate: deleting
  // it would destroy a genuine correction. It must be reported and left alone.
  sheet = seedSummary();
  sheet.appendRow(['2026-06-15', '2026-06-21', 'Food and Dairy Co', 'Leible Pitt', 999, 'T4']);
  var conf = cleanupDuplicateSummaryRows(false);
  eq('conflict is reported', conf.conflicts.length, 1);
  eq('conflict names the differing total', conf.conflicts[0].thisTotal, 999);
  eq('conflict row is NOT deleted',
    sheet.getDataRange().getValues().some((r) => r[4] === 999), true);
  eq('clean duplicates still removed alongside the conflict', conf.deleted, 4);
})();

/* ------------------------------------------------------------------ *
 * Step 7b — labourWeeklyPull_ dedup
 *
 * The labour path is live in production (LABOUR_SHEET_ID is set, Labour rows
 * are in the hub Sheet) but had no coverage at all — the only prior mention of
 * it in this suite was a line switching it OFF. It keys both the Labour tab and
 * its Summary rows on week_start read back from a Sheet, i.e. the same Date-vs-
 * string trap that broke the supplier dedup, so it gets the same re-run test.
 * ------------------------------------------------------------------ */

(function testLabourWeeklyPullDedup() {
  console.log('\nlabourWeeklyPull_ dedup:');

  // openById returns the same mock spreadsheet, so LABOUR_COST lives alongside
  // the hub tabs — fine here: the code only ever reads it by name.
  function seedLabour() {
    currentSS = makeSpreadsheet();
    scriptProps = { LABOUR_SHEET_ID: 'labour-sheet-id' };
    const src = currentSS.insertSheet('LABOUR_COST');
    src.appendRow(['week_start', 'week_end', 'location', 'total', 'iso_week', 'pulled_at']);
    src.appendRow(['2026-06-15', '2026-06-21', 'york', 4830.14, '2026-W25', 'x']);
    src.appendRow(['2026-06-15', '2026-06-21', 'pitt', 6720.32, '2026-W25', 'x']);
    const supp = currentSS.getSheetByName('Suppliers');
    supp.appendRow(['2026-06-17', 'Food and Dairy Co', 100, 'A1', 'Leible York', 'food_dairy_co', 'x']);
    return supp;
  }

  seedLabour();
  var first = weeklySummarize('2026-06-15');
  eq('labour rows written to Labour tab', first.labourTabAdded, 2);
  eq('labour rows written to Summary', first.labourSummaryAdded, 2);

  var labourTab = currentSS.getSheetByName('Labour').getDataRange().getValues();
  eq('Labour tab has header + 2 rows', labourTab.length, 3);
  eq('Labour row carries the week Monday', cellDate(labourTab[1][0]), '2026-06-15');
  eq('labour total survives the round-trip', labourTab[1][3], 4830.14);

  // The bug this guards: week_start returns from the Sheet as a Date, so a raw
  // String() key never matches '2026-06-15' and every re-run re-appends.
  var second = weeklySummarize('2026-06-15');
  eq('re-run adds no Labour tab rows', second.labourTabAdded, 0);
  eq('re-run adds no labour Summary rows', second.labourSummaryAdded, 0);
  eq('Labour tab still has header + 2 rows',
    currentSS.getSheetByName('Labour').getDataRange().getValues().length, 3);

  // A missing LABOUR_SHEET_ID must skip cleanly rather than throw — the supplier
  // summary still has to land when the labour source is unavailable.
  seedLabour();
  scriptProps = {};
  var noLabour = weeklySummarize('2026-06-15');
  eq('no LABOUR_SHEET_ID → labour skipped', noLabour.labourTabAdded, 0);
  eq('no LABOUR_SHEET_ID → supplier summary still lands', noLabour.summariesAdded, 1);
})();

/* ------------------------------------------------------------------ *
 * Step 7 — weeklySummarize(weekStartOverride)
 * ------------------------------------------------------------------ */

(function testWeeklySummarizeOverride() {
  console.log('\nweeklySummarize override:');

  function seedSuppliers() {
    currentSS = makeSpreadsheet();
    scriptProps = {};                       // no LABOUR_SHEET_ID → labour pull skips
    const supp = currentSS.getSheetByName('Suppliers');
    // Week of Mon 2026-06-15 … Sun 2026-06-21 (the backlog week).
    supp.appendRow(['2026-06-17', 'Food and Dairy Co', 100, 'A1', 'Leible York', 'food_dairy_co', 'x']);
    supp.appendRow(['2026-06-18', 'Food and Dairy Co', 50, 'A2', 'Leible York', 'food_dairy_co', 'x']);
    return supp;
  }

  // Wednesday 2026-06-17 must SNAP BACK to Monday 2026-06-15. Without the snap
  // it writes week_start='2026-06-17', which overlaps the trigger's Monday rows
  // and double-counts spend in filterSummaryByDateRange_.
  seedSuppliers();
  var r = weeklySummarize('2026-06-17');
  eq('Wednesday override snaps to Monday', r.weekStart, '2026-06-15');
  eq('week end is the following Sunday', r.weekEnd, '2026-06-21');
  eq('backlog week actually summarized', r.summariesAdded, 1);

  var summary = currentSS.getSheetByName('Summary').getDataRange().getValues();
  eq('Summary row carries the snapped Monday', cellDate(summary[1][0]), '2026-06-15');
  eq('spend aggregated for the week', summary[1][4], 150);

  // A Monday override stays put; a Sunday belongs to the week that started 6 days earlier.
  seedSuppliers();
  eq('Monday override is unchanged', weeklySummarize('2026-06-15').weekStart, '2026-06-15');
  seedSuppliers();
  eq('Sunday override snaps back to its Monday', weeklySummarize('2026-06-21').weekStart, '2026-06-15');

  // A trigger event object must NOT be treated as a week.
  seedSuppliers();
  var evtRes = weeklySummarize({ 'week-of-year': 25.0, triggerUid: 'abc', authMode: 'FULL' });
  eq('trigger event → falls back to last completed week',
    evtRes.weekStart, getLastCompletedWeek_(todayStr_()).start);

  // No-arg behaviour is unchanged (the Monday trigger's path).
  seedSuppliers();
  eq('no arg → last completed week',
    weeklySummarize().weekStart, getLastCompletedWeek_(todayStr_()).start);

  // Re-running the same week must not duplicate Summary rows (append-only tab).
  seedSuppliers();
  weeklySummarize('2026-06-15');
  var second = weeklySummarize('2026-06-15');
  eq('re-run adds nothing (dedup)', second.summariesAdded, 0);
  eq('Summary still has exactly 1 data row',
    currentSS.getSheetByName('Summary').getDataRange().getValues().length, 2);

  /* --- an INCOMPLETE week must be refused ---------------------------- *
   * Summary is append-only and dedup can only SKIP, never UPDATE. Summarizing
   * a half-finished week freezes the partial total; the Monday trigger then
   * skips it as "already done" and the rest of the week's spend vanishes.  */
  var todayNow = todayStr_();
  var thisMonday = weekStartForDate_(todayNow);

  seedSuppliers();
  var cur = weeklySummarize(todayNow);
  eq('current week → refused', cur.refused, 'incomplete-week');
  eq('refused run summarizes nothing', cur.summariesAdded, 0);
  eq('refused run wrote no Summary rows',
    currentSS.getSheetByName('Summary').getDataRange().getValues().length, 1);

  seedSuppliers();
  eq('this Monday (week still running) → refused',
    weeklySummarize(thisMonday).refused, 'incomplete-week');

  seedSuppliers();
  eq('a future week → refused',
    weeklySummarize(addDaysStr_(todayNow, 30)).refused, 'incomplete-week');

  // The boundary: the week that ended yesterday IS complete and must proceed.
  seedSuppliers();
  var lastWeekMon = addDaysStr_(thisMonday, -7);
  var lastWeek = weeklySummarize(lastWeekMon);
  check('the most recently COMPLETED week is allowed', lastWeek.refused === undefined);
  eq('completed week summarizes normally', lastWeek.weekStart, lastWeekMon);

  /* --- an override run must NOT archive/purge ------------------------- *
   * Purging on a backlog run eats the rows just summarized, so a rebuild
   * silently returns summariesAdded:0 — "already done" vs "data is gone".  */
  currentSS = makeSpreadsheet();
  scriptProps = {};
  var suppOld = currentSS.getSheetByName('Suppliers');
  suppOld.appendRow(['2025-12-17', 'Food and Dairy Co', 100, 'B1', 'Leible York', 'food_dairy_co', 'x']);

  var oldRes = weeklySummarize('2025-12-17');           // way past ARCHIVE_RETENTION_DAYS
  eq('old backlog week still summarizes', oldRes.summariesAdded, 1);
  eq('override run purged nothing (source row intact)',
    currentSS.getSheetByName('Suppliers').getDataRange().getValues().length, 2);
  eq('override run archived nothing',
    currentSS.getSheetByName('_archive').getDataRange().getValues().length, 1);
})();

/* ------------------------------------------------------------------ *
 * Step 4 (also) — archiveAndPurge_ must not eat blank rows
 * ------------------------------------------------------------------ */

(function testArchiveAndPurgeBlankRows() {
  console.log('\narchiveAndPurge_ blank-row guard:');

  const src = makeSheet(SUPPLIERS_HEADERS);
  const arch = makeSheet(SUPPLIERS_HEADERS);
  src.appendRow(['2020-01-01', 'Old Co', 10, 'R1', 'Leible York', 'food_dairy_co', 'x']);  // genuinely old
  src.appendRow(['', '', '', '', '', '', '']);                                             // blank
  src.appendRow(['2026-07-15', 'New Co', 20, 'R2', 'Leible York', 'food_dairy_co', 'x']);  // recent

  var archived = archiveAndPurge_(src, arch, '2026-01-14');

  eq('only the genuinely old row is archived', archived, 1);
  eq('blank row survives the purge', src.getDataRange().getValues().length, 3);
  eq('archive contains just the old row', arch.getDataRange().getValues().length, 2);
  eq('archived row is the old one', arch.getDataRange().getValues()[1][1], 'Old Co');
})();

/* ------------------------------------------------------------------ *
 * Step 5 — staleness watchdog
 * ------------------------------------------------------------------ */

const HOUR = 3600000;
const NOW = new Date('2026-07-16T01:00:00Z').getTime();   // 11:00 Sydney, Thu 16 Jul

(function testStalenessPureHelpers() {
  console.log('\nstaleness pure helpers:');

  // --- stalenessParseTs_ : String AND Date (Sheets coerces date-ish text) ---
  eq('parses an ISO string with offset',
    stalenessParseTs_('2026-07-16T11:00:00+10:00'), new Date('2026-07-16T01:00:00Z').getTime());
  eq('parses a Date object', stalenessParseTs_(new Date(NOW)), NOW);
  eq('blank → null', stalenessParseTs_(''), null);
  eq('null → null', stalenessParseTs_(null), null);
  eq('undefined → null', stalenessParseTs_(undefined), null);
  eq('garbage → null', stalenessParseTs_('not a date'), null);
  eq('Invalid Date object → null', stalenessParseTs_(new Date('nope')), null);

  // --- stalenessScanSheet_ : newest per source ---
  const sCol = SUPPLIERS_HEADERS.indexOf('source');
  const tCol = SUPPLIERS_HEADERS.indexOf('extracted_at');
  const values = [
    SUPPLIERS_HEADERS,
    ['2026-07-10', 'X', 1, 'r1', 'York', 'food_dairy_co', '2026-07-10T03:00:00+10:00'],
    ['2026-07-14', 'X', 1, 'r2', 'York', 'food_dairy_co', '2026-07-14T03:00:00+10:00'],  // newest FDCo
    ['2026-07-12', 'X', 1, 'r3', 'York', 'food_dairy_co', '2026-07-12T03:00:00+10:00'],
    ['2026-07-11', 'X', 1, 'r4', 'York', 'ordermentum', new Date('2026-07-11T03:00:00Z')], // Date cell
    ['', '', '', '', '', '', ''],                                                          // blank row
    ['2026-07-13', 'X', 1, 'r5', 'York', 'fresh_and_chill', 'garbage'],                    // unparseable ts
  ];
  const scan = stalenessScanSheet_(values, sCol, tCol);
  eq('newest extracted_at per source wins',
    scan['food_dairy_co'], new Date('2026-07-14T03:00:00+10:00').getTime());
  eq('a Date-object timestamp is handled',
    scan['ordermentum'], new Date('2026-07-11T03:00:00Z').getTime());
  check('blank source row ignored', !('' in scan));
  check('row with unparseable ts contributes nothing', !('fresh_and_chill' in scan));

  eq('the Sales layout works too (different column indexes)',
    stalenessScanSheet_(
      [SALES_HEADERS, ['2026-07-15', 'York', 10, 'square', '2026-07-16T03:00:00+10:00']],
      SALES_HEADERS.indexOf('source'), SALES_HEADERS.indexOf('extracted_at')
    )['square'],
    new Date('2026-07-16T03:00:00+10:00').getTime());

  // --- stalenessMergeLastSeen_ ---
  const merged = stalenessMergeLastSeen_([
    { a: 100, b: 500 },
    { a: 300, c: 900 },   // a is newer here
  ]);
  eq('merge keeps the NEWER timestamp', merged.a, 300);
  eq('merge keeps non-overlapping keys', merged.b, 500);
  eq('merge adds new keys', merged.c, 900);
  eq('merging nothing → empty', JSON.stringify(stalenessMergeLastSeen_([])), '{}');

  // --- stalenessEvaluate_ : the threshold boundary ---
  const srcs = ['s1'];
  eq('exactly 96h is FRESH (strictly greater is stale)',
    stalenessEvaluate_({ s1: NOW - 96 * HOUR }, srcs, NOW, 96)[0].stale, false);
  eq('97h is stale', stalenessEvaluate_({ s1: NOW - 97 * HOUR }, srcs, NOW, 96)[0].stale, true);
  eq('1h is fresh', stalenessEvaluate_({ s1: NOW - 1 * HOUR }, srcs, NOW, 96)[0].stale, false);
  eq('never seen → stale', stalenessEvaluate_({}, srcs, NOW, 96)[0].stale, true);
  eq('never seen → ageHours null', stalenessEvaluate_({}, srcs, NOW, 96)[0].ageHours, null);
  eq('age is reported', stalenessEvaluate_({ s1: NOW - 10 * HOUR }, srcs, NOW, 96)[0].ageHours, 10);

  // --- THE false-positive regression: a normal Fri->Mon weekend gap ---
  const friday3am = new Date('2026-07-10T03:00:00+10:00').getTime();     // Fri 03:00 Sydney
  const monday11am = new Date('2026-07-13T11:00:00+10:00').getTime();    // Mon 11:00 Sydney
  eq('Fri 03:00 → Mon 11:00 is 80h', Math.round((monday11am - friday3am) / HOUR), 80);
  eq('a normal weekend gap does NOT alert',
    stalenessEvaluate_({ s1: friday3am }, srcs, monday11am, 96)[0].stale, false);

  const thursday3am = new Date('2026-07-09T03:00:00+10:00').getTime();
  eq('Thu 03:00 → Mon 11:00 is 104h', Math.round((monday11am - thursday3am) / HOUR), 104);
  eq('a genuine ~4-day outage DOES alert',
    stalenessEvaluate_({ s1: thursday3am }, srcs, monday11am, 96)[0].stale, true);

  // --- title is the idempotency key: stable, no varying number ---
  eq('title is stable', stalenessEventTitle_('square'), 'LEIBLE expense stale: square');
  check('title carries no age/number', !/\d/.test(stalenessEventTitle_('square')));
})();

(function testStalenessHeartbeat() {
  console.log('\nstaleness heartbeat:');

  scriptProps = {};
  stalenessStampHeartbeat_('food_dairy_co');
  check('heartbeat writes a Script Property',
    typeof scriptProps['LAST_INGEST_food_dairy_co'] === 'string');
  check('heartbeat value is a parseable timestamp',
    stalenessParseTs_(scriptProps['LAST_INGEST_food_dairy_co']) !== null);

  // The watchdog must NEVER break the thing it watches.
  const savedPS = global.PropertiesService;
  global.PropertiesService = { getScriptProperties: () => { throw new Error('props exploded'); } };
  let threw = false;
  try { stalenessStampHeartbeat_('square'); } catch (e) { threw = true; }
  check('a failing Properties store cannot throw out of the heartbeat', !threw);
  global.PropertiesService = savedPS;

  // doPost stamps on ingest — and MUST stamp even when everything dedups.
  currentSS = makeSpreadsheet();
  scriptProps = {};
  const payload = {
    source: 'food_dairy_co',
    extracted_at: '2026-07-16T11:00:00+10:00',
    rows: [{ date: '2026-07-15', supplier: 'FDCo', total: 10, invoice_ref: 'INV1', location: 'Leible York' }],
  };
  const r1 = JSON.parse(doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());
  eq('doPost ingested', r1.rowsAdded, 1);
  check('doPost stamped the heartbeat', 'LAST_INGEST_food_dairy_co' in scriptProps);

  // An all-duplicate re-post is a SUCCESSFUL run and must advance the heartbeat.
  scriptProps['LAST_INGEST_food_dairy_co'] = '2020-01-01T00:00:00+10:00';
  const r2 = JSON.parse(doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());
  eq('re-post is all duplicates', r2.rowsAdded, 0);
  check('an all-duplicate run STILL advances the heartbeat (kills the false positive)',
    stalenessParseTs_(scriptProps['LAST_INGEST_food_dairy_co']) >
    stalenessParseTs_('2020-01-01T00:00:00+10:00'));

  // An invalid payload is not a successful run.
  scriptProps = {};
  doPost({ postData: { contents: JSON.stringify({ source: 'food_dairy_co' }) } });
  check('an invalid payload stamps nothing', !('LAST_INGEST_food_dairy_co' in scriptProps));
})();

(function testStalenessSquareHeartbeatException() {
  console.log('\nstaleness square-token exception:');

  const REAL_URL_FETCH = global.UrlFetchApp;
  global.UrlFetchApp = {
    fetch: (url) => ({
      getResponseCode: () => 200,
      getContentText: () => (String(url).indexOf('/locations') !== -1
        ? JSON.stringify({ locations: [{ id: 'L1', name: 'S' }] })
        : JSON.stringify({ orders: [] })),
    }),
  };

  // A revoked token → every site skips → "ran fine, wrote nothing". Stamping
  // here would make the watchdog silent forever on a dead credential.
  withMockNow('2026-07-16T05:00:00Z', function () {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    const res = squareDailyPull();
    eq('no token → no site processed', res.sitesWithToken, 0);
    check('NO heartbeat when every Square site was skipped',
      !('LAST_INGEST_square' in scriptProps));
  });

  withMockNow('2026-07-16T05:00:00Z', function () {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    scriptProps[SQUARE_SITES[0].prop] = 'tok';
    const res = squareDailyPull();
    eq('one token → one site processed', res.sitesWithToken, 1);
    check('heartbeat stamped when a site really ran', 'LAST_INGEST_square' in scriptProps);
  });

  global.UrlFetchApp = REAL_URL_FETCH;
})();

(function testStalenessAlerts() {
  console.log('\nstaleness alerts:');

  function reset() {
    calendarEvents = [];
    calendarFailMode = null;
    currentSS = makeSpreadsheet();
    scriptProps = {};
  }

  // All sources stale (nothing ever seen) → one event each, orange + all-day.
  reset();
  let res = stalenessRun_(NOW);
  eq('every source is stale on a cold start', res.stale.length, STALENESS_SOURCES.length);
  eq('one event per stale source', res.eventsCreated, STALENESS_SOURCES.length);
  check('events are ORANGE', calendarEvents.every((e) => e._color === 'ORANGE'));
  check('events carry a description', calendarEvents.every((e) => e._description.length > 0));
  check('titles have no varying number', calendarEvents.every((e) => !/\d/.test(e._title)));

  // Idempotency: running again the same day must not duplicate events.
  const countAfterFirst = calendarEvents.length;
  res = stalenessRun_(NOW);
  eq('re-run creates no duplicate events', res.eventsCreated, 0);
  eq('event count unchanged', calendarEvents.length, countAfterFirst);

  // THE false-positive fix: a heartbeat alone clears staleness with ZERO new
  // sheet rows — which is exactly what a healthy but quiet connector looks like.
  reset();
  for (const s of STALENESS_SOURCES) {
    scriptProps['LAST_INGEST_' + s] = new Date(NOW - 1 * HOUR).toISOString();
  }
  res = stalenessRun_(NOW);
  eq('fresh heartbeats → nothing stale', res.stale.length, 0);
  eq('fresh heartbeats → no calendar events', res.eventsCreated, 0);
  eq('no events created at all', calendarEvents.length, 0);

  // The sheet alone can also prove freshness (before any heartbeat exists).
  reset();
  const supp = currentSS.getSheetByName('Suppliers');
  supp.appendRow(['2026-07-15', 'FDCo', 10, 'r1', 'York', 'food_dairy_co',
    new Date(NOW - 2 * HOUR).toISOString()]);
  res = stalenessRun_(NOW);
  const staleNames = res.stale.map((s) => s.source);
  check('a recent sheet row alone marks that source fresh',
    staleNames.indexOf('food_dairy_co') === -1);
  check('other sources remain stale', staleNames.indexOf('ordermentum') !== -1);

  // Heartbeat WINS over an older sheet row (the run happened, dedup wrote nothing).
  reset();
  const supp2 = currentSS.getSheetByName('Suppliers');
  supp2.appendRow(['2026-06-01', 'FDCo', 10, 'r1', 'York', 'food_dairy_co',
    new Date(NOW - 300 * HOUR).toISOString()]);           // ancient row
  scriptProps['LAST_INGEST_food_dairy_co'] = new Date(NOW - 1 * HOUR).toISOString();  // ran 1h ago
  res = stalenessRun_(NOW);
  check('a fresh heartbeat overrides an ancient sheet row',
    res.stale.map((s) => s.source).indexOf('food_dairy_co') === -1);

  // Calendar unavailable → degrade to log-only, never throw.
  reset();
  calendarFailMode = 'all';
  let threw = false;
  try { res = stalenessRun_(NOW); } catch (e) { threw = true; }
  check('a broken calendar does not throw', !threw);
  eq('a broken calendar creates no events', res.eventsCreated, 0);
  check('staleness is still reported when the calendar is down', res.stale.length > 0);

  // Falls back to the default calendar if getCalendarById returns null.
  reset();
  calendarFailMode = 'byId';
  res = stalenessRun_(NOW);
  check('falls back to the default calendar', res.eventsCreated > 0);
})();

/* ------------------------------------------------------------------ *
 * fix-silent-ingest-failures step 2 — Sales dedup key coercion
 *
 * SALES_KEY_COLS keys on the date column, but rowKey_ stringified it with a
 * bare String(rowArray[col]) — no coerceDateStr_. A Date-typed cell (what a
 * real Sheet hands back on read) and its 'YYYY-MM-DD' string therefore
 * produced DIFFERENT keys, so a re-run's dedup lookup missed the row it just
 * wrote and appended a duplicate, double-counting Sales gross on every
 * re-run / backfill / overlapping trigger.
 * ------------------------------------------------------------------ */

(function testSalesDedupKeyCoercion() {
  console.log('\nsales dedup — rowKey_ coerces Date-typed key cols:');

  // Key parity: a Date-typed date col and its YYYY-MM-DD string must yield
  // the SAME key, or the dedup lookup silently misses on re-run.
  eq('rowKey_: Date-typed date col matches its YYYY-MM-DD string',
    rowKey_([new Date(2026, 6, 15), 'York'], SALES_KEY_COLS),
    rowKey_(['2026-07-15', 'York'], SALES_KEY_COLS));

  // Dedup on re-run — the real symptom. First write appends; the mock
  // round-trips the stored date string to a Date (sheetCoerceOnWrite),
  // exactly as a live Sheet does. A second write of the same logical row
  // (a PRIOR day, so it's eligible for correction — §1f) must be
  // recognised as the same key and update in place, not append a duplicate.
  // Pin 'today' so the row's date ('2026-07-15') is unambiguously a prior day.
  withMockNow('2026-07-16T05:00:00Z', function () {
    freshSheets();
    var salesSheet = currentSS.getSheetByName('Sales');
    var row1 = ['2026-07-15', 'York', 100, 'square', '2026-07-15T23:59:00+10:00'];
    var row2 = ['2026-07-15', 'York', 100, 'square', '2026-07-16T00:05:00+10:00'];

    var firstRes = appendSalesRow_(salesSheet, row1);
    eq('first appendSalesRow_ call appends', firstRes, { appended: true, updated: false });
    eq('sheet has header + 1 row after first append', salesSheet._rows.length, 2);

    var secondRes = appendSalesRow_(salesSheet, row2);
    eq('re-run on a PRIOR day is recognised as the same key and updated in place',
      secondRes, { appended: false, updated: true });
    eq('sheet row count unchanged (updated in place, not appended)', salesSheet._rows.length, 2);
  });

  // Non-date passthrough: the location column's contribution to the key is
  // unchanged by the fix — differing locations still produce different
  // keys, and casing/whitespace on a non-date column still normalizes.
  check('rowKey_: differing location produces a different key',
    rowKey_(['2026-07-15', 'York'], SALES_KEY_COLS) !==
    rowKey_(['2026-07-15', 'Melbourne'], SALES_KEY_COLS));
  eq('rowKey_: location casing/whitespace still normalizes',
    rowKey_(['2026-07-15', 'York'], SALES_KEY_COLS),
    rowKey_(['2026-07-15', ' york '], SALES_KEY_COLS));
})();

/* ------------------------------------------------------------------ *
 * Phase 1 — department migration (idempotent, dry-run-by-default)
 * ------------------------------------------------------------------ */

// Legacy (pre-migration) header shapes — literal, deliberately NOT read off
// globalThis, so a migration test always exercises a genuinely old-shaped
// fixture even after Code.gs's own headers gain `department`.
const OLD_SUPPLIERS_HEADERS = ['date', 'supplier', 'total', 'invoice_ref', 'location', 'source', 'extracted_at'];
const OLD_SALES_HEADERS = ['date', 'location', 'gross_sales', 'source', 'extracted_at'];
const OLD_LABOUR_HEADERS = ['week_start', 'week_end', 'location', 'total', 'iso_week', 'pulled_at'];
const OLD_SUMMARY_HEADERS = ['week_start', 'week_end', 'supplier', 'location', 'total_spend', 'summarized_at'];

(function testMigrateAddDepartment() {
  console.log('\nmigrateAddDepartment_ / sweepBlankDepartments_:');

  function seedLegacyHub() {
    currentSS = makeSpreadsheet();
    currentSS._sheets['Suppliers'] = makeSheet(OLD_SUPPLIERS_HEADERS);
    currentSS._sheets['Sales'] = makeSheet(OLD_SALES_HEADERS);
    currentSS._sheets['_staging'] = makeSheet(OLD_SUPPLIERS_HEADERS);
    currentSS._sheets['_archive'] = makeSheet(OLD_SUPPLIERS_HEADERS);
    currentSS._sheets['Labour'] = makeSheet(OLD_LABOUR_HEADERS);

    currentSS.getSheetByName('Suppliers').appendRow(['2026-06-15', 'Food and Dairy Co', 100, 'A1', 'York St', 'food_dairy_co', 'x']);
    currentSS.getSheetByName('Suppliers').appendRow(['2026-06-16', 'Butterboy', 80, 'B1', 'York St', 'ordermentum', 'x']);
    currentSS.getSheetByName('_staging').appendRow(['2026-06-15', 'Test Co', 10, 'T1', '', 'test', 'x']);
    currentSS.getSheetByName('_archive').appendRow(['2025-01-01', 'Old Co', 50, 'OLD-1', '', 'test', 'x']);
    currentSS.getSheetByName('Sales').appendRow(['2026-06-15', 'York', 500, 'square', 'x']);
    currentSS.getSheetByName('Labour').appendRow(['2026-06-15', '2026-06-21', 'york', 4830.14, '2026-W25', 'x']);
  }

  // dryRun default → returns a report and writes NOTHING.
  seedLegacyHub();
  var beforeBytes = JSON.stringify(currentSS.getSheetByName('Suppliers')._rows);
  var dry = migrateAddDepartment_();
  eq('dry run: Suppliers headerAction=add (would add)', dry.Suppliers.headerAction, 'add');
  eq('dry run: Suppliers blanksFilled=2 (both rows would be filled)', dry.Suppliers.blanksFilled, 2);
  eq('dry run writes NOTHING (sheet bytes unchanged)',
    JSON.stringify(currentSS.getSheetByName('Suppliers')._rows), beforeBytes);
  check('dry run creates no Revenue tab', !currentSS.getSheetByName('Revenue'));

  // Apply: header gains department, every data row 'Cafe', row count unchanged.
  seedLegacyHub();
  var beforeRowCount = currentSS.getSheetByName('Suppliers')._rows.length;
  var applied = migrateAddDepartment_(false);
  eq('apply: Suppliers headerAction=add', applied.Suppliers.headerAction, 'add');
  var suppRows = currentSS.getSheetByName('Suppliers').getDataRange().getValues();
  eq('apply: header gains department', suppRows[0][7], 'department');
  eq('apply: row count unchanged', suppRows.length, beforeRowCount);
  eq('apply: data row 1 backfilled to Cafe', suppRows[1][7], 'Cafe');
  eq('apply: data row 2 backfilled to Cafe', suppRows[2][7], 'Cafe');

  // _staging and _archive are migrated too.
  var stagingRows = currentSS.getSheetByName('_staging').getDataRange().getValues();
  eq('_staging header gains department', stagingRows[0][7], 'department');
  eq('_staging data backfilled to Cafe', stagingRows[1][7], 'Cafe');
  var archiveRows = currentSS.getSheetByName('_archive').getDataRange().getValues();
  eq('_archive header gains department', archiveRows[0][7], 'department');
  eq('_archive data backfilled to Cafe', archiveRows[1][7], 'Cafe');

  // Sales and Labour too.
  var salesRows = currentSS.getSheetByName('Sales').getDataRange().getValues();
  eq('Sales header gains department', salesRows[0][5], 'department');
  eq('Sales data backfilled to Cafe', salesRows[1][5], 'Cafe');
  var labourRows = currentSS.getSheetByName('Labour').getDataRange().getValues();
  eq('Labour header gains department', labourRows[0][6], 'department');
  eq('Labour data backfilled to Cafe', labourRows[1][6], 'Cafe');

  // Revenue tab created with exactly REVENUE_HEADERS.
  var revSheet = currentSS.getSheetByName('Revenue');
  check('apply creates the Revenue tab', !!revSheet);
  eq('Revenue tab has exactly REVENUE_HEADERS', revSheet.getDataRange().getValues()[0], REVENUE_HEADERS);

  // Run twice → second reports skipped, no duplicate column, no data change.
  var afterFirstApply = JSON.stringify(currentSS.getSheetByName('Suppliers')._rows);
  var second = migrateAddDepartment_(false);
  eq('second run: Suppliers headerAction=present (skipped)', second.Suppliers.headerAction, 'present');
  eq('second run: no data change',
    JSON.stringify(currentSS.getSheetByName('Suppliers')._rows), afterFirstApply);
  eq('second run: exactly one department column in the header',
    currentSS.getSheetByName('Suppliers').getDataRange().getValues()[0]
      .filter((h) => h === 'department').length, 1);

  // Row already carrying a real department value → migration leaves it alone
  // (blank-only fill).
  seedLegacyHub();
  var suppWithDept = currentSS.getSheetByName('Suppliers');
  suppWithDept.appendRow(['2026-06-17', 'Kent Paper', 30, 'K1', '', 'kent_paper', 'x', 'Roastery']);
  migrateAddDepartment_(false);
  var rowsAfter = suppWithDept.getDataRange().getValues();
  eq('blank-only fill: pre-set Roastery value untouched', rowsAfter[3][7], 'Roastery');
  eq('blank-only fill: blank rows still backfilled to Cafe', rowsAfter[1][7], 'Cafe');

  // Sweep works after migration: append a 7-element row directly (simulating
  // the old deployed code mid-window), run sweepBlankDepartments_(false) →
  // that row reads Cafe, every other row unchanged, row count unchanged.
  // Guards against the sweep being a silent no-op.
  seedLegacyHub();
  migrateAddDepartment_(false);
  var suppMidWindow = currentSS.getSheetByName('Suppliers');
  suppMidWindow.appendRow(['2026-06-18', 'Mayers', 200, 'M1', '', 'mayers', 'x']); // 7 elements, no department
  var beforeSweepCount = suppMidWindow._rows.length;
  var noopMigrate = migrateAddDepartment_(false);
  eq('migrateAddDepartment_ re-run short-circuits on the header guard (sweeps nothing)',
    noopMigrate.Suppliers.blanksFilled, 0);
  eq('...so the mid-window row is still blank',
    suppMidWindow.getDataRange().getValues()[3][7], undefined);
  var sweep = sweepBlankDepartments_(false);
  eq('sweep fills exactly the one blank row', sweep.Suppliers.blanksFilled, 1);
  var afterSweep = suppMidWindow.getDataRange().getValues();
  eq('mid-window row now reads Cafe', afterSweep[3][7], 'Cafe');
  eq('every other row unchanged', afterSweep[1][7], 'Cafe');
  eq('row count unchanged by the sweep', suppMidWindow._rows.length, beforeSweepCount);

  // Dry-run and apply reports share a shape.
  seedLegacyHub();
  var dryReport = migrateAddDepartment_();
  var applyReport = migrateAddDepartment_(false);
  eq('dry-run report has {tab, headerAction, blanksFilled} shape',
    Object.keys(dryReport.Suppliers).sort(), ['blanksFilled', 'headerAction', 'tab']);
  eq('apply report has the SAME shape',
    Object.keys(applyReport.Suppliers).sort(), ['blanksFilled', 'headerAction', 'tab']);

  // Summary tab built with the OLD 6 headers → after migration, doGet returns
  // department, kind and total. Regression guard for the summaryDataToObjects_ trap.
  currentSS = makeSpreadsheet();
  var summ = makeSheet(OLD_SUMMARY_HEADERS);
  summ.appendRow(['2026-06-15', '2026-06-21', 'Food and Dairy Co', 'York St', 300, 'TS']);
  currentSS._sheets['Summary'] = summ;
  migrateAddDepartment_(false);
  scriptProps = { API_READ_TOKEN: 'tok' };
  var got = JSON.parse(doGet({ parameter: { token: 'tok', from: '2026-06-15', to: '2026-06-21' } }).getContent());
  eq('post-migration doGet returns department', got.rows[0].department, 'Cafe');
  eq('post-migration doGet returns kind', got.rows[0].kind, 'spend');
  eq('post-migration doGet returns total', got.rows[0].total, 300);
})();

/* ------------------------------------------------------------------ *
 * Phase 1 — ingest: legacy back-compat, revenue kind, upsert
 * ------------------------------------------------------------------ */

(function testIngestUpsertAndRevenue() {
  console.log('\ningest — legacy back-compat, revenue kind, upsert:');

  // Legacy payload (no kind, no department) → lands in Suppliers,
  // department='Cafe', columns 0-6 byte-identical to pre-change behaviour.
  freshSheets();
  var legacyRes = doPostJson({ source: 'food_dairy_co', extracted_at: 'TS', rows: [
    { date: '2026-07-01', total: 45, invoice_ref: 'LEG-1', location: 'York St' }
  ] });
  eq('legacy payload → ok', legacyRes.result, 'ok');
  var legacyRow = currentSS.getSheetByName('Suppliers').getDataRange().getValues()[1];
  eq('legacy payload: columns 0-6 byte-identical to pre-change shape',
    [cellDate(legacyRow[0])].concat(legacyRow.slice(1, 7)),
    ['2026-07-01', 'Food and Dairy Co', 45, 'LEG-1', 'York St', 'food_dairy_co', 'TS']);
  eq('legacy payload: department defaults to Cafe', legacyRow[7], 'Cafe');

  // kind:'revenue' → lands in Revenue; Suppliers row count unchanged.
  freshSheets();
  var suppBefore = currentSS.getSheetByName('Suppliers').getDataRange().getValues().length;
  var revRes = doPostJson({
    kind: 'revenue', source: 'wholesale_app', extracted_at: 'TS', rows: [
      { date: '2026-07-01', channel: 'wholesale', customer: 'Acme Cafe', amount: 500, order_ref: 'ORD-1', department: 'Roastery' }
    ]
  });
  eq('revenue payload → ok', revRes.result, 'ok');
  eq('revenue payload → rowsAdded 1', revRes.rowsAdded, 1);
  var revRow = currentSS.getSheetByName('Revenue').getDataRange().getValues()[1];
  eq('revenue row lands in Revenue, in REVENUE_HEADERS order',
    [cellDate(revRow[0])].concat(revRow.slice(1)),
    ['2026-07-01', 'Roastery', 'wholesale', 'Acme Cafe', 500, 'ORD-1', 'wholesale_app', 'TS']);
  eq('Suppliers row count unchanged by a revenue POST',
    currentSS.getSheetByName('Suppliers').getDataRange().getValues().length, suppBefore);

  // Re-POST identical supplier rows → rowsAdded:0, duplicatesSkipped:n.
  freshSheets();
  var payload = { source: 'food_dairy_co', extracted_at: 'TS', rows: [
    { date: '2026-07-01', total: 45, invoice_ref: 'DUP-1', location: 'York St' }
  ] };
  doPostJson(payload);
  var repost = doPostJson(payload);
  eq('re-POST identical rows → rowsAdded 0', repost.rowsAdded, 0);
  eq('re-POST identical rows → duplicatesSkipped 1', repost.duplicatesSkipped, 1);

  // Upsert: ORD-1182 at 340.00 then 300.00 → row count unchanged, amount
  // 300.00, extracted_at updated, rowsUpdated:1.
  freshSheets();
  doPostJson({ source: 'wholesale_app', extracted_at: 'T1', rows: [
    { date: '2026-07-01', total: 340.00, invoice_ref: 'ORD-1182' }
  ] });
  var upsertRes = doPostJson({ source: 'wholesale_app', extracted_at: 'T2', rows: [
    { date: '2026-07-01', total: 300.00, invoice_ref: 'ORD-1182' }
  ] });
  eq('upsert changed amount → rowsUpdated 1', upsertRes.rowsUpdated, 1);
  eq('upsert changed amount → rowsAdded 0', upsertRes.rowsAdded, 0);
  var suppData = currentSS.getSheetByName('Suppliers').getDataRange().getValues();
  eq('upsert: row count unchanged (header + 1)', suppData.length, 2);
  eq('upsert: amount updated to 300', suppData[1][2], 300);
  eq('upsert: extracted_at updated', suppData[1][6], 'T2');

  // Upsert with unchanged amount → duplicatesSkipped:1, rowsUpdated:0, no write.
  var noopRes = doPostJson({ source: 'wholesale_app', extracted_at: 'T3', rows: [
    { date: '2026-07-01', total: 300.00, invoice_ref: 'ORD-1182' }
  ] });
  eq('unchanged-amount re-post → duplicatesSkipped 1', noopRes.duplicatesSkipped, 1);
  eq('unchanged-amount re-post → rowsUpdated 0', noopRes.rowsUpdated, 0);
  eq('unchanged-amount re-post: extracted_at NOT overwritten',
    currentSS.getSheetByName('Suppliers').getDataRange().getValues()[1][6], 'T2');

  // Upsert across a Date-valued key column → still matches (coerceDateStr_
  // guard reused verbatim by rowKey_ on the new upsertRows_ path).
  freshSheets();
  (function () {
    var sheet = currentSS.getSheetByName('Sales');
    var first = normalizeSalesRow_('2026-07-01', 'York', 100, 'square', 'T1', 'Cafe');
    upsertRows_(sheet, [first], SALES_KEY_COLS, 2, 4);
    // The sheet round-trips the date string to a Date object on write
    // (sheetCoerceOnWrite); the re-post below sends the SAME date as a plain
    // string and the key must still match against that Date cell.
    var second = normalizeSalesRow_('2026-07-01', 'York', 150, 'square', 'T2', 'Cafe');
    var res = upsertRows_(sheet, [second], SALES_KEY_COLS, 2, 4);
    eq('upsert across a Date-valued key column still matches (updates, not appends)',
      res, { rowsAdded: 0, rowsUpdated: 1, duplicatesSkipped: 0 });
    eq('sheet row count unchanged', sheet._rows.length, 2);
    eq('amount updated via the Date-keyed match', sheet.getDataRange().getValues()[1][2], 150);
  })();

  // validateIngest_: revenue row validation + department guard.
  (function () {
    var base = { kind: 'revenue', source: 'wholesale_app', extracted_at: 'TS' };
    check('revenue row missing order_ref → rejected',
      !validateIngest_(Object.assign({}, base, { rows: [{ date: '2026-07-01', channel: 'wholesale', customer: 'Acme', amount: 10 }] })).ok);
    check('revenue row non-numeric amount → rejected',
      !validateIngest_(Object.assign({}, base, { rows: [{ date: '2026-07-01', channel: 'wholesale', customer: 'Acme', amount: 'abc', order_ref: 'O1' }] })).ok);
    check('revenue row missing customer → rejected',
      !validateIngest_(Object.assign({}, base, { rows: [{ date: '2026-07-01', channel: 'wholesale', amount: 10, order_ref: 'O1' }] })).ok);
    var refMsg = validateIngest_(Object.assign({}, base, { rows: [{ date: '2026-07-01', channel: 'wholesale', customer: 'Acme', order_ref: 'O1' }] }));
    check('rejection message names the row index', refMsg.message.indexOf('row 0') !== -1);
    check("department:'Roastry' (typo) → rejected",
      !validateIngest_({ source: 'x', extracted_at: 'TS', rows: [{ date: '2026-07-01', total: 5, invoice_ref: 'X1', department: 'Roastry' }] }).ok);
  })();
})();

/* ------------------------------------------------------------------ *
 * Phase 1 — Sales/Labour/Summary: department + upsert reach
 * ------------------------------------------------------------------ */

(function testSalesLabourSummaryDepartment() {
  console.log('\nSales/Labour/Summary — department + upsert reach:');

  // squareDailyPull row lands with department='Cafe' — the square.gs:91
  // bare-literal guard.
  withMockNow('2026-07-16T05:00:00Z', function () {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    scriptProps[SQUARE_SITES[0].prop] = 'tok';
    global.UrlFetchApp = {
      fetch: (url) => ({
        getResponseCode: () => 200,
        getContentText: () => (String(url).indexOf('/locations') !== -1
          ? JSON.stringify({ locations: [{ id: 'L1', name: 'S' }] })
          : JSON.stringify({ orders: [] })),
      }),
    };
    squareDailyPull();
    var rows = currentSS.getSheetByName('Sales').getDataRange().getValues();
    eq('squareDailyPull row department = Cafe', rows[1][5], 'Cafe');
  });

  // Post-migration labourWeeklyPull_: department='Cafe' on the Labour tab AND
  // on its Summary row (kind='spend'), and it survives &department=Cafe.
  (function () {
    currentSS = makeSpreadsheet();
    scriptProps = { LABOUR_SHEET_ID: 'labour-sheet-id', API_READ_TOKEN: 'tok' };
    var src = currentSS.insertSheet('LABOUR_COST');
    src.appendRow(['week_start', 'week_end', 'location', 'total', 'iso_week', 'pulled_at']);
    src.appendRow(['2026-06-15', '2026-06-21', 'york', 4830.14, '2026-W25', 'x']);

    weeklySummarize('2026-06-15');
    eq('labour tab row lands with department Cafe',
      currentSS.getSheetByName('Labour').getDataRange().getValues()[1][6], 'Cafe');

    var summRows = currentSS.getSheetByName('Summary').getDataRange().getValues();
    var labourSummRow = summRows.filter((r) => r[2] === 'Labour')[0];
    eq('labour Summary row: department Cafe', labourSummRow[6], 'Cafe');
    eq('labour Summary row: kind spend', labourSummRow[7], 'spend');

    var got = JSON.parse(doGet({ parameter: { token: 'tok', from: '2026-06-15', to: '2026-06-21', department: 'Cafe' } }).getContent());
    check('labour survives &department=Cafe filter', got.rows.some((r) => r.supplier === 'Labour'));
  })();

  // appendSalesRow_ same-day re-run with a different gross → skipped, not overwritten.
  withMockNow('2026-07-16T05:00:00Z', function () {
    freshSheets();
    var sheet = currentSS.getSheetByName('Sales');
    var todayRow1 = normalizeSalesRow_(todayStr_(), 'York', 100, 'square', 'T1', 'Cafe');
    appendSalesRow_(sheet, todayRow1);
    var todayRow2 = normalizeSalesRow_(todayStr_(), 'York', 999, 'square', 'T2', 'Cafe');
    var res = appendSalesRow_(sheet, todayRow2);
    eq('same-day re-run with a different gross is skipped', res, { appended: false, updated: false });
    eq('same-day row NOT overwritten', sheet.getDataRange().getValues()[1][2], 100);
  });

  // End-to-end upsert reach: summarize a week, upsert a changed amount into
  // Suppliers, re-summarize → Summary reflects the new total, row count unchanged.
  (function () {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    var supp = currentSS.getSheetByName('Suppliers');
    supp.appendRow(['2026-06-17', 'Food and Dairy Co', 100, 'E2E-1', 'York St', 'food_dairy_co', 'x', 'Cafe']);

    var first = weeklySummarize('2026-06-15');
    eq('first summarize adds 1 Summary row', first.summariesAdded, 1);
    var summBefore = currentSS.getSheetByName('Summary').getDataRange().getValues();
    eq('Summary total before amendment', summBefore[1][4], 100);

    ingestSupplierRows('food_dairy_co',
      [{ date: '2026-06-17', total: 175, invoice_ref: 'E2E-1', location: 'York St' }], 'x2', supp);

    var second = weeklySummarize('2026-06-15');
    eq('re-summarize reaches the amended amount (summariesUpdated=1)', second.summariesUpdated, 1);
    var summAfter = currentSS.getSheetByName('Summary').getDataRange().getValues();
    eq('Summary row count unchanged', summAfter.length, summBefore.length);
    eq('Summary total reflects the amended amount', summAfter[1][4], 175);
  })();

  // Mixed Cafe spend + Roastery revenue → distinct Summary rows, correct
  // kind, revenue never subtracted from spend.
  (function () {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    var supp = currentSS.getSheetByName('Suppliers');
    supp.appendRow(['2026-06-17', 'Food and Dairy Co', 100, 'MX-1', 'York St', 'food_dairy_co', 'x', 'Cafe']);
    var rev = ensureSheet(currentSS, 'Revenue', REVENUE_HEADERS);
    rev.appendRow(['2026-06-18', 'Roastery', 'wholesale', 'Acme Cafe', 500, 'MX-ORD-1', 'wholesale_app', 'x']);

    var res = weeklySummarize('2026-06-15');
    eq('both a spend row and a revenue row are summarized', res.summariesAdded, 2);
    var rows = currentSS.getSheetByName('Summary').getDataRange().getValues().slice(1);
    var spendRow = rows.filter((r) => r[7] === 'spend')[0];
    var revenueRow = rows.filter((r) => r[7] === 'revenue')[0];
    eq('spend row: department Cafe, total 100', spendRow[6] + '|' + spendRow[4], 'Cafe|100');
    eq('revenue row: department Roastery, total 500', revenueRow[6] + '|' + revenueRow[4], 'Roastery|500');
    check('revenue never netted against spend (two distinct rows, not one combined)', rows.length === 2);
  })();

  // doGet &department=Roastery → only Roastery rows; absent → all rows.
  (function () {
    currentSS = makeSpreadsheet();
    scriptProps = { API_READ_TOKEN: 'tok' };
    var s = currentSS.insertSheet('Summary');
    s.appendRow(SUMMARY_HEADERS);
    s.appendRow(['2026-06-15', '2026-06-21', 'Food and Dairy Co', 'York St', 100, 'TS', 'Cafe', 'spend']);
    s.appendRow(['2026-06-15', '2026-06-21', 'Acme Cafe', 'wholesale', 500, 'TS', 'Roastery', 'revenue']);

    var filtered = JSON.parse(doGet({ parameter: { token: 'tok', from: '2026-06-15', to: '2026-06-21', department: 'Roastery' } }).getContent());
    eq('&department=Roastery returns only Roastery rows', filtered.count, 1);
    eq('...and it is the Roastery row', filtered.rows[0].department, 'Roastery');

    var unfiltered = JSON.parse(doGet({ parameter: { token: 'tok', from: '2026-06-15', to: '2026-06-21' } }).getContent());
    eq('no department filter → all rows', unfiltered.count, 2);
  })();
})();

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
