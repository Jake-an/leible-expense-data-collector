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

function makeSheet(headers, name, globalWriteLog) {
  // A real insertSheet() yields an EMPTY sheet; ensureSheet then appends the
  // header row. Seeding [[]] here gave every inserted tab a phantom blank row 1,
  // shifting headers to row 2 and all data down one.
  const rows = (headers && headers.length) ? [headers.slice()] : [];
  const writeCalls = [];
  // Records multi-row/whole-row write calls (appendRow, setValues) so tests
  // can assert HOW a batch was written — one setValues() block vs N
  // appendRow() calls — not just the resulting sheet state, which the two
  // approaches make identical. Per-cell setValue() is not recorded: no test
  // needs its call count.
  function recordWrite(type, numRows) {
    const entry = { type, sheet: name, numRows };
    writeCalls.push(entry);
    if (globalWriteLog) globalWriteLog.push(entry);
  }
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
  //
  // Real GAS throws when numRows/numCols is present and < 1 — a call with
  // only (row, col) stays legal (no geometry given, nothing to validate).
  // Every geometry call is also recorded (with any style calls applied to
  // it) so tests can assert both "no invalid geometry was ever requested"
  // and "the header range was actually styled", not just resulting state.
  const rangeCalls = [];
  function makeRangeChain(row, col, numRows, numCols) {
    if (numRows !== undefined && numRows < 1) {
      throw new Error('The number of rows in the range must be at least 1');
    }
    if (numCols !== undefined && numCols < 1) {
      throw new Error('The number of columns in the range must be at least 1');
    }
    const call = { row, col, numRows, numCols, background: null, fontColor: null, fontWeight: null };
    rangeCalls.push(call);
    const chain = {
      setBackground(c) { call.background = c; return chain; },
      setFontColor(c) { call.fontColor = c; return chain; },
      setFontWeight(w) { call.fontWeight = w; return chain; },
      setValue(v) { setCell(row - 1, col - 1, v); return chain; },
      setValues(vals) {
        vals.forEach((rowVals, ri) => {
          rowVals.forEach((v, ci) => setCell(row - 1 + ri, col - 1 + ci, v));
        });
        recordWrite('setValues', vals.length);
        return chain;
      },
    };
    return chain;
  }
  const frozenRowsCalls = [];
  return {
    _rows: rows,
    appendRow: (a) => { rows.push(a.map(sheetCoerceOnWrite)); recordWrite('appendRow', 1); },
    deleteRow: (rowNum) => rows.splice(rowNum - 1, 1),
    // Real Sheet#clearContents wipes every cell (incl. the header row) but
    // leaves the sheet object itself intact — a rebuilt report has no fixed
    // header, so the mock just empties the row store.
    clearContents: () => { const n = rows.length; rows.length = 0; recordWrite('clearContents', n); },
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    getRange: (row, col, numRows, numCols) => makeRangeChain(row, col, numRows, numCols),
    getRangeCalls: () => rangeCalls.slice(),
    getLastRow: () => rows.length,
    getWriteCalls: () => writeCalls.slice(),
    clearWriteCalls: () => writeCalls.splice(0),
    setFrozenRows: (n) => { frozenRowsCalls.push(n); },
    getFrozenRowsCalls: () => frozenRowsCalls.slice(),
  };
}

function makeSpreadsheet() {
  const writeLog = [];
  const sheets = {
    Suppliers: makeSheet(SUPPLIERS_HEADERS, 'Suppliers', writeLog),
    Sales: makeSheet(SALES_HEADERS, 'Sales', writeLog),
  };
  return {
    _sheets: sheets,
    _writeLog: writeLog,
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet([], n, writeLog); return sheets[n]; },
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
// Captures Logger.log() calls so tests can assert a degraded-mode warning was
// actually emitted (step 1: weeks_complete absent + rows present), not just
// that the function didn't throw.
let loggedMessages = [];
global.Logger = { log: (msg) => { loggedMessages.push(String(msg)); } };
function lastLoggedMessages() { return loggedMessages; }
function clearLoggedMessages() { loggedMessages = []; }
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
  if (pattern === 'yyyy-MM') return ymd.slice(0, 7);
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
// Trigger store: newTrigger(handler) now records the chain calls made on it
// (weekday/hour/timezone/etc.) and create() actually appends to a list that
// getProjectTriggers()/deleteTrigger() operate on. Previously getProjectTriggers
// always returned [] and create() was a no-op, so every installer's own
// dedup-by-handler loop ran against an eternally-empty list — idempotency was
// never actually exercised, only "does not throw". Needed to make the shopSpend
// watchdog installer's idempotency test (and its exact schedule) assertable.
let scriptTriggers = [];
global.ScriptApp = {
  getProjectTriggers: () => scriptTriggers.slice(),
  newTrigger: (handlerName) => {
    const cfg = { handler: handlerName, weekDay: null, hour: null, everyDaysN: null, monthDay: null, timezone: null };
    const chain = {
      timeBased: () => chain,
      onWeekDay: (wd) => { cfg.weekDay = wd; return chain; },
      atHour: (h) => { cfg.hour = h; return chain; },
      everyDays: (n) => { cfg.everyDaysN = n; return chain; },
      onMonthDay: (md) => { cfg.monthDay = md; return chain; },
      inTimezone: (tz) => { cfg.timezone = tz; return chain; },
      create: () => {
        const trigger = { getHandlerFunction: () => cfg.handler, _cfg: cfg };
        scriptTriggers.push(trigger);
        return trigger;
      },
    };
    return chain;
  },
  deleteTrigger: (t) => {
    const idx = scriptTriggers.indexOf(t);
    if (idx !== -1) scriptTriggers.splice(idx, 1);
  },
  WeekDay: { MONDAY: 2, TUESDAY: 3 }
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
load('orderapp.gs');
load('mayers.gs');
load('staleness.gs');
load('recurring.gs');
load('roastery_email.gs');
load('shopspend.gs');

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

console.log('mock harness: getRange rejects invalid geometry (shopspend-hardening step 0)');
(function () {
  // Meta-assertion, mirrors the "getRange/setValue can actually fail" block
  // above: this is the case that proves the geometry guard is not vacuous.
  // Before this phase getRange(row, col) silently discarded numRows/numCols,
  // which is exactly why ensureSheet(ss, name, []) crashing real GAS on
  // getRange(1, 1, 1, 0) survived 705 green node tests.
  freshSheets();
  var sheet = currentSS.getSheetByName('Suppliers');

  var threwZeroCols = false;
  try {
    sheet.getRange(1, 1, 1, 0);
  } catch (err) {
    threwZeroCols = true;
  }
  check('getRange(1, 1, 1, 0) throws — numCols < 1 mirrors real GAS', threwZeroCols);

  var threwZeroRows = false;
  try {
    sheet.getRange(1, 1, 0, 1);
  } catch (err) {
    threwZeroRows = true;
  }
  check('getRange(1, 1, 0, 1) throws — numRows < 1 mirrors real GAS', threwZeroRows);

  var threwBare = false;
  try {
    sheet.getRange(2, 1);
  } catch (err) {
    threwBare = true;
  }
  check('getRange(row, col) with no numRows/numCols stays legal', !threwBare);

  var threwValid = false;
  try {
    sheet.getRange(1, 1, 1, 3);
  } catch (err) {
    threwValid = true;
  }
  check('getRange(row, col, numRows, numCols) with valid (>= 1) geometry stays legal', !threwValid);
})();

console.log('ensureSheet — empty headers on a missing tab (shopspend-hardening step 0)');
(function () {
  // ShopSpend Report is deliberately headerless — ensureSheet must still
  // create + return the tab, and must never ask the mock for an invalid
  // (numCols < 1) range while doing it.
  freshSheets();
  var sheet = ensureSheet(currentSS, 'ShopSpend Report', []);
  check('ensureSheet(ss, name, []) returns a sheet object', !!sheet);
  check('the tab now exists under that name',
    currentSS.getSheetByName('ShopSpend Report') === sheet);

  var invalidCalls = sheet.getRangeCalls().filter(function (c) {
    return (c.numCols !== undefined && c.numCols < 1) ||
           (c.numRows !== undefined && c.numRows < 1);
  });
  eq('ensureSheet(ss, name, []) never issues a getRange call with invalid (< 1) geometry',
    invalidCalls.length, 0);

  // Headerless creation applies none of the header styling/freezing — that
  // only makes sense when there is a header row to style.
  eq('no range on the new headerless sheet was styled', sheet.getRangeCalls().filter(function (c) {
    return c.background !== null || c.fontColor !== null || c.fontWeight !== null;
  }).length, 0);
  eq('setFrozenRows was never called for a headerless tab', sheet.getFrozenRowsCalls().length, 0);
  eq('the new sheet has no data rows (nothing was appended)',
    sheet.getDataRange().getValues().length, 0);
})();

console.log('ensureSheet — non-empty headers, byte-identical to today (shopspend-hardening step 0)');
(function () {
  freshSheets();
  var sheet = ensureSheet(currentSS, 'HeaderedTab', SUPPLIERS_HEADERS);

  eq('header row is appended as row 1',
    sheet.getDataRange().getValues()[0], SUPPLIERS_HEADERS);

  var headerRangeCalls = sheet.getRangeCalls().filter(function (c) {
    return c.row === 1 && c.col === 1 && c.numRows === 1 && c.numCols === SUPPLIERS_HEADERS.length;
  });
  check('getRange(1, 1, 1, headers.length) was called for the header row',
    headerRangeCalls.length === 1);
  if (headerRangeCalls.length === 1) {
    var styled = headerRangeCalls[0];
    eq('header range background is #a5b89d', styled.background, '#a5b89d');
    eq('header range font color is white', styled.fontColor, '#ffffff');
    eq('header range font weight is bold', styled.fontWeight, 'bold');
  }
  eq('setFrozenRows(1) was called exactly once', sheet.getFrozenRowsCalls(), [1]);
})();

console.log('ensureSheet — existing tab is untouched (shopspend-hardening step 0)');
(function () {
  freshSheets();
  // First call creates + styles the tab.
  var created = ensureSheet(currentSS, 'HeaderedTab2', SUPPLIERS_HEADERS);
  created.clearWriteCalls();

  // Second call against the now-existing tab must not re-append or re-style.
  var again = ensureSheet(currentSS, 'HeaderedTab2', SUPPLIERS_HEADERS);
  check('the same sheet object is returned', again === created);
  eq('no new write calls (no re-append) on an existing tab',
    again.getWriteCalls().length, 0);
  eq('row count is still exactly 1 (header only, not duplicated)',
    again.getDataRange().getValues().length, 1);

  // Same check for the headerless path.
  freshSheets();
  var createdEmpty = ensureSheet(currentSS, 'ShopSpend Report', []);
  var rangeCallsBefore = createdEmpty.getRangeCalls().length;
  var againEmpty = ensureSheet(currentSS, 'ShopSpend Report', []);
  check('headerless: the same sheet object is returned', againEmpty === createdEmpty);
  eq('headerless: no new getRange calls on an existing tab',
    againEmpty.getRangeCalls().length, rangeCallsBefore);
})();

console.log('ensureSheet — existing callers still get their real header rows (shopspend-hardening step 0)');
(function () {
  // Asserted against the real *_HEADERS globals (not literals) so a header
  // change in Code.gs cannot silently desync from this test.
  var cases = [
    ['Suppliers', SUPPLIERS_HEADERS],
    ['Sales', SALES_HEADERS],
    ['Revenue', globalThis.REVENUE_HEADERS],
    ['Summary', globalThis.SUMMARY_HEADERS],
    ['Labour', globalThis.LABOUR_HEADERS],
  ];
  cases.forEach(function (pair) {
    var tabName = pair[0], headers = pair[1];
    if (!headers) return;
    freshSheets();
    var sheet = ensureSheet(currentSS, tabName, headers);
    eq('ensureSheet(ss, "' + tabName + '", ' + tabName.toUpperCase() + '_HEADERS) writes the real header row',
      sheet.getDataRange().getValues()[0], headers);
  });
})();

console.log('ensureShopSpendTabs_ creates all three tabs without throwing (shopspend-hardening step 0)');
(function () {
  freshSheets();
  var threw = false;
  var tabs;
  try {
    tabs = ensureShopSpendTabs_(currentSS);
  } catch (err) {
    threw = true;
  }
  check('ensureShopSpendTabs_ does not throw when creating all three tabs from scratch', !threw);
  if (!threw) {
    check('ShopSpend tab created', !!tabs.data);
    check('ShopSpendPulls tab created', !!tabs.pulls);
    check('ShopSpend Report tab created (headerless)', !!tabs.report);
    check('ShopSpend Report tab is retrievable by name',
      currentSS.getSheetByName('ShopSpend Report') === tabs.report);
  }
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

console.log('parseRoasteryInvoice_ (Sample Bean Co — synthetic fixture, no PII, no real amounts)');
var roasteryFixture = [
  'Sample Bean Co ROASTERY TAX INVOICE',
  'Invoice Number: RST-24401',
  'Invoice Date: 2026-07-05',
  'Bill To: Test Cafe Pty Ltd',
  'Green beans - Ethiopia Yirgacheffe 3 x 25kg',
  'Total Due: $612.50'
].join('\n');
eq('parses a well-formed Sample Bean Co invoice — ref, date, total, department',
  parseRoasteryInvoice_(roasteryFixture, '2026-07-06'),
  { date: '2026-07-05', total: 612.50, invoice_ref: 'RST-24401', department: 'Roastery' });
check('falls back to received date when no date in text',
  parseRoasteryInvoice_('Invoice Number: RST-1\nTotal Due: $10.00', '2026-07-06').date === '2026-07-06');
eq('missing invoice number → invoice_ref null (caller falls back to the Gmail message id, not the parser)',
  parseRoasteryInvoice_('Total Due: $10.00', '2026-07-06').invoice_ref, null);
(function () {
  var threw = false;
  var message = '';
  try {
    parseRoasteryInvoice_('Hello, just a friendly note with no invoice data', '2026-07-06');
  } catch (e) {
    threw = true;
    message = e.message;
  }
  check('unparseable input RAISES rather than returning empty/null', threw);
  check('raised error message is actionable (mentions total)', message.indexOf('total') !== -1);
})();

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

console.log('aggregateSupplierRows_ revenue grain — online collapses to source');
(function () {
  // Revenue row order: [date, department, channel, customer, amount, order_ref, source, extracted_at]

  // 1 + 2 + 8: online customers (incl. guest '#nnnn' names) collapse to one
  // group keyed by source. This is the whole point of the change — grouping by
  // customer wrote one Summary row per guest order.
  var online = [
    ['2026-06-16', 'Roastery', 'online', '#1041', 62, 'O-1', 'shopify', 'TS'],
    ['2026-06-17', 'Roastery', 'online', '#1042', 48.5, 'O-2', 'shopify', 'TS'],
    ['2026-06-18', 'Roastery', 'online', 'Sarah Chen', 120, 'O-3', 'shopify', 'TS'],
  ];
  var r1 = aggregateSupplierRows_(online, '2026-06-15', '2026-06-21', 'revenue');
  eq('online: three customers collapse into one group', r1.length, 1);
  eq('online: total is the sum', r1[0].total, 230.5);
  eq('online: supplier is the source, not the customer', r1[0].supplier, 'shopify');
  eq('online: location is the channel', r1[0].location, 'online');
  eq('online: department preserved', r1[0].department, 'Roastery');

  // 3 + 8: wholesale keeps per-customer grain — these are real named accounts
  // (docs/ingest-contract.md), and doGet serves Summary only, so collapsing
  // them would delete per-customer weekly revenue from the API.
  var wholesale = [
    ['2026-06-16', 'Roastery', 'wholesale', 'Cafe X', 340, 'W-1', 'coffee_order_app', 'TS'],
    ['2026-06-17', 'Roastery', 'wholesale', 'Bar Mero', 912, 'W-2', 'coffee_order_app', 'TS'],
  ];
  var r2 = aggregateSupplierRows_(wholesale, '2026-06-15', '2026-06-21', 'revenue');
  eq('wholesale: two customers stay two groups', r2.length, 2);
  eq('wholesale: supplier is still the customer name', r2[0].supplier, 'Bar Mero');
  eq('wholesale: second customer intact', r2[1].supplier, 'Cafe X');
  eq('wholesale: totals not merged', r2[0].total + '|' + r2[1].total, '912|340');

  // 4: both channels in one call — online collapsed, wholesale preserved.
  var mixed = online.concat(wholesale);
  var r3 = aggregateSupplierRows_(mixed, '2026-06-15', '2026-06-21', 'revenue');
  eq('mixed: 3 groups (1 online + 2 wholesale)', r3.length, 3);
  eq('mixed: sorted keys → Bar Mero, Cafe X, shopify',
    r3.map(function (g) { return g.supplier; }).join(','), 'Bar Mero,Cafe X,shopify');

  // 5: channel compare is case-insensitive, but location stores the raw string.
  var capitalised = [
    ['2026-06-16', 'Roastery', 'Online', '#2001', 10, 'C-1', 'shopify', 'TS'],
    ['2026-06-17', 'Roastery', 'Online', '#2002', 20, 'C-2', 'shopify', 'TS'],
  ];
  var r4 = aggregateSupplierRows_(capitalised, '2026-06-15', '2026-06-21', 'revenue');
  eq('"Online" collapses too', r4.length, 1);
  eq('"Online" groups by source', r4[0].supplier, 'shopify');
  eq('location keeps the raw channel casing', r4[0].location, 'Online');

  // 6: two sources on the same channel stay distinct.
  var twoSources = [
    ['2026-06-16', 'Roastery', 'online', '#3001', 50, 'S-1', 'shopify', 'TS'],
    ['2026-06-17', 'Roastery', 'online', 'Cafe Y', 70, 'S-2', 'coffee_order_app', 'TS'],
  ];
  var r5 = aggregateSupplierRows_(twoSources, '2026-06-15', '2026-06-21', 'revenue');
  eq('two online sources → two groups', r5.length, 2);
  eq('...keyed by source', r5[0].supplier + ',' + r5[1].supplier, 'coffee_order_app,shopify');

  // 7: department still splits.
  var twoDepts = [
    ['2026-06-16', 'Roastery', 'online', '#4001', 50, 'D-1', 'shopify', 'TS'],
    ['2026-06-17', 'Cafe', 'online', '#4002', 70, 'D-2', 'shopify', 'TS'],
  ];
  var r6 = aggregateSupplierRows_(twoDepts, '2026-06-15', '2026-06-21', 'revenue');
  eq('two departments → two groups', r6.length, 2);
  eq('...Cafe sorts first', r6[0].department + '|' + r6[0].total, 'Cafe|70');
  eq('...Roastery second', r6[1].department + '|' + r6[1].total, 'Roastery|50');

  // 9: a blank/absent source must not silently become '' or 'undefined' as a
  // doGet supplier value. normalizeRevenueRow writes source through verbatim
  // and weeklySummarize reads the raw tab, so unvalidated rows do reach here.
  var blankSource = [
    ['2026-06-16', 'Roastery', 'online', '#5001', 11, 'B-1', '', 'TS'],
    ['2026-06-17', 'Roastery', 'online', '#5002', 22, 'B-2', undefined, 'TS'],
    ['2026-06-18', 'Roastery', 'online', '#5003', 33, 'B-3', 'shopify', 'TS'],
  ];
  var r7 = aggregateSupplierRows_(blankSource, '2026-06-15', '2026-06-21', 'revenue');
  eq('blank + absent source group together as "unknown"', r7.length, 2);
  eq('...unknown bucket totals 11+22', r7[1].supplier + '|' + r7[1].total, 'unknown|33');
  eq('...and does NOT merge with the real source', r7[0].supplier + '|' + r7[0].total, 'shopify|33');

  // 10: Date-object date cells (the project's most-repeated trap) still filter
  // correctly — coerceDateStr_ is untouched, this guards against regressing it.
  var dateCells = [
    [new Date(2026, 5, 16), 'Roastery', 'online', '#6001', 100, 'DT-1', 'shopify', 'TS'],
    [new Date(2026, 5, 10), 'Roastery', 'online', '#6002', 999, 'DT-2', 'shopify', 'TS'], // before week
    [new Date(2026, 5, 25), 'Roastery', 'online', '#6003', 888, 'DT-3', 'shopify', 'TS'], // after week
  ];
  var r8 = aggregateSupplierRows_(dateCells, '2026-06-15', '2026-06-21', 'revenue');
  eq('Date-object revenue rows: only the in-week row counts', r8.length, 1);
  eq('Date-object revenue rows: out-of-week excluded', r8[0].total, 100);
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
 * cleanupOnlineRevenueSummaryRows — v23 online-revenue grain cleanup
 *
 * v23 changed online revenue from customer-keyed to source-keyed groups.
 * `supplier` is in SUMMARY_KEY_COLS, so the new rows do not update the old
 * ones — they land beside them and doGet double-counts the week. These tests
 * pin the two things that make the repair safe to run against the live hub:
 * the blast radius (online revenue ONLY) and the round trip (purge, then
 * re-summarize, yields exactly one correct row).
 * ------------------------------------------------------------------ */

(function testCleanupOnlineRevenueSummaryRows() {
  console.log('\ncleanupOnlineRevenueSummaryRows (v23 grain cleanup):');

  // Mirrors the live tab shape: three customer-keyed online rows (the stale
  // grain, one per Shopify guest checkout), plus rows that must NOT be touched
  // — wholesale revenue keeps per-customer grain deliberately, and spend and
  // labour are a different `kind` entirely.
  function seed() {
    currentSS = makeSpreadsheet();
    scriptProps = {};                     // no LABOUR_SHEET_ID → labour pull skips

    const rev = currentSS.insertSheet('Revenue');
    rev.appendRow(REVENUE_HEADERS);
    rev.appendRow(['2026-06-17', 'Roastery', 'online', '#1001', 100, 'ORD-1', 'shopify', 'TS']);
    rev.appendRow(['2026-06-18', 'Roastery', 'online', '#1002', 50, 'ORD-2', 'shopify', 'TS']);
    rev.appendRow(['2026-06-19', 'Roastery', 'online', '#1003', 25, 'ORD-3', 'shopify', 'TS']);
    rev.appendRow(['2026-06-18', 'Roastery', 'wholesale', 'Cafe X', 340, 'ORD-4', 'coffee_order_app', 'TS']);

    const s = currentSS.insertSheet('Summary');
    s.appendRow(SUMMARY_HEADERS);
    s.appendRow(['2026-06-15', '2026-06-21', '#1001', 'online', 100, 'T1', 'Roastery', 'revenue']);
    s.appendRow(['2026-06-15', '2026-06-21', '#1002', 'online', 50, 'T1', 'Roastery', 'revenue']);
    s.appendRow(['2026-06-15', '2026-06-21', '#1003', 'online', 25, 'T1', 'Roastery', 'revenue']);
    s.appendRow(['2026-06-15', '2026-06-21', 'Cafe X', 'wholesale', 340, 'T1', 'Roastery', 'revenue']);
    s.appendRow(['2026-06-15', '2026-06-21', 'Food and Dairy Co', 'Leible York', 263, 'T1', 'Cafe', 'spend']);
    s.appendRow(['2026-06-15', '2026-06-21', 'Labour', 'york', 4830.14, 'T1', 'Cafe', 'labour']);
    return s;
  }

  var sheet = seed();
  eq('seeded 6 data rows (+header)', sheet._rows.length, 7);

  // --- Dry run: reports, writes nothing. ---
  var dry = cleanupOnlineRevenueSummaryRows();
  eq('dry run is the default (no arg)', dry.mode, 'dryRun');
  eq('dry run finds the 3 online revenue rows', dry.found, 3);
  eq('dry run deletes nothing', dry.deleted, 0);
  eq('dry run leaves the sheet intact', sheet._rows.length, 7);
  eq('dry run reports 1 affected week', dry.weeks.length, 1);
  eq('week is the Monday', dry.weeks[0].week_start, '2026-06-15');
  eq('week total is the sum of the stale rows', dry.weeks[0].total, 175);
  eq('week is re-summarizable (Revenue rows still present)', dry.weeks[0].resummarizable, true);
  eq('counts the online Revenue rows backing the week', dry.weeks[0].revenueRowsPresent, 3);

  // --- Apply: blast radius is online revenue and nothing else. ---
  var applied = cleanupOnlineRevenueSummaryRows(false);
  eq('apply deletes 3', applied.deleted, 3);
  var rows = sheet.getDataRange().getValues();
  eq('3 rows survive (+header)', rows.length, 4);
  eq('wholesale revenue survived', rows[1][2], 'Cafe X');
  eq('wholesale total intact', rows[1][4], 340);
  eq('spend row survived', rows[2][2], 'Food and Dairy Co');
  eq('labour row survived', rows[3][2], 'Labour');
  eq('no online revenue row remains',
    rows.slice(1).some((r) => String(r[3]).toLowerCase() === 'online'), false);

  // The backup is the only record of a week that cannot be rebuilt, so it must
  // exist BEFORE any delete and carry every removed row verbatim.
  var backup = currentSS.getSheetByName(ONLINE_REVENUE_BACKUP_TAB);
  check('backup tab was created', !!backup);
  var backupRows = backup.getDataRange().getValues();
  eq('backup holds all 3 removed rows (+header)', backupRows.length, 4);
  eq('backup preserves the Summary header shape', backupRows[0][7], 'kind');
  eq('backup keeps the customer-keyed supplier', backupRows[1][2], '#1001');
  eq('backup keeps the total', backupRows[3][4], 25);

  // --- Idempotent: a repair that may be re-run must find nothing twice. ---
  var again = cleanupOnlineRevenueSummaryRows(false);
  eq('re-apply finds nothing', again.found, 0);
  eq('re-apply deletes nothing', again.deleted, 0);
  eq('sheet unchanged by re-apply', sheet.getDataRange().getValues().length, 4);

  // --- Case-insensitive matching. Live rows are not guaranteed lowercase, and
  // a case-sensitive match would leave stale rows behind that still double-count.
  seed();
  var mixed = currentSS.getSheetByName('Summary');
  mixed.appendRow(['2026-06-15', '2026-06-21', '#1004', 'Online', 10, 'T1', 'Roastery', 'Revenue']);
  eq('matches Online/Revenue regardless of case',
    cleanupOnlineRevenueSummaryRows().found, 4);

  // --- A week whose Revenue rows are gone cannot be rebuilt by re-summarizing.
  // Deleting it blind would destroy the figure, so the report must say so.
  seed();
  currentSS.getSheetByName('Summary')
    .appendRow(['2026-05-04', '2026-05-10', '#0900', 'online', 77, 'T0', 'Roastery', 'revenue']);
  var orphan = cleanupOnlineRevenueSummaryRows();
  var orphanWeek = orphan.weeks.filter((w) => w.week_start === '2026-05-04')[0];
  eq('purged-Revenue week is flagged NOT re-summarizable', orphanWeek.resummarizable, false);
  eq('purged-Revenue week has no backing rows', orphanWeek.revenueRowsPresent, 0);

  // --- Mixed channel casing in Revenue silently collapses on re-summarize
  // (rowKey_ lowercases). The report has to surface it before the rebuild.
  seed();
  currentSS.getSheetByName('Revenue')
    .appendRow(['2026-06-20', 'Roastery', 'Online', '#1005', 15, 'ORD-5', 'shopify', 'TS']);
  var casing = cleanupOnlineRevenueSummaryRows();
  eq('mixed channel casing is detected', casing.weeks[0].channelCasings.length, 2);

  // --- Pull-owned shopify_orderapp rows are OUTSIDE the blast radius: they are
  // written directly by shopifyWeeklyPull (PRD-10), no Revenue rows back them,
  // and deleting one is unrecoverable by re-summarize.
  var guardSheet = seed();
  currentSS.getSheetByName('Summary')
    .appendRow(['2026-07-27', '2026-08-02', 'shopify_orderapp', 'online', 512.5, 'T2', 'Roastery', 'revenue']);
  var guarded = cleanupOnlineRevenueSummaryRows();
  eq('shopify_orderapp row is NOT matched by the dry run', guarded.found, 3);
  var guardedApply = cleanupOnlineRevenueSummaryRows(false);
  eq('apply deletes only the customer-keyed rows', guardedApply.deleted, 3);
  var surviving = guardSheet.getDataRange().getValues().slice(1)
    .filter((r) => String(r[2]) === 'shopify_orderapp');
  eq('shopify_orderapp row survives the apply', surviving.length, 1);
  eq('shopify_orderapp total intact', surviving[0][4], 512.5);
})();

/* ------------------------------------------------------------------ *
 * The cleanup round trip: purge → re-summarize. This is the assertion the
 * live runbook rests on — that what the purge removes actually comes back,
 * at the new grain, with the same money in it.
 * ------------------------------------------------------------------ */

(function testOnlineRevenueCleanupRoundTrip() {
  console.log('\nonline-revenue cleanup round trip (purge → resummarize):');

  currentSS = makeSpreadsheet();
  scriptProps = {};

  const rev = currentSS.insertSheet('Revenue');
  rev.appendRow(REVENUE_HEADERS);
  rev.appendRow(['2026-06-17', 'Roastery', 'online', '#1001', 100, 'ORD-1', 'shopify', 'TS']);
  rev.appendRow(['2026-06-18', 'Roastery', 'online', '#1002', 50, 'ORD-2', 'shopify', 'TS']);
  // A second, older week — one weeklySummarize call writes ONE week, so a
  // single run after the purge would leave this one permanently missing.
  rev.appendRow(['2026-06-09', 'Roastery', 'online', '#0999', 30, 'ORD-0', 'shopify', 'TS']);

  const s = currentSS.insertSheet('Summary');
  s.appendRow(SUMMARY_HEADERS);
  s.appendRow(['2026-06-15', '2026-06-21', '#1001', 'online', 100, 'T1', 'Roastery', 'revenue']);
  s.appendRow(['2026-06-15', '2026-06-21', '#1002', 'online', 50, 'T1', 'Roastery', 'revenue']);
  s.appendRow(['2026-06-08', '2026-06-14', '#0999', 'online', 30, 'T1', 'Roastery', 'revenue']);

  var applied = cleanupOnlineRevenueSummaryRows(false);
  eq('purge removed all 3 stale rows', applied.deleted, 3);
  eq('purge spans 2 weeks', applied.weeks.length, 2);
  eq('Summary is empty after the purge', s.getDataRange().getValues().length, 1);

  // The week list is read back from the backup, not re-typed — the editor Run
  // button cannot pass weeklySummarize a week argument at all.
  var weeks = backedUpOnlineRevenueWeeks_(currentSS);
  eq('both weeks recovered from the backup tab', weeks.length, 2);
  eq('oldest week first', weeks[0], '2026-06-08');

  var res = runOnlineRevenueResummarize();
  eq('re-summarized both weeks', res.weeks, 2);

  var out = s.getDataRange().getValues();
  eq('one source-keyed row per week (+header)', out.length, 3);
  var byWeek = {};
  out.slice(1).forEach((r) => { byWeek[cellDate(r[0])] = r; });

  eq('recent week collapsed to the source', byWeek['2026-06-15'][2], 'shopify');
  eq('recent week keeps every dollar (100+50)', byWeek['2026-06-15'][4], 150);
  eq('recent week stays online', byWeek['2026-06-15'][3], 'online');
  eq('recent week keeps its department', byWeek['2026-06-15'][6], 'Roastery');
  eq('recent week is still revenue', byWeek['2026-06-15'][7], 'revenue');
  eq('older week rebuilt too — not left behind', byWeek['2026-06-08'][4], 30);

  // Post-cleanup, the trigger's Monday run must be a no-op on these weeks
  // rather than appending a second copy: same key, same total.
  var rerun = weeklySummarize('2026-06-15');
  eq('re-running the week adds nothing', rerun.summariesAdded, 0);
  eq('re-running the week updates nothing', rerun.summariesUpdated, 0);
  eq('Summary row count unchanged by the re-run', s.getDataRange().getValues().length, 3);

  // Guard: resummarize before an apply has nothing to go on and must say so
  // rather than silently summarizing "last week" instead.
  currentSS = makeSpreadsheet();
  var noBackup = runOnlineRevenueResummarize();
  eq('no backup tab → refuses, summarizes nothing', noBackup.weeks, 0);
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
 * Editor wrappers — the Run button passes no arguments, so an Apply
 * wrapper that forgets `false` silently dry-runs and reports success.
 * These assert the WRITE actually reaches the sheet.
 * ------------------------------------------------------------------ */

(function testMigrationEditorWrappers() {
  console.log('\nmigration editor wrappers:');

  function seedLegacyHub() {
    currentSS = makeSpreadsheet();
    currentSS._sheets['Suppliers'] = makeSheet(OLD_SUPPLIERS_HEADERS);
    currentSS._sheets['Sales'] = makeSheet(OLD_SALES_HEADERS);
    currentSS._sheets['_staging'] = makeSheet(OLD_SUPPLIERS_HEADERS);
    currentSS._sheets['_archive'] = makeSheet(OLD_SUPPLIERS_HEADERS);
    currentSS._sheets['Labour'] = makeSheet(OLD_LABOUR_HEADERS);
    currentSS.getSheetByName('Suppliers').appendRow(['2026-06-15', 'Food and Dairy Co', 100, 'A1', 'York St', 'food_dairy_co', 'x']);
  }

  // Every wrapper must be callable with NO arguments — that is the only way
  // the editor can invoke it.
  eq('all four wrappers take zero declared args', [
    runDepartmentMigrationDryRun.length,
    runDepartmentMigrationApply.length,
    runBlankDepartmentSweepDryRun.length,
    runBlankDepartmentSweepApply.length
  ], [0, 0, 0, 0]);

  // DryRun wrapper: reports, writes nothing.
  seedLegacyHub();
  var beforeBytes = JSON.stringify(currentSS.getSheetByName('Suppliers')._rows);
  var dry = runDepartmentMigrationDryRun();
  eq('DryRun wrapper returns the report', dry.Suppliers.headerAction, 'add');
  eq('DryRun wrapper writes NOTHING',
    JSON.stringify(currentSS.getSheetByName('Suppliers')._rows), beforeBytes);
  check('DryRun wrapper creates no Revenue tab', !currentSS.getSheetByName('Revenue'));

  // Apply wrapper: actually writes. This is the regression guard — if the
  // wrapper drops `false`, header/backfill stay absent and this goes red.
  seedLegacyHub();
  var applied = runDepartmentMigrationApply();
  var rows = currentSS.getSheetByName('Suppliers').getDataRange().getValues();
  eq('Apply wrapper returns the report', applied.Suppliers.headerAction, 'add');
  eq('Apply wrapper WRITES the header', rows[0][7], 'department');
  eq('Apply wrapper WRITES the backfill', rows[1][7], 'Cafe');
  check('Apply wrapper creates the Revenue tab', !!currentSS.getSheetByName('Revenue'));

  // Sweep wrappers, over a hub already carrying the department header with a
  // blank cell — the step 3-6 window case.
  seedLegacyHub();
  migrateAddDepartment_(false);
  var supp = currentSS.getSheetByName('Suppliers');
  supp.appendRow(['2026-06-20', 'Window Co', 42, 'W1', 'York St', 'test', 'x', '']);

  var sweepDry = runBlankDepartmentSweepDryRun();
  eq('Sweep DryRun reports the blank row', sweepDry.Suppliers.blanksFilled, 1);
  eq('Sweep DryRun writes NOTHING',
    supp.getDataRange().getValues()[2][7], '');

  var sweepApplied = runBlankDepartmentSweepApply();
  eq('Sweep Apply reports the blank row', sweepApplied.Suppliers.blanksFilled, 1);
  eq('Sweep Apply WRITES the fill', supp.getDataRange().getValues()[2][7], 'Cafe');
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

  // 14: end-to-end — a week of online Revenue rows yields exactly ONE
  // kind='revenue' Summary row, and doGet?department=Roastery serves it.
  (function () {
    currentSS = makeSpreadsheet();
    scriptProps = { API_READ_TOKEN: 'tok' };
    var rev = ensureSheet(currentSS, 'Revenue', REVENUE_HEADERS);
    rev.appendRow(['2026-06-16', 'Roastery', 'online', '#1041', 62, 'E-1', 'shopify', 'x']);
    rev.appendRow(['2026-06-17', 'Roastery', 'online', '#1042', 48.5, 'E-2', 'shopify', 'x']);
    rev.appendRow(['2026-06-18', 'Roastery', 'online', 'Sarah Chen', 120, 'E-3', 'shopify', 'x']);

    var res = weeklySummarize('2026-06-15');
    eq('a week of online orders → 1 Summary row, not 1 per order', res.summariesAdded, 1);

    var served = JSON.parse(doGet({ parameter: {
      token: 'tok', from: '2026-06-15', to: '2026-06-21', department: 'Roastery'
    } }).getContent());
    eq('doGet returns the single weekly Roastery figure', served.count, 1);
    eq('...supplier is the source', served.rows[0].supplier, 'shopify');
    eq('...total is the week sum', served.rows[0].total, 230.5);
  })();

  // 12: idempotency — the new grouping key must be stable across runs, or a
  // re-summarize would append a second row instead of upserting.
  (function () {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    var rev = ensureSheet(currentSS, 'Revenue', REVENUE_HEADERS);
    rev.appendRow(['2026-06-16', 'Roastery', 'online', '#7001', 62, 'I-1', 'shopify', 'x']);

    var first = weeklySummarize('2026-06-15');
    eq('first summarize adds the online revenue row', first.summariesAdded, 1);
    var before = currentSS.getSheetByName('Summary').getDataRange().getValues();

    // Identical re-run: an unchanged amount is a duplicate-skip, not an update
    // (Code.gs:402) — what matters is that the key matched, so nothing appends.
    var second = weeklySummarize('2026-06-15');
    eq('re-summarize appends nothing (key is stable)', second.summariesAdded, 0);
    var after = currentSS.getSheetByName('Summary').getDataRange().getValues();
    eq('Summary row count unchanged across runs', after.length, before.length);

    // Amended amount proves the key genuinely matched rather than the row being
    // skipped for some unrelated reason: it must update IN PLACE, not append.
    rev.getRange(2, 5).setValue(99);
    var third = weeklySummarize('2026-06-15');
    eq('amended online revenue updates in place', third.summariesUpdated, 1);
    eq('...and still appends nothing', third.summariesAdded, 0);
    var amended = currentSS.getSheetByName('Summary').getDataRange().getValues();
    eq('Summary row count still unchanged', amended.length, before.length);
    eq('Summary total reflects the amendment', amended[1][4], 99);
  })();

  // 13: stale-key double-count — documents WHY the pre-deploy checklist exists.
  // A Summary row written under the OLD customer-keyed scheme is not updated by
  // the new source-keyed run; it is orphaned alongside it and doGet counts both.
  // The expected value is pinned at 2 so a wrong result stays distinguishable
  // from this intended (bad) behaviour.
  (function () {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    var summ = ensureSheet(currentSS, 'Summary', SUMMARY_HEADERS);
    // Legacy row: supplier = customer name, as the old grouping produced.
    summ.appendRow(['2026-06-15', '2026-06-21', '#8001', 'online', 62, 'old', 'Roastery', 'revenue']);
    var rev = ensureSheet(currentSS, 'Revenue', REVENUE_HEADERS);
    rev.appendRow(['2026-06-16', 'Roastery', 'online', '#8001', 62, 'L-1', 'shopify', 'x']);

    weeklySummarize('2026-06-15');
    var rows = currentSS.getSheetByName('Summary').getDataRange().getValues().slice(1);
    var revenueRows = rows.filter(function (r) { return r[7] === 'revenue'; });
    eq('legacy customer-keyed row is NOT updated — it is orphaned (2 rows)', revenueRows.length, 2);
    check('the same 62.00 is now counted twice — hence the pre-deploy cleanup',
      revenueRows[0][4] + revenueRows[1][4] === 124);
  })();

  // Case-variant channels in ONE week SILENTLY LOSE REVENUE. The aggregator
  // groups on the raw location string, so 'Online' and 'online' are two groups;
  // but Summary dedup lowercases (rowKey_, Code.gs:421), so both produce the
  // same Summary key and the later one is dropped as an in-batch duplicate
  // (Code.gs:389). Whichever casing sorts first in the aggregator's key sort
  // wins — 'Online' (O=79) before 'online' (o=111) — so here 100 + 25 reports
  // as 25, not 125. PRE-EXISTING, not introduced by the source-grouping change;
  // pinned here so the loss is visible if any connector emits mixed casing.
  // Recorded in TODO.md.
  (function () {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    var rev = ensureSheet(currentSS, 'Revenue', REVENUE_HEADERS);
    rev.appendRow(['2026-06-16', 'Roastery', 'online', '#9001', 100, 'V-1', 'shopify', 'x']);
    rev.appendRow(['2026-06-17', 'Roastery', 'Online', '#9002', 25, 'V-2', 'shopify', 'x']);

    weeklySummarize('2026-06-15');
    var revRows = currentSS.getSheetByName('Summary').getDataRange().getValues()
      .slice(1).filter(function (r) { return r[7] === 'revenue'; });
    eq('mixed channel casing collapses to ONE Summary row', revRows.length, 1);
    eq('...and 100 is silently lost: reports 25, not the 125 sum', revRows[0][4], 25);
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

/* ------------------------------------------------------------------
 * Phase 3 — recurring: deterministic slug/invoice_ref, idempotent re-runs,
 * amount-change upsert, a simulated year of monthly runs, missing-property
 * skip, lock-timeout, trigger install.
 * ------------------------------------------------------------------ */

(function testRecurringSlug() {
  console.log('\nrecurring — recurringSlug_ (pure, deterministic + stable):');
  eq('em-dash + spaces collapse to single hyphens', recurringSlug_('Rent — Roastery'), 'rent-roastery');
  eq('plain word lowercases', recurringSlug_('Shopify'), 'shopify');
  eq('same input always yields the same output', recurringSlug_('Rent — Roastery'), recurringSlug_('Rent — Roastery'));
  eq('leading/trailing junk trimmed', recurringSlug_('  Rent!!  '), 'rent');
})();

(function testRecurringInvoiceRefDeterministic() {
  console.log('\nrecurring — invoice_ref generation deterministic and slug-stable:');
  freshSheets();
  scriptProps = { RECUR_RENT_ROASTERY: '2500', RECUR_SHOPIFY: '79' };
  var res = recurringMonthlyRun_('2026-08');
  eq('two configured entries -> 2 rows added', res.rowsAdded, 2);
  var rows = currentSS.getSheetByName('Suppliers').getDataRange().getValues();
  var refs = rows.slice(1).map(function (r) { return r[3]; }).sort();
  eq('deterministic refs match vendor slug + period, matching the plan example',
    refs, ['rent-roastery-2026-08', 'shopify-2026-08']);
})();

(function testRecurringMissingPropertySkippedNotZero() {
  console.log('\nrecurring — missing script property -> skipped, never written as 0:');
  freshSheets();
  scriptProps = { RECUR_RENT_ROASTERY: '2500' }; // RECUR_SHOPIFY absent
  var res = recurringMonthlyRun_('2026-08');
  eq('only the configured entry is written', res.rowsAdded, 1);
  eq('the missing entry is reported skipped, not silently zeroed', res.skipped, ['Shopify']);
  var rows = currentSS.getSheetByName('Suppliers').getDataRange().getValues();
  eq('no zero-amount row was written for Shopify (header + 1 data row only)', rows.length, 2);
})();

(function testRecurringDoubleRunIdempotent() {
  console.log('\nrecurring — running the generator twice in the same month: no duplicate rows, no doubled total (the crux of this phase):');
  freshSheets();
  scriptProps = { RECUR_RENT_ROASTERY: '2500', RECUR_SHOPIFY: '79' };

  var first = recurringMonthlyRun_('2026-08');
  eq('first run: 2 rows added', first.rowsAdded, 2);

  var second = recurringMonthlyRun_('2026-08');
  eq('second run same period: 0 rows added', second.rowsAdded, 0);
  eq('second run same period: unchanged amount -> 0 updated (upsertRows_ no-op, not a duplicate write)', second.rowsUpdated, 0);
  eq('second run same period: 2 rows recognised as duplicates, not appended', second.duplicatesSkipped, 2);

  var rows = currentSS.getSheetByName('Suppliers').getDataRange().getValues();
  eq('still exactly 2 data rows after two runs — NOT 4', rows.length, 3);
  var total = rows.slice(1).reduce(function (sum, r) { return sum + Number(r[2]); }, 0);
  eq('total is NOT doubled (2500 + 79, once)', total, 2579);
})();

(function testRecurringAmountChangeUpdatesInPlace() {
  console.log('\nrecurring — an amount change upserts the existing row instead of adding a new one:');
  freshSheets();
  scriptProps = { RECUR_RENT_ROASTERY: '2500', RECUR_SHOPIFY: '79' };
  recurringMonthlyRun_('2026-08');

  scriptProps = { RECUR_RENT_ROASTERY: '2600', RECUR_SHOPIFY: '79' }; // rent goes up
  var res = recurringMonthlyRun_('2026-08');
  eq('changed amount: 0 added, 1 updated', res.rowsAdded + '|' + res.rowsUpdated, '0|1');

  var rows = currentSS.getSheetByName('Suppliers').getDataRange().getValues();
  var rentRow = rows.slice(1).filter(function (r) { return r[3] === 'rent-roastery-2026-08'; })[0];
  eq('rent row now reflects the new amount', rentRow[2], 2600);
  eq('still only one rent row (upsert, not append)', rows.length, 3);
})();

(function testRecurringYearOfMonthlyRunsYields12Rows() {
  console.log('\nrecurring — a monthly entry yields exactly 12 rows across a simulated year:');
  freshSheets();
  scriptProps = { RECUR_RENT_ROASTERY: '2500' }; // Shopify omitted to isolate rent's 12 rows
  for (var m = 1; m <= 12; m++) {
    var period = '2026-' + (m < 10 ? '0' + m : m);
    recurringMonthlyRun_(period);
  }
  var rows = currentSS.getSheetByName('Suppliers').getDataRange().getValues();
  eq('12 distinct monthly periods -> 12 data rows (header + 12)', rows.length, 13);
})();

(function testRecurringDefaultsToCurrentMonth() {
  console.log('\nrecurring — no periodStr arg defaults to the current month (Australia/Sydney):');
  freshSheets();
  scriptProps = { RECUR_RENT_ROASTERY: '2500' };
  var res = withMockNow('2026-08-15T00:00:00Z', function () { return recurringMonthlyRun_(); });
  eq('defaults to 2026-08', res.period, '2026-08');
})();

(function testRecurringLockTimeout() {
  console.log('\nrecurring — a held script lock is reported, not silently swallowed:');
  freshSheets();
  scriptProps = { RECUR_RENT_ROASTERY: '2500' };
  global.__forceLockTimeout = true;
  try {
    var res = recurringMonthlyRun_('2026-08');
    eq('locked run reports locked:true and writes nothing', res.locked + '|' + res.rowsAdded, 'true|0');
  } finally {
    global.__forceLockTimeout = false;
  }
})();

(function testInstallRecurringTrigger() {
  console.log('\nrecurring — installRecurringTrigger runs without throwing (monthly ClockTriggerBuilder chain):');
  check('installRecurringTrigger does not throw', (function () {
    try { installRecurringTrigger(); return true; } catch (e) { return false; }
  })());
})();

/* ------------------------------------------------------------------ *
 * Phase 4 — coffee order app contract (docs/ingest-contract.md)
 * ------------------------------------------------------------------ */

/*
 * Integration guard. Phases 2/3/5 each added a connector that stamps a
 * heartbeat, but staleness.gs sat outside their declared file lanes, so every
 * one of them shipped unwatched — a connector could die silently and nothing
 * would alert. This asserts the wiring so the gap cannot reopen quietly.
 *
 * 'recurring' is the deliberate exemption: it runs MONTHLY, and at a 96h
 * threshold watching it would cry wolf ~26 days a month. Fixing that properly
 * needs per-source thresholds (TODO.md).
 */
(function testEveryHeartbeatSourceIsWatched() {
  console.log('\nstaleness — every heartbeat source is watched:');

  var STAMPS_HEARTBEAT = ['square', 'mayers', 'roastery', 'recurring', 'shopspend', 'shopify_orderapp', 'greenbean'];
  var EXEMPT = {
    recurring: 'monthly cadence exceeds STALENESS_THRESHOLD_HOURS',
    shopspend: 'weekly cadence exceeds STALENESS_THRESHOLD_HOURS',
    shopify_orderapp: 'weekly (168h) cadence exceeds STALENESS_THRESHOLD_HOURS; failure detection is the orderapp fail-open counter/alert',
    greenbean: 'weekly (168h) cadence exceeds STALENESS_THRESHOLD_HOURS; failure detection is the orderapp fail-open counter/alert'
  };

  for (var i = 0; i < STAMPS_HEARTBEAT.length; i++) {
    var src = STAMPS_HEARTBEAT[i];
    var watched = STALENESS_SOURCES.indexOf(src) !== -1;
    if (EXEMPT[src]) {
      check(src + ' is deliberately NOT watched (' + EXEMPT[src] + ')', !watched);
    } else {
      check(src + ' stamps a heartbeat and is watched', watched);
    }
  }

  // --- Registration guards: retired/never-watched sources must never be
  // re-added to STALENESS_SOURCES (mirrors the shopspend guard above) ---
  check("'shopify' is NOT in STALENESS_SOURCES (shopify.gs deleted, superseded by shopify_orderapp)",
    STALENESS_SOURCES.indexOf('shopify') === -1);
  check("'coffee_order_app' is NOT in STALENESS_SOURCES (never stamps a heartbeat; exclusivity mechanically enforced)",
    STALENESS_SOURCES.indexOf('coffee_order_app') === -1);
})();

(function testCoffeeOrderAppContract() {
  console.log('\ncoffee order app — ingest contract:');

  check('coffee_order_app is NOT a staleness watchdog source (never stamps a heartbeat today)',
    STALENESS_SOURCES.indexOf('coffee_order_app') === -1);

  // Wholesale revenue payload, verbatim shape from docs/ingest-contract.md /
  // the plan's Phase 4 example.
  freshSheets();
  var revRes = doPostJson({
    kind: 'revenue', source: 'coffee_order_app', extracted_at: '2026-08-03T09:00:00+10:00',
    rows: [
      { date: '2026-08-03', department: 'Roastery', channel: 'wholesale',
        customer: 'Cafe X', amount: 340.00, order_ref: 'ORD-1182' }
    ]
  });
  eq('wholesale revenue payload → ok', revRes.result, 'ok');
  eq('wholesale revenue payload → rowsAdded 1', revRes.rowsAdded, 1);
  var revRow = currentSS.getSheetByName('Revenue').getDataRange().getValues()[1];
  eq('revenue row lands in REVENUE_HEADERS order',
    [cellDate(revRow[0])].concat(revRow.slice(1)),
    ['2026-08-03', 'Roastery', 'wholesale', 'Cafe X', 340, 'ORD-1182', 'coffee_order_app', '2026-08-03T09:00:00+10:00']);

  // Uploaded bean/packaging invoice payload — this shape is now SUPERSEDED:
  // stock-intake invoices for Roastery arrive ONLY via the Order-app
  // greenBeanCost pull (source='greenbean'). validateIngest_ must reject a
  // coffee_order_app suppliers-kind payload rather than accept it, and the
  // rejection message must name the greenbean exclusivity so the reason is
  // legible in a doPost error response, not just a source-code comment.
  (function () {
    var suppBase = {
      source: 'coffee_order_app', extracted_at: '2026-08-03T09:00:00+10:00',
      rows: [
        { date: '2026-08-01', department: 'Roastery', supplier: 'Green Bean Co',
          total: 1840.00, invoice_ref: 'coa-8823' }
      ]
    };

    var explicitKindRes = validateIngest_(Object.assign({ kind: 'suppliers' }, suppBase));
    check('kind:"suppliers" + source:"coffee_order_app" → rejected', !explicitKindRes.ok);
    check('rejection message names the greenbean exclusivity',
      !!explicitKindRes.message && explicitKindRes.message.toLowerCase().indexOf('greenbean') !== -1);

    var omittedKindRes = validateIngest_(suppBase); // kind omitted -> defaults to 'suppliers'
    check('omitted kind (defaults to suppliers) + source:"coffee_order_app" → same rejection',
      !omittedKindRes.ok);
    check('omitted-kind rejection message also names greenbean',
      !!omittedKindRes.message && omittedKindRes.message.toLowerCase().indexOf('greenbean') !== -1);

    var greenbeanRes = validateIngest_(Object.assign({ kind: 'suppliers' }, suppBase, { source: 'greenbean' }));
    check('kind:"suppliers" + source:"greenbean" (well-formed rows) → still accepted', greenbeanRes.ok);
  })();

  check('coffee_order_app has no SUPPLIER_NAMES entry (moot for suppliers-kind now that it is rejected, but still true)',
    !('coffee_order_app' in SUPPLIER_NAMES));

  // The three rejection cases the plan names.
  (function () {
    var revBase = { kind: 'revenue', source: 'coffee_order_app', extracted_at: 'TS' };

    check('missing order_ref → rejected',
      !validateIngest_(Object.assign({}, revBase, { rows: [
        { date: '2026-08-03', department: 'Roastery', channel: 'wholesale', customer: 'Cafe X', amount: 340 }
      ] })).ok);

    check("bad department ('Kitchen') → rejected",
      !validateIngest_(Object.assign({}, revBase, { rows: [
        { date: '2026-08-03', department: 'Kitchen', channel: 'wholesale', customer: 'Cafe X', amount: 340, order_ref: 'ORD-1' }
      ] })).ok);

    check('amount as a (non-numeric) string → rejected',
      !validateIngest_(Object.assign({}, revBase, { rows: [
        { date: '2026-08-03', department: 'Roastery', channel: 'wholesale', customer: 'Cafe X', amount: '340.00abc', order_ref: 'ORD-1' }
      ] })).ok);
  })();
})();

(function testShopSpendTabsAndConstants() {
  console.log('\nshopSpend — tabs and constants (step 1):');

  // Constants exist on the globals. Not declared locally here — see the
  // shadowing note near the top of this file re: SUPPLIERS_HEADERS.
  eq('SHOPSPEND_TAB', globalThis.SHOPSPEND_TAB, 'ShopSpend');
  eq('SHOPSPEND_PULLS_TAB', globalThis.SHOPSPEND_PULLS_TAB, 'ShopSpendPulls');
  eq('SHOPSPEND_REPORT_TAB', globalThis.SHOPSPEND_REPORT_TAB, 'ShopSpend Report');

  // Header arrays are exact and ordered.
  var shHeaders = globalThis.SHOPSPEND_HEADERS;
  check('SHOPSPEND_HEADERS has 14 entries', !!shHeaders && shHeaders.length === 14);
  check('SHOPSPEND_HEADERS[0] is shop_id', !!shHeaders && shHeaders[0] === 'shop_id');
  check('SHOPSPEND_HEADERS[1] is week_label', !!shHeaders && shHeaders[1] === 'week_label');
  check('SHOPSPEND_HEADERS ends in presence',
    !!shHeaders && shHeaders[shHeaders.length - 1] === 'presence');

  var spHeaders = globalThis.SHOPSPEND_PULLS_HEADERS;
  check('SHOPSPEND_PULLS_HEADERS has 21 entries', !!spHeaders && spHeaders.length === 21);
  check('SHOPSPEND_PULLS_HEADERS[0] is fetched_at', !!spHeaders && spHeaders[0] === 'fetched_at');
  check('SHOPSPEND_PULLS_HEADERS ends in diagnostics_json',
    !!spHeaders && spHeaders[spHeaders.length - 1] === 'diagnostics_json');

  // Key cols point at the right columns, asserted through the header array so
  // a future column insert that silently breaks the key fails the suite.
  var keyCols = globalThis.SHOPSPEND_KEY_COLS;
  check('SHOPSPEND_KEY_COLS[0] indexes shop_id',
    !!shHeaders && !!keyCols && shHeaders[keyCols[0]] === 'shop_id');
  check('SHOPSPEND_KEY_COLS[1] indexes week_label',
    !!shHeaders && !!keyCols && shHeaders[keyCols[1]] === 'week_label');

  // Tab creation + idempotency + silo isolation.
  freshSheets();
  var hasFn = typeof globalThis.ensureShopSpendTabs_ === 'function';
  check('ensureShopSpendTabs_ is defined', hasFn);

  if (hasFn) {
    var tabs = ensureShopSpendTabs_(currentSS);
    check('ensureShopSpendTabs_ returns a data sheet', !!tabs && !!tabs.data);
    check('ensureShopSpendTabs_ returns a pulls sheet', !!tabs && !!tabs.pulls);
    check('ensureShopSpendTabs_ returns a report sheet', !!tabs && !!tabs.report);

    if (tabs && tabs.data && tabs.pulls && tabs.report && shHeaders && spHeaders) {
      eq('ShopSpend row 1 equals SHOPSPEND_HEADERS',
        tabs.data.getDataRange().getValues()[0], shHeaders);
      eq('ShopSpendPulls row 1 equals SHOPSPEND_PULLS_HEADERS',
        tabs.pulls.getDataRange().getValues()[0], spHeaders);
      eq('ShopSpend has exactly 1 row (header only, no phantom blank row)',
        tabs.data.getDataRange().getValues().length, 1);

      // Idempotent: a second call must not duplicate or rewrite the header.
      var tabs2 = ensureShopSpendTabs_(currentSS);
      eq('re-call: ShopSpend row count unchanged',
        tabs2.data.getDataRange().getValues().length, 1);
      eq('re-call: ShopSpend header row unchanged',
        tabs2.data.getDataRange().getValues()[0], shHeaders);
      check('re-call: same sheet objects returned, nothing new created',
        tabs2.data === tabs.data && tabs2.pulls === tabs.pulls && tabs2.report === tabs.report);
    }

    // Silo intact: pre-existing tabs untouched, and shopSpend tabs stay out
    // of the department-migration blast radius (never created as a side
    // effect of ensureShopSpendTabs_).
    eq('Suppliers headers unchanged',
      currentSS.getSheetByName('Suppliers').getDataRange().getValues()[0], SUPPLIERS_HEADERS);
    eq('Sales headers unchanged',
      currentSS.getSheetByName('Sales').getDataRange().getValues()[0], SALES_HEADERS);
    check('Revenue tab NOT created as a side effect of ensureShopSpendTabs_',
      currentSS.getSheetByName('Revenue') === null);
    check('Summary tab NOT created as a side effect of ensureShopSpendTabs_',
      currentSS.getSheetByName('Summary') === null);
  }
})();

/* ------------------------------------------------------------------ *
 * Phase 2 — doPost shopspend kind: validation + routing (step 2)
 * ------------------------------------------------------------------ */

(function testDoPostShopspendKind() {
  console.log('\ndoPost — shopspend kind (step 2):');

  function shopspendRow(overrides) {
    return Object.assign({
      date: '2026-07-27', shop_id: 'shop_1', week_label: '2026-W31',
      week_start: '2026-07-27', week_end: '2026-08-02',
      order_count: 12, amended_count: 1, total_ex_gst: 500, gst: 0, total_inc_gst: 500
    }, overrides);
  }

  var goodRow1 = {
    date: '2026-07-27', shop_id: 'shop_1', week_label: '2026-W31',
    week_start: '2026-07-27', week_end: '2026-08-02',
    order_count: 12, amended_count: 1,
    total_ex_gst: 500, gst: 0, total_inc_gst: 500,
    gst_treatment: 'EXCLUSIVE_PRIMARY', environment: 'prod',
    fetched_at: '2026-08-03T09:00:00+10:00'
  };
  var goodRow2 = {
    date: '2026-07-20', shop_id: 'shop_2', week_label: '2026-W30',
    week_start: '2026-07-20', week_end: '2026-07-26',
    order_count: 5, amended_count: 0,
    total_ex_gst: 200, gst: 0, total_inc_gst: 200,
    gst_treatment: 'EXCLUSIVE_PRIMARY', environment: 'prod'
    // no fetched_at → falls back to body.extracted_at
  };

  // Well-formed shopspend payload → ok, rowsAdded = row count, rows land on
  // ShopSpend in SHOPSPEND_HEADERS order. Tabs pre-created via
  // ensureShopSpendTabs_ (step 1, already implemented) so a rejected/no-op
  // doPost still leaves a real (header-only) sheet to read back safely,
  // rather than null-deref-ing getSheetByName.
  freshSheets();
  ensureShopSpendTabs_(currentSS);
  var res = doPostJson({
    kind: 'shopspend', source: 'shopspend', extracted_at: '2026-08-03T09:30:00+10:00',
    rows: [goodRow1, goodRow2]
  });
  eq('well-formed shopspend payload → ok', res.result, 'ok');
  eq('rowsAdded equals row count', res.rowsAdded, 2);

  var data = currentSS.getSheetByName('ShopSpend').getDataRange().getValues();
  eq('ShopSpend has header + 2 rows', data.length, 3);
  if (data.length >= 3) {
    var row1 = data[1];
    eq('row 1 lands in SHOPSPEND_HEADERS order',
      [row1[0], row1[1], cellDate(row1[2]), cellDate(row1[3])].concat(row1.slice(4)),
      ['shop_1', '2026-W31', '2026-07-27', '2026-08-02', 12, 1, 500, 0, 500,
        'EXCLUSIVE_PRIMARY', 'prod', '2026-08-03T09:00:00+10:00', 'shopspend', 'present']);

    var row2 = data[2];
    eq('row 2 (no per-row fetched_at) falls back to extracted_at', row2[11], '2026-08-03T09:30:00+10:00');
    eq('row 2 presence defaults to present', row2[13], 'present');
  }

  // Unknown kind still rejected — the whitelist widened, it did not open.
  var unknownRes = doPostJson({ kind: 'nonsense', source: 'x', extracted_at: 'TS',
    rows: [{ date: '2026-07-27' }] });
  eq('unknown kind → error', unknownRes.result, 'error');
  eq('unknown kind → message names it', unknownRes.message, 'unknown kind: nonsense');

  // Per-row validation, row index named in the message.
  var base = { kind: 'shopspend', source: 'shopspend', extracted_at: 'TS' };

  check('missing shop_id → rejected',
    !validateIngest_(Object.assign({}, base, { rows: [shopspendRow({ shop_id: '' })] })).ok);

  check("week_label '2026-W7' (single-digit week) → rejected",
    !validateIngest_(Object.assign({}, base, { rows: [shopspendRow({ week_label: '2026-W7' })] })).ok);

  check("week_label '26-W07' (2-digit year) → rejected",
    !validateIngest_(Object.assign({}, base, { rows: [shopspendRow({ week_label: '26-W07' })] })).ok);

  check('non-numeric total_ex_gst → rejected',
    !validateIngest_(Object.assign({}, base, { rows: [shopspendRow({ total_ex_gst: 'abc' })] })).ok);

  check('missing week_start → rejected',
    !validateIngest_(Object.assign({}, base, { rows: [shopspendRow({ week_start: undefined })] })).ok);

  var idxMsg = validateIngest_(Object.assign({}, base, { rows: [
    shopspendRow(), shopspendRow({ shop_id: '' })
  ] }));
  check('rejection message names the offending row index (row 1)', idxMsg.message.indexOf('row 1') !== -1);

  // date is still required on every kind — line 188 was not relaxed. The
  // client satisfies this by sending date = week_start.
  var noDateRow = shopspendRow();
  delete noDateRow.date;
  var noDateRes = validateIngest_(Object.assign({}, base, { rows: [noDateRow] }));
  check('shopspend row without date → rejected', !noDateRes.ok);
  check('...via the generic shared missing-date message', noDateRes.message.indexOf('missing date') !== -1);

  // --- weeks_complete / weeks_verified_empty validation (step 1) -----------
  check('weeks_complete as a JSON string → rejected',
    !validateIngest_(Object.assign({}, base, { rows: [], weeks_complete: '["2026-W31"]' })).ok);
  check('weeks_complete as a nested array → rejected',
    !validateIngest_(Object.assign({}, base, { rows: [], weeks_complete: [['2026-W31']] })).ok);
  check('weeks_complete with a bogus label → rejected',
    !validateIngest_(Object.assign({}, base, { rows: [], weeks_complete: ['2026-W3'] })).ok);
  check('weeks_complete with a valid label → accepted',
    validateIngest_(Object.assign({}, base, { rows: [], weeks_complete: ['2026-W31'] })).ok);

  check('weeks_verified_empty as a JSON string → rejected',
    !validateIngest_(Object.assign({}, base, {
      rows: [], weeks_complete: ['2026-W31'], weeks_verified_empty: '["2026-W31"]'
    })).ok);
  check('weeks_verified_empty as a nested array → rejected',
    !validateIngest_(Object.assign({}, base, {
      rows: [], weeks_complete: ['2026-W31'], weeks_verified_empty: [['2026-W31']]
    })).ok);
  check('weeks_verified_empty with a bogus label → rejected',
    !validateIngest_(Object.assign({}, base, {
      rows: [], weeks_complete: ['2026-W31'], weeks_verified_empty: ['2026-W3']
    })).ok);
  check('weeks_verified_empty naming a week absent from weeks_complete → rejected',
    !validateIngest_(Object.assign({}, base, {
      rows: [], weeks_complete: ['2026-W30'], weeks_verified_empty: ['2026-W31']
    })).ok);
  check('weeks_verified_empty naming a week with >=1 row in the same payload → rejected',
    !validateIngest_(Object.assign({}, base, {
      rows: [shopspendRow({ week_label: '2026-W31' })],
      weeks_complete: ['2026-W31'], weeks_verified_empty: ['2026-W31']
    })).ok);
  check('weeks_verified_empty valid (declared complete, no rows for it) → accepted',
    validateIngest_(Object.assign({}, base, {
      rows: [], weeks_complete: ['2026-W31'], weeks_verified_empty: ['2026-W31']
    })).ok);

  // --- isValidWeekLabelArray_ week-number bound 01-53 (step 1 minors) -----
  check("isValidWeekLabelArray_(['2026-W00']) → false (week 00 out of range)",
    !isValidWeekLabelArray_(['2026-W00']));
  check("isValidWeekLabelArray_(['2026-W54']) → false (week 54 out of range)",
    !isValidWeekLabelArray_(['2026-W54']));
  check("isValidWeekLabelArray_(['2026-W99']) → false (week 99 out of range)",
    !isValidWeekLabelArray_(['2026-W99']));
  check("isValidWeekLabelArray_(['2026-W01']) → true (lower bound)",
    isValidWeekLabelArray_(['2026-W01']));
  check("isValidWeekLabelArray_(['2026-W53']) → true (upper bound — ISO years can have 53 weeks)",
    isValidWeekLabelArray_(['2026-W53']));
  check("isValidWeekLabelArray_(['2020-W01']) → true (the live-probe label)",
    isValidWeekLabelArray_(['2020-W01']));

  eq('weeks_complete with out-of-range week (2026-W00) → rejected with invalid weeks_complete message',
    validateIngest_(Object.assign({}, base, { rows: [], weeks_complete: ['2026-W00'] })).message,
    'invalid weeks_complete');

  // Same bound on the per-row week_label path — one field, one strictness
  // (phase-end review minor: the row check previously kept the bare regex).
  eq('shopspend row with week_label 2026-W00 → rejected at the row level',
    validateIngest_(Object.assign({}, base, {
      rows: [Object.assign({}, goodRow1, { week_label: '2026-W00' })]
    })).message,
    'row 0 invalid week_label');
  eq('shopspend row with week_label 2026-W99 → rejected at the row level',
    validateIngest_(Object.assign({}, base, {
      rows: [Object.assign({}, goodRow1, { week_label: '2026-W99' })]
    })).message,
    'row 0 invalid week_label');
  check('shopspend row with week_label 2026-W53 → still accepted at the row level',
    validateIngest_(Object.assign({}, base, {
      rows: [Object.assign({}, goodRow1, { week_label: '2026-W53' })]
    })).ok);

  // Existing kinds unregressed: still rejects, still succeeds and writes to
  // their own tab.
  check('suppliers row missing invoice_ref → still rejected',
    !validateIngest_({ source: 'food_dairy_co', extracted_at: 'TS',
      rows: [{ date: '2026-07-01', total: 10 }] }).ok);
  check('revenue row missing order_ref → still rejected',
    !validateIngest_({ kind: 'revenue', source: 'wholesale_app', extracted_at: 'TS',
      rows: [{ date: '2026-07-01', channel: 'wholesale', customer: 'Acme', amount: 10 }] }).ok);

  freshSheets();
  var suppOk = doPostJson({ source: 'food_dairy_co', extracted_at: 'TS',
    rows: [{ date: '2026-07-01', total: 10, invoice_ref: 'REG-1' }] });
  eq('valid suppliers payload still succeeds', suppOk.result, 'ok');
  check('...and writes to Suppliers',
    currentSS.getSheetByName('Suppliers').getDataRange().getValues().length === 2);

  var revOk = doPostJson({ kind: 'revenue', source: 'wholesale_app', extracted_at: 'TS',
    rows: [{ date: '2026-07-01', channel: 'wholesale', customer: 'Acme', amount: 10, order_ref: 'REG-2' }] });
  eq('valid revenue payload still succeeds', revOk.result, 'ok');
  check('...and writes to Revenue',
    currentSS.getSheetByName('Revenue').getDataRange().getValues().length === 2);

  // tombstonesWritten / tombstonesSkipped are ALWAYS present on a shopspend
  // doPost response — an empty array, not an omission, when nothing was
  // skipped — and absent entirely on non-shopspend responses.
  freshSheets();
  ensureShopSpendTabs_(currentSS);
  var tombFieldsRes = doPostJson({
    kind: 'shopspend', source: 'shopspend', extracted_at: 'TS',
    rows: [goodRow1], weeks_complete: ['2026-W31']
  });
  eq('shopspend response → ok', tombFieldsRes.result, 'ok');
  check('tombstonesWritten present on shopspend response', 'tombstonesWritten' in tombFieldsRes);
  check('tombstonesSkipped present on shopspend response', 'tombstonesSkipped' in tombFieldsRes);
  eq('tombstonesWritten is 0 for a first, non-tombstoning pull', tombFieldsRes.tombstonesWritten, 0);
  eq('tombstonesSkipped is an empty array when nothing was skipped', tombFieldsRes.tombstonesSkipped, []);

  check('tombstonesWritten omitted on a suppliers response', !('tombstonesWritten' in suppOk));
  check('tombstonesSkipped omitted on a suppliers response', !('tombstonesSkipped' in suppOk));
  check('tombstonesWritten omitted on a revenue response', !('tombstonesWritten' in revOk));
  check('tombstonesSkipped omitted on a revenue response', !('tombstonesSkipped' in revOk));

  // Heartbeat: a successful shopspend post stamps the shopspend heartbeat via
  // the existing generic call (Code.gs:150 stalenessStampHeartbeat_).
  freshSheets();
  ensureShopSpendTabs_(currentSS);
  scriptProps = {};
  doPostJson({ kind: 'shopspend', source: 'shopspend', extracted_at: 'TS', rows: [goodRow1] });
  check('successful shopspend post stamps the shopspend heartbeat',
    'LAST_INGEST_shopspend' in scriptProps);

  // Pulls row: when body.pull is present, exactly one row is appended to
  // ShopSpendPulls, in SHOPSPEND_PULLS_HEADERS order, written AFTER the data
  // rows (the commit marker for a chunked pull). Tabs pre-created via
  // ensureShopSpendTabs_ (returns the same objects doPost's own call will
  // retrieve — see Code.gs:591-601). Since step 3, ShopSpend's data rows land
  // via one setValues() block, not one appendRow() per row (see the
  // "single block write" case below) — so ordering is asserted off the
  // spreadsheet-wide write log (tagged by sheet name), not a per-row spy.
  freshSheets();
  var preTabs = ensureShopSpendTabs_(currentSS);
  var writeLogStart = currentSS._writeLog.length;

  var pull = {
    fetched_at: '2026-08-03T09:30:00+10:00', environment: 'prod',
    from_week: '2026-W30', to_week: '2026-W31',
    matched: 2, returned: 2, truncated: false,
    warnings_count: 0, warnings: '[]',
    unpriced_sku_count: 0, unpriced_skus: '[]',
    amended_count: 1, possible_duplicate_shop_names: '[]',
    empty_range_with_invalid_labels: false, invalid_week_labels: '[]',
    gst_treatment: 'EXCLUSIVE_PRIMARY',
    diverges_from_live_pricing: false, matches_live_pricing: true,
    total_orders_scanned: 17, absent_shop_ids: '[]',
    diagnostics_json: '{}'
  };
  var pullRes = doPostJson({
    kind: 'shopspend', source: 'shopspend', extracted_at: '2026-08-03T09:30:00+10:00',
    rows: [goodRow1, goodRow2], pull: pull
  });
  eq('shopspend payload with pull → ok', pullRes.result, 'ok');
  var writesAfterPull = currentSS._writeLog.slice(writeLogStart);
  check('data written as a single block write before the pulls row (commit-marker ordering)',
    writesAfterPull.length === 2 &&
    writesAfterPull[0].sheet === 'ShopSpend' &&
    writesAfterPull[1].sheet === 'ShopSpendPulls');

  var pullsData = currentSS.getSheetByName('ShopSpendPulls').getDataRange().getValues();
  eq('exactly one row appended to ShopSpendPulls', pullsData.length, 2);
  if (pullsData.length >= 2) {
    eq('pulls row lands in SHOPSPEND_PULLS_HEADERS order',
      pullsData[1],
      [pull.fetched_at, pull.environment, pull.from_week, pull.to_week, pull.matched,
        pull.returned, pull.truncated, pull.warnings_count, pull.warnings,
        pull.unpriced_sku_count, pull.unpriced_skus, pull.amended_count,
        pull.possible_duplicate_shop_names, pull.empty_range_with_invalid_labels,
        pull.invalid_week_labels, pull.gst_treatment, pull.diverges_from_live_pricing,
        pull.matches_live_pricing, pull.total_orders_scanned, pull.absent_shop_ids,
        pull.diagnostics_json]);
  }
})();

/* ------------------------------------------------------------------ *
 * Phase 3 — ShopSpend ingest: change detection + tombstones (step 3)
 * ------------------------------------------------------------------ */

(function testShopSpendChangeDetection() {
  console.log('\ningestShopSpendRows — change detection (step 3):');

  function spRow(overrides) {
    return Object.assign({
      shop_id: 'shop_1', week_label: '2026-W31',
      week_start: '2026-07-27', week_end: '2026-08-02',
      order_count: 12, amended_count: 1,
      total_ex_gst: 500, gst: 0, total_inc_gst: 500,
      gst_treatment: 'EXCLUSIVE_PRIMARY', environment: 'prod'
    }, overrides);
  }

  // --- First pull appends everything ------------------------------------
  freshSheets();
  var tabs1 = ensureShopSpendTabs_(currentSS);
  var firstPull = [
    spRow({ shop_id: 'shop_1', week_label: '2026-W31' }),
    spRow({ shop_id: 'shop_2', week_label: '2026-W31' }),
    spRow({ shop_id: 'shop_3', week_label: '2026-W31' })
  ];
  var res1 = ingestShopSpendRows('shopspend', firstPull, 'T1', tabs1.data);
  eq('first pull: rowsAdded', res1.rowsAdded, 3);
  eq('first pull: duplicatesSkipped', res1.duplicatesSkipped, 0);
  eq('first pull: rowsUpdated is always 0', res1.rowsUpdated, 0);

  // --- Identical re-pull appends nothing (idempotent resume) ------------
  var res2 = ingestShopSpendRows('shopspend', firstPull, 'T2', tabs1.data);
  eq('identical re-pull: rowsAdded', res2.rowsAdded, 0);
  eq('identical re-pull: duplicatesSkipped', res2.duplicatesSkipped, 3);
  eq('identical re-pull: rowsUpdated is always 0', res2.rowsUpdated, 0);
  eq('identical re-pull: tab row count unchanged (header + 3)',
    tabs1.data.getDataRange().getValues().length, 4);

  // --- A changed figure appends one row, old snapshot stays -------------
  var changedPull = [
    spRow({ shop_id: 'shop_1', week_label: '2026-W31', total_ex_gst: 999 }),
    spRow({ shop_id: 'shop_2', week_label: '2026-W31' }),
    spRow({ shop_id: 'shop_3', week_label: '2026-W31' })
  ];
  var res3 = ingestShopSpendRows('shopspend', changedPull, 'T3', tabs1.data);
  eq('changed figure: rowsAdded', res3.rowsAdded, 1);
  eq('changed figure: duplicatesSkipped', res3.duplicatesSkipped, 2);

  var afterChange = tabs1.data.getDataRange().getValues();
  eq('changed figure: tab now holds header + 4 rows', afterChange.length, 5);
  var shop1Snapshots = afterChange.filter(function (r, i) {
    return i > 0 && r[0] === 'shop_1' && r[1] === '2026-W31';
  });
  eq('both shop_1 snapshots (old + new) are present', shop1Snapshots.length, 2);
  eq('old shop_1 snapshot is unmodified (total_ex_gst still 500)',
    Number(shop1Snapshots[0][6]), 500);
  eq('new shop_1 snapshot carries the changed figure (total_ex_gst 999)',
    Number(shop1Snapshots[1][6]), 999);

  // --- Each of the five figures is watched individually ------------------
  function checkSingleFigureChange(label, field, value) {
    freshSheets();
    var t = ensureShopSpendTabs_(currentSS);
    ingestShopSpendRows('shopspend', [spRow({ shop_id: 'shopX', week_label: '2026-W31' })], 'T1', t.data);
    var changed = spRow({ shop_id: 'shopX', week_label: '2026-W31' });
    changed[field] = value;
    var res = ingestShopSpendRows('shopspend', [changed], 'T2', t.data);
    eq(label, res.rowsAdded, 1);
  }
  checkSingleFigureChange('order_count change alone → appends', 'order_count', 999);
  checkSingleFigureChange('amended_count change alone → appends', 'amended_count', 999);
  checkSingleFigureChange('total_ex_gst change alone → appends', 'total_ex_gst', 999);
  checkSingleFigureChange('gst change alone → appends', 'gst', 999);
  checkSingleFigureChange('total_inc_gst change alone → appends', 'total_inc_gst', 999);

  // --- Numeric comparison, not string comparison -------------------------
  freshSheets();
  var tabsNum = ensureShopSpendTabs_(currentSS);
  ingestShopSpendRows('shopspend',
    [spRow({ shop_id: 'shopNum', week_label: '2026-W31', total_ex_gst: 3360.7 })],
    'T1', tabsNum.data);
  var resNum = ingestShopSpendRows('shopspend',
    [spRow({ shop_id: 'shopNum', week_label: '2026-W31', total_ex_gst: '3360.70' })],
    'T2', tabsNum.data);
  eq('numerically-equal figure sent as a different string type is NOT a change',
    resNum.rowsAdded, 0);
  eq('...and counts as a duplicate', resNum.duplicatesSkipped, 1);

  // --- Latest = append order, not fetched_at (DST fixture) --------------
  freshSheets();
  var tabsDst = ensureShopSpendTabs_(currentSS);
  var rowA = spRow({
    shop_id: 'shopDST', week_label: '2026-W15',
    fetched_at: '2026-04-04T10:00:00+11:00', total_ex_gst: 100
  });
  var resDstA = ingestShopSpendRows('shopspend', [rowA], 'TA', tabsDst.data);
  eq('DST fixture: first row appends', resDstA.rowsAdded, 1);

  var rowB = spRow({
    shop_id: 'shopDST', week_label: '2026-W15',
    fetched_at: '2026-04-05T10:00:00+10:00', total_ex_gst: 200
  });
  var resDstB = ingestShopSpendRows('shopspend', [rowB], 'TB', tabsDst.data);
  eq('DST fixture: second row (changed figure) appends', resDstB.rowsAdded, 1);

  // A re-pull matching row B's figures must be treated as unchanged — the
  // latest snapshot is row B (last in append order), not whichever row's
  // fetched_at happens to compare largest as a string.
  var rowC = spRow({
    shop_id: 'shopDST', week_label: '2026-W15',
    fetched_at: '2026-04-06T09:00:00+10:00', total_ex_gst: 200
  });
  var resDstC = ingestShopSpendRows('shopspend', [rowC], 'TC', tabsDst.data);
  eq('DST fixture: latest = append order — re-pull matching row B is unchanged',
    resDstC.rowsAdded, 0);
  eq('...and counted as a duplicate', resDstC.duplicatesSkipped, 1);

  // --- Tombstone on disappearance (declared complete) ---------------------
  freshSheets();
  var tabsTomb = ensureShopSpendTabs_(currentSS);
  var pullA = [
    spRow({ shop_id: 'shopTombX', week_label: '2026-W31' }),
    spRow({ shop_id: 'shopTombY', week_label: '2026-W31' })
  ];
  var resTombA = ingestShopSpendRows('shopspend', pullA, 'TA', tabsTomb.data, undefined, undefined, ['2026-W31']);
  eq('tombstone setup: pull A appends both shops', resTombA.rowsAdded, 2);

  var pullB = [spRow({ shop_id: 'shopTombX', week_label: '2026-W31' })];
  var resTombB = ingestShopSpendRows('shopspend', pullB, 'TB', tabsTomb.data, undefined, undefined, ['2026-W31']);
  eq('tombstone: pull B declares 2026-W31 complete, missing shopTombY → appends exactly one tombstone',
    resTombB.rowsAdded, 1);
  eq('tombstone: shopTombX itself is unchanged (duplicate)', resTombB.duplicatesSkipped, 1);
  eq('tombstone: tombstonesWritten reflects the one write', resTombB.tombstonesWritten, 1);
  eq('tombstone: nothing skipped by the breaker (below the 5-shop floor)', resTombB.tombstonesSkipped, []);

  var dataAfterTombB = tabsTomb.data.getDataRange().getValues();
  var tombRow = dataAfterTombB[dataAfterTombB.length - 1];
  eq('tombstone row key is shopTombY / 2026-W31', [tombRow[0], tombRow[1]], ['shopTombY', '2026-W31']);
  eq('tombstone row presence is absent', tombRow[13], 'absent');
  eq('tombstone row figures are all zero',
    [Number(tombRow[4]), Number(tombRow[5]), Number(tombRow[6]), Number(tombRow[7]), Number(tombRow[8])],
    [0, 0, 0, 0, 0]);

  // --- Undeclared week: rows present, weeks_complete absent → tombstones
  // nothing, and a Logger warning is emitted (the field-absent degraded mode
  // must be visible, not silent).
  freshSheets();
  var tabsUndeclared = ensureShopSpendTabs_(currentSS);
  ingestShopSpendRows('shopspend', [
    spRow({ shop_id: 'shopUndX', week_label: '2026-W31' }),
    spRow({ shop_id: 'shopUndY', week_label: '2026-W31' })
  ], 'T1', tabsUndeclared.data);
  clearLoggedMessages();
  var resUndeclared = ingestShopSpendRows('shopspend',
    [spRow({ shop_id: 'shopUndX', week_label: '2026-W31' })], 'T2', tabsUndeclared.data);
  eq('week not declared complete: missing shopUndY is NOT tombstoned', resUndeclared.rowsAdded, 0);
  eq('week not declared complete: tombstonesWritten is 0', resUndeclared.tombstonesWritten, 0);
  check('weeks_complete absent + rows present → a Logger warning is logged',
    lastLoggedMessages().some(function (m) { return /weeks_complete/i.test(m); }));
  var dataUndeclared = tabsUndeclared.data.getDataRange().getValues();
  var shopUndYRow = dataUndeclared.filter(function (r, i) { return i > 0 && r[0] === 'shopUndY'; })[0];
  eq('shopUndY row is still present, untouched', shopUndYRow[13], 'present');

  clearLoggedMessages();
  ingestShopSpendRows('shopspend', [], 'T3', tabsUndeclared.data);
  check('weeks_complete absent + rows EMPTY → no warning (nothing to warn about)',
    !lastLoggedMessages().some(function (m) { return /weeks_complete/i.test(m); }));

  // --- Tombstone scope: only weeks_complete declares scope, never rows seen
  freshSheets();
  var tabsScope = ensureShopSpendTabs_(currentSS);
  ingestShopSpendRows('shopspend', [
    spRow({ shop_id: 'shopOldWeekA', week_label: '2026-W30', week_start: '2026-07-20', week_end: '2026-07-26' }),
    spRow({ shop_id: 'shopOldWeekB', week_label: '2026-W30', week_start: '2026-07-20', week_end: '2026-07-26' })
  ], 'T1', tabsScope.data);
  // Second pull carries a ROW for week 30 (shopOldWeekA, unchanged) alongside
  // a new week-31 shop, but declares ONLY 2026-W31 complete. Under the OLD
  // "weeks seen in rows" scoping this would tombstone shopOldWeekB (missing
  // from this payload); under the new declared-scope design it must not.
  var resScope = ingestShopSpendRows('shopspend', [
    spRow({ shop_id: 'shopOldWeekA', week_label: '2026-W30', week_start: '2026-07-20', week_end: '2026-07-26' }),
    spRow({ shop_id: 'shopNewWeek', week_label: '2026-W31' })
  ], 'T2', tabsScope.data, undefined, undefined, ['2026-W31']);
  eq('scoped pull: only the new week-31 row is appended (shopOldWeekA is a duplicate)', resScope.rowsAdded, 1);
  eq('scoped pull: tombstonesWritten is 0 — week 30 has rows but is not declared complete',
    resScope.tombstonesWritten, 0);

  var dataScope = tabsScope.data.getDataRange().getValues();
  var oldWeekBRow = dataScope.filter(function (r, i) { return i > 0 && r[0] === 'shopOldWeekB'; })[0];
  eq('shopOldWeekB / 2026-W30 row is untouched (still present) — week 30 not declared complete',
    oldWeekBRow[13], 'present');

  // --- No double tombstone -------------------------------------------------
  var pullC = [spRow({ shop_id: 'shopTombX', week_label: '2026-W31' })]; // still missing shopTombY
  var resTombC = ingestShopSpendRows('shopspend', pullC, 'TC', tabsTomb.data, undefined, undefined, ['2026-W31']);
  eq('no double tombstone: shopTombY already absent → no new row for it', resTombC.rowsAdded, 0);
  eq('...shopTombX unchanged → duplicate', resTombC.duplicatesSkipped, 1);
  eq('no double tombstone: tombstonesWritten is 0', resTombC.tombstonesWritten, 0);

  // --- Reappearance --------------------------------------------------------
  var pullD = [
    spRow({ shop_id: 'shopTombX', week_label: '2026-W31' }),
    spRow({ shop_id: 'shopTombY', week_label: '2026-W31' }) // same figures as pull A
  ];
  var resTombD = ingestShopSpendRows('shopspend', pullD, 'TD', tabsTomb.data, undefined, undefined, ['2026-W31']);
  eq('reappearance: shopTombY returns → appends a fresh present row', resTombD.rowsAdded, 1);
  eq('reappearance: shopTombX still unchanged → duplicate', resTombD.duplicatesSkipped, 1);

  var dataAfterTombD = tabsTomb.data.getDataRange().getValues();
  var shopYPresence = dataAfterTombD
    .filter(function (r, i) { return i > 0 && r[0] === 'shopTombY'; })
    .map(function (r) { return r[13]; });
  eq('shopTombY snapshot history is present, absent, present', shopYPresence, ['present', 'absent', 'present']);

  // --- Empty payload tombstones nothing -------------------------------------
  freshSheets();
  var tabsEmpty = ensureShopSpendTabs_(currentSS);
  ingestShopSpendRows('shopspend',
    [spRow({ shop_id: 'shopZ', week_label: '2026-W31' })], 'T1', tabsEmpty.data);
  var resEmpty = ingestShopSpendRows('shopspend', [], 'T2', tabsEmpty.data);
  eq('empty payload: rowsAdded', resEmpty.rowsAdded, 0);
  eq('empty payload: duplicatesSkipped', resEmpty.duplicatesSkipped, 0);
  var dataEmpty = tabsEmpty.data.getDataRange().getValues();
  eq('empty payload: tab row count unchanged (header + 1)', dataEmpty.length, 2);
  eq('empty payload: existing shopZ row is still present, untombstoned', dataEmpty[1][13], 'present');

  // --- Single block write, not one appendRow per row ------------------------
  freshSheets();
  var tabsBlock = ensureShopSpendTabs_(currentSS);
  tabsBlock.data.clearWriteCalls(); // Clear setup writes (header row)
  var blockPull = [
    spRow({ shop_id: 's1', week_label: '2026-W31' }),
    spRow({ shop_id: 's2', week_label: '2026-W31' }),
    spRow({ shop_id: 's3', week_label: '2026-W31' })
  ];
  ingestShopSpendRows('shopspend', blockPull, 'T1', tabsBlock.data);
  var writeCalls = tabsBlock.data.getWriteCalls();
  eq('single block write: exactly one write call for 3 new rows', writeCalls.length, 1);
  if (writeCalls.length === 1) {
    eq('...and it is a setValues() call, not per-row appendRow()', writeCalls[0].type, 'setValues');
    eq('...covering all 3 rows in one call', writeCalls[0].numRows, 3);
  }

  // A batch with a tombstone still writes changed rows + tombstone in ONE call.
  freshSheets();
  var tabsBlock2 = ensureShopSpendTabs_(currentSS);
  tabsBlock2.data.clearWriteCalls(); // Clear setup writes (header row)
  ingestShopSpendRows('shopspend',
    [spRow({ shop_id: 'blkX', week_label: '2026-W31' }), spRow({ shop_id: 'blkY', week_label: '2026-W31' })],
    'T1', tabsBlock2.data);
  ingestShopSpendRows('shopspend',
    [spRow({ shop_id: 'blkX', week_label: '2026-W31', total_ex_gst: 777 })], // blkY tombstoned too
    'T2', tabsBlock2.data, undefined, undefined, ['2026-W31']);
  var writeCallsAfterTomb = tabsBlock2.data.getWriteCalls();
  eq('changed row + tombstone still land in a single block write',
    writeCallsAfterTomb.length, 2); // one for the first pull, one for the second
  if (writeCallsAfterTomb.length === 2) {
    eq('the second call covers both the changed row and the tombstone',
      writeCallsAfterTomb[1].numRows, 2);
  }

  // A pull with nothing to write (no changes, no tombstones) issues NO write.
  freshSheets();
  var tabsNoWrite = ensureShopSpendTabs_(currentSS);
  tabsNoWrite.data.clearWriteCalls(); // Clear setup writes (header row)
  ingestShopSpendRows('shopspend',
    [spRow({ shop_id: 'nwX', week_label: '2026-W31' })], 'T1', tabsNoWrite.data);
  var callsBeforeNoop = tabsNoWrite.data.getWriteCalls().length;
  ingestShopSpendRows('shopspend',
    [spRow({ shop_id: 'nwX', week_label: '2026-W31' })], 'T2', tabsNoWrite.data);
  eq('an all-duplicate pull issues no write call at all',
    tabsNoWrite.data.getWriteCalls().length, callsBeforeNoop);

  // --- Date cells round-trip correctly (cellDate, not String) --------------
  freshSheets();
  var tabsDate = ensureShopSpendTabs_(currentSS);
  ingestShopSpendRows('shopspend',
    [spRow({ shop_id: 'shopDate', week_label: '2026-W31', week_start: '2026-07-27', week_end: '2026-08-02' })],
    'T1', tabsDate.data);
  var dateRow = tabsDate.data.getDataRange().getValues()[1];
  eq('week_start round-trips via cellDate', cellDate(dateRow[2]), '2026-07-27');
  eq('week_end round-trips via cellDate', cellDate(dateRow[3]), '2026-08-02');
})();

/* ------------------------------------------------------------------ *
 * Phase 3b — tombstone-weeks-complete (step 1): weeks_complete gates
 * tombstoning, plus the blast-radius circuit breaker.
 * ------------------------------------------------------------------ */

(function testShopSpendTombstoneWeeksComplete() {
  console.log('\ningestShopSpendRows — weeks_complete tombstone gating + breaker (step 1):');

  function spRow(overrides) {
    return Object.assign({
      shop_id: 'shop_1', week_label: '2026-W31',
      week_start: '2026-07-27', week_end: '2026-08-02',
      order_count: 12, amended_count: 1,
      total_ex_gst: 500, gst: 0, total_inc_gst: 500,
      gst_treatment: 'EXCLUSIVE_PRIMARY', environment: 'prod'
    }, overrides);
  }

  function buildShops(n, weekLabel, prefix) {
    var arr = [];
    for (var i = 0; i < n; i++) {
      arr.push(spRow({ shop_id: (prefix || 'shop') + i, week_label: weekLabel }));
    }
    return arr;
  }

  // --- C1 repro: two sequential half-payloads for one week, neither
  // declaring it complete (the real split-chunk shape) → zero tombstones.
  freshSheets();
  var tabsSplit = ensureShopSpendTabs_(currentSS);
  var splitRes1 = ingestShopSpendRows('shopspend', [
    spRow({ shop_id: 'shopSplitA', week_label: '2026-W31' }),
    spRow({ shop_id: 'shopSplitB', week_label: '2026-W31' })
  ], 'T1', tabsSplit.data); // half 1 — split week, not declared complete
  var splitRes2 = ingestShopSpendRows('shopspend', [
    spRow({ shop_id: 'shopSplitC', week_label: '2026-W31' }),
    spRow({ shop_id: 'shopSplitD', week_label: '2026-W31' })
  ], 'T2', tabsSplit.data); // half 2 — split week, not declared complete
  eq('C1 repro: half 1 writes zero tombstones', splitRes1.tombstonesWritten, 0);
  eq('C1 repro: half 2 writes zero tombstones (does not tombstone half 1s shops)', splitRes2.tombstonesWritten, 0);
  var dataSplit = tabsSplit.data.getDataRange().getValues();
  eq('C1 repro: exactly header + 4 data rows, no tombstone rows appended', dataSplit.length, 5);
  check('C1 repro: all four shops remain present',
    dataSplit.slice(1).every(function (r) { return r[13] === 'present'; }));

  var splitRes1b = ingestShopSpendRows('shopspend', [
    spRow({ shop_id: 'shopSplitA', week_label: '2026-W31' }),
    spRow({ shop_id: 'shopSplitB', week_label: '2026-W31' })
  ], 'T3', tabsSplit.data);
  eq('C1 repro: identical re-post of half 1 appends nothing', splitRes1b.rowsAdded, 0);
  eq('C1 repro: identical re-post writes zero tombstones', splitRes1b.tombstonesWritten, 0);

  // --- Identical re-post of a COMPLETE week appends nothing ---------------
  freshSheets();
  var tabsCompleteRepost = ensureShopSpendTabs_(currentSS);
  var completeWeekRows = [
    spRow({ shop_id: 'shopCompA', week_label: '2026-W31' }),
    spRow({ shop_id: 'shopCompB', week_label: '2026-W31' })
  ];
  ingestShopSpendRows('shopspend', completeWeekRows, 'T1', tabsCompleteRepost.data, undefined, undefined, ['2026-W31']);
  var repostRes = ingestShopSpendRows('shopspend', completeWeekRows, 'T2', tabsCompleteRepost.data,
    undefined, undefined, ['2026-W31']);
  eq('identical re-post of a complete week: rowsAdded is 0', repostRes.rowsAdded, 0);
  eq('identical re-post of a complete week: tombstonesWritten is 0', repostRes.tombstonesWritten, 0);
  eq('identical re-post of a complete week: duplicatesSkipped is 2', repostRes.duplicatesSkipped, 2);

  // --- Truncated label never matches: "2026-W3" must not cover "2026-W31" -
  freshSheets();
  var tabsTrunc = ensureShopSpendTabs_(currentSS);
  ingestShopSpendRows('shopspend', [
    spRow({ shop_id: 'shopTruncA', week_label: '2026-W31' }),
    spRow({ shop_id: 'shopTruncB', week_label: '2026-W31' })
  ], 'T1', tabsTrunc.data, undefined, undefined, ['2026-W31']);
  var resTrunc = ingestShopSpendRows('shopspend',
    [spRow({ shop_id: 'shopTruncA', week_label: '2026-W31' })], 'T2', tabsTrunc.data,
    undefined, undefined, ['2026-W3']); // truncated label — must not indexOf-match '2026-W31'
  eq('truncated label 2026-W3 does not match 2026-W31 — no tombstone', resTrunc.tombstonesWritten, 0);
  eq('truncated label: shopTruncB (missing from payload) is not tombstoned', resTrunc.rowsAdded, 0);
  var dataTrunc = tabsTrunc.data.getDataRange().getValues();
  var shopTruncBRow = dataTrunc.filter(function (r, i) { return i > 0 && r[0] === 'shopTruncB'; })[0];
  eq('shopTruncB stays present', shopTruncBRow[13], 'present');

  // --- Breaker floor: below 5 present shop-weeks, a 100% unverified
  // tombstone still WRITES (the floor exists so a 2-of-3-shop closure isn't
  // permanently suppressed).
  freshSheets();
  var tabsFloor3 = ensureShopSpendTabs_(currentSS);
  ingestShopSpendRows('shopspend', buildShops(3, '2026-W31', 'floor3'), 'T1', tabsFloor3.data,
    undefined, undefined, ['2026-W31']);
  var resFloor3 = ingestShopSpendRows('shopspend', [], 'T2', tabsFloor3.data, undefined, undefined, ['2026-W31']);
  eq('below the 5-shop floor: 100% unverified still writes (floor not met)', resFloor3.tombstonesWritten, 3);
  eq('below the 5-shop floor: nothing skipped', resFloor3.tombstonesSkipped, []);

  // --- Breaker: >=5 present, 100% unverified missing → SKIPPED, reported.
  freshSheets();
  var tabsUnverified5 = ensureShopSpendTabs_(currentSS);
  ingestShopSpendRows('shopspend', buildShops(5, '2026-W31', 'unv5'), 'T1', tabsUnverified5.data,
    undefined, undefined, ['2026-W31']);
  var resUnverified5 = ingestShopSpendRows('shopspend', [], 'T2', tabsUnverified5.data,
    undefined, undefined, ['2026-W31']);
  eq('unverified 100% with 5 present (>= floor): breaker skips, tombstonesWritten 0',
    resUnverified5.tombstonesWritten, 0);
  eq('unverified 100% with 5 present: rowsAdded 0 (skip means no tombstone rows land)', resUnverified5.rowsAdded, 0);
  eq('unverified 100% with 5 present: week appears in tombstonesSkipped',
    resUnverified5.tombstonesSkipped, [{ week: '2026-W31', wouldHaveWritten: 5, present: 5 }]);
  var dataUnverified5 = tabsUnverified5.data.getDataRange().getValues();
  check('unverified 100% with 5 present: all 5 shops remain present (suppressed, not written)',
    dataUnverified5.slice(1).every(function (r) { return r[13] === 'present'; }));

  // --- Review finding [1]: the skip is STICKY and must be durably recorded --
  // docs/api.md promises the suppression "stays suppressed until a human
  // confirms it", but the only trace was the returned array -> stderr -> a
  // gitignored log file. The watchdog still reports healthy because a
  // ShopSpendPulls row was written. A Logger.log entry is the durable
  // server-side record that survives the client not being watched.
  freshSheets();
  clearLoggedMessages();
  var tabsSticky = ensureShopSpendTabs_(currentSS);
  ingestShopSpendRows('shopspend', buildShops(5, '2026-W31', 'sticky'), 'T1', tabsSticky.data,
    undefined, undefined, ['2026-W31']);
  var resSticky = ingestShopSpendRows('shopspend', [], 'T2', tabsSticky.data,
    undefined, undefined, ['2026-W31']);
  eq('sticky skip: still suppressed', resSticky.tombstonesWritten, 0);
  var stickyLogs = lastLoggedMessages().join('\n');
  check('breaker skip is Logger.logged, not only returned on the wire',
    stickyLogs.indexOf('2026-W31') !== -1 && stickyLogs.toLowerCase().indexOf('skip') !== -1);

  // --- Breaker boundary: exactly 50% still writes; 51% is skipped ---------
  freshSheets();
  var tabsHalf = ensureShopSpendTabs_(currentSS);
  var hundredShops = buildShops(100, '2026-W31', 'half');
  ingestShopSpendRows('shopspend', hundredShops, 'T1', tabsHalf.data, undefined, undefined, ['2026-W31']);
  var keep50 = hundredShops.slice(0, 50); // 50 missing → exactly 50%, not "more than half"
  var res50 = ingestShopSpendRows('shopspend', keep50, 'T2', tabsHalf.data, undefined, undefined, ['2026-W31']);
  eq('exactly 50% missing (not more than half): still writes', res50.tombstonesWritten, 50);
  eq('exactly 50%: nothing skipped', res50.tombstonesSkipped, []);

  freshSheets();
  var tabsFiftyOne = ensureShopSpendTabs_(currentSS);
  ingestShopSpendRows('shopspend', hundredShops, 'T1', tabsFiftyOne.data, undefined, undefined, ['2026-W31']);
  var keep49 = hundredShops.slice(0, 49); // 51 missing → 51%, "more than half"
  var res51 = ingestShopSpendRows('shopspend', keep49, 'T2', tabsFiftyOne.data, undefined, undefined, ['2026-W31']);
  eq('51% missing (more than half): breaker skips', res51.tombstonesWritten, 0);
  eq('51% missing: week reported in tombstonesSkipped',
    res51.tombstonesSkipped, [{ week: '2026-W31', wouldHaveWritten: 51, present: 100 }]);

  // --- The skip is sticky: it never self-heals on its own ------------------
  freshSheets();
  var tabsSticky = ensureShopSpendTabs_(currentSS);
  ingestShopSpendRows('shopspend', buildShops(5, '2026-W31', 'sticky'), 'T1', tabsSticky.data,
    undefined, undefined, ['2026-W31']);
  var stickyRes1 = ingestShopSpendRows('shopspend', [], 'T2', tabsSticky.data, undefined, undefined, ['2026-W31']);
  var stickyRes2 = ingestShopSpendRows('shopspend', [], 'T3', tabsSticky.data, undefined, undefined, ['2026-W31']);
  eq('sticky skip: pull 1 skips', stickyRes1.tombstonesWritten, 0);
  eq('sticky skip: pull 1 reports the week skipped',
    stickyRes1.tombstonesSkipped, [{ week: '2026-W31', wouldHaveWritten: 5, present: 5 }]);
  eq('sticky skip: pull 2 (identical) skips again', stickyRes2.tombstonesWritten, 0);
  eq('sticky skip: pull 2 reports the week skipped again (non-self-healing)',
    stickyRes2.tombstonesSkipped, [{ week: '2026-W31', wouldHaveWritten: 5, present: 5 }]);

  // --- weeks_verified_empty exemption: rows:[] + declared complete + -----
  // verified empty → tombstones every present shop (100%, breaker exempt),
  // without throwing even though nothing to iterate for figures.
  freshSheets();
  var tabsVerifiedEmpty = ensureShopSpendTabs_(currentSS);
  ingestShopSpendRows('shopspend', buildShops(5, '2026-W31', 'vEmpty'), 'T1', tabsVerifiedEmpty.data,
    undefined, undefined, ['2026-W31']);
  var resVerifiedEmpty;
  var verifiedEmptyThrew = false;
  try {
    resVerifiedEmpty = ingestShopSpendRows('shopspend', [], 'T2', tabsVerifiedEmpty.data,
      undefined, undefined, ['2026-W31'], ['2026-W31']);
  } catch (e) {
    verifiedEmptyThrew = true;
  }
  check('rows:[] + weeks_complete + weeks_verified_empty does not throw', !verifiedEmptyThrew);
  if (!verifiedEmptyThrew) {
    eq('verified-empty week: tombstones every present shop (100%, breaker exempt)',
      resVerifiedEmpty.tombstonesWritten, 5);
    eq('verified-empty week: nothing skipped', resVerifiedEmpty.tombstonesSkipped, []);
  }

  // --- Belt-and-braces: even with validation bypassed, a rows-carrying week
  // is dropped from the exemption set rather than trusted blindly.
  freshSheets();
  var tabsBelt = ensureShopSpendTabs_(currentSS);
  ingestShopSpendRows('shopspend', buildShops(5, '2026-W31', 'belt'), 'T1', tabsBelt.data,
    undefined, undefined, ['2026-W31']);
  var beltRows = [spRow({ shop_id: 'beltNew', week_label: '2026-W31' })]; // a row for the "verified empty" week
  var resBelt = ingestShopSpendRows('shopspend', beltRows, 'T2', tabsBelt.data,
    undefined, undefined, ['2026-W31'], ['2026-W31']); // validateIngest_ would reject this combo — bypassed here
  eq('belt-and-braces: a rows-carrying "verified empty" week is NOT treated as exempt — breaker still applies',
    resBelt.tombstonesWritten, 0);
  eq('belt-and-braces: the week is reported skipped, not silently 100%-tombstoned',
    resBelt.tombstonesSkipped, [{ week: '2026-W31', wouldHaveWritten: 5, present: 5 }]);
})();

/* ------------------------------------------------------------------ *
 * Phase 3c — docs/api.md documents the tombstone response fields and the
 * mass-absence confirmation procedure (step 1).
 * ------------------------------------------------------------------ */

(function testShopSpendApiDocsUpdated() {
  console.log('\ndocs/api.md — tombstone fields + confirmation procedure (step 1):');

  var apiDocPath = path.join(GAS_DIR, '..', '..', 'docs', 'api.md');
  var apiDoc = fs.existsSync(apiDocPath) ? fs.readFileSync(apiDocPath, 'utf8') : '';
  check('docs/api.md documents tombstonesWritten', apiDoc.indexOf('tombstonesWritten') !== -1);
  check('docs/api.md documents tombstonesSkipped', apiDoc.indexOf('tombstonesSkipped') !== -1);
  check('docs/api.md documents a mass-absence confirmation procedure',
    /confirm/i.test(apiDoc) && /absen/i.test(apiDoc));
})();

/* ------------------------------------------------------------------ *
 * Phase 4 — ShopSpend Report builder (step 6)
 *
 * shopspend.gs has no prior report-builder code to follow, so this test
 * section FIXES the contract the implementation must match:
 *
 *   shopSpendReportBlock_(snapshotRows, latestPullRow) -> Array<Array>
 *     snapshotRows  — raw ShopSpend data rows, SHOPSPEND_HEADERS column
 *                      order, append order, HEADER ROW EXCLUDED (exactly
 *                      sheet.getDataRange().getValues().slice(1)).
 *     latestPullRow — the single most-recent ShopSpendPulls row,
 *                      SHOPSPEND_PULLS_HEADERS column order (the last
 *                      element of pullsSheet.getDataRange().getValues()).
 *     Returns banner rows, then a grid header row (first cell literal
 *     'Shop', remaining cells ISO week labels sorted numerically), then one
 *     row per shop (first cell shop_id, remaining cells the per-week
 *     rendering below).
 *
 *   Per-cell grid rendering for (shop, week):
 *     - no snapshot for that key             → '' normally, 'unconfirmed'
 *                                               when the pull's
 *                                               empty_range_with_invalid_labels
 *                                               is true.
 *     - latest snapshot presence === 'absent' → 'stale' (never a number).
 *     - otherwise                             → a string containing the
 *                                               total_inc_gst figure,
 *                                               prefixed with '~' when the
 *                                               pull's unpriced_sku_count > 0,
 *                                               containing 'amended' when
 *                                               that snapshot's amended_count
 *                                               > 0.
 *
 *   buildShopSpendReport() -> { refused: 'locked' } | object
 *     Zero-arg entry point wrapped in withScriptLock_, mirroring
 *     weeklySummarize (Code.gs:1595-1606). Reads ShopSpend + ShopSpendPulls
 *     off the hub, builds the block via shopSpendReportBlock_, then issues
 *     exactly ONE report.clearContents() followed by ONE
 *     report.getRange(...).setValues(block) — never a per-row write. Never
 *     writes to ShopSpend or ShopSpendPulls.
 * ------------------------------------------------------------------ */

(function testShopSpendReportBuilder() {
  console.log('\nshopSpend — report builder (step 6):');

  function ssRow(overrides) {
    var defaults = {
      shop_id: 'shop_1', week_label: '2026-W31', week_start: '2026-07-27', week_end: '2026-08-02',
      order_count: 12, amended_count: 0, total_ex_gst: 500, gst: 0, total_inc_gst: 500,
      gst_treatment: 'EXCLUSIVE_PRIMARY', environment: 'prod', fetched_at: '2026-08-03T09:00:00+10:00',
      source: 'shopspend', presence: 'present'
    };
    var merged = Object.assign({}, defaults, overrides);
    return SHOPSPEND_HEADERS.map(function (h) { return merged[h]; });
  }

  function pullFields(overrides) {
    return Object.assign({
      fetched_at: '2026-08-03T09:30:00+10:00', environment: 'prod',
      from_week: '2026-W30', to_week: '2026-W31',
      matched: 1, returned: 1, truncated: false,
      warnings_count: 0, warnings: '[]',
      unpriced_sku_count: 0, unpriced_skus: '[]',
      amended_count: 0, possible_duplicate_shop_names: '[]',
      empty_range_with_invalid_labels: false, invalid_week_labels: '[]',
      gst_treatment: 'EXCLUSIVE_PRIMARY',
      // Step 3: the real connector now emits "" (not assessed) as the normal
      // case — booleans are a legacy-row regression fixture, never the default.
      diverges_from_live_pricing: '', matches_live_pricing: '',
      total_orders_scanned: 10, absent_shop_ids: '[]',
      diagnostics_json: '{}'
    }, overrides);
  }
  function pullRow(overrides) {
    var f = pullFields(overrides);
    return SHOPSPEND_PULLS_HEADERS.map(function (h) { return f[h]; });
  }

  function shopSpendRowObj(overrides) {
    return Object.assign({
      shop_id: 'shop_1', week_label: '2026-W31',
      week_start: '2026-07-27', week_end: '2026-08-02',
      order_count: 12, amended_count: 1,
      total_ex_gst: 500, gst: 0, total_inc_gst: 500,
      gst_treatment: 'EXCLUSIVE_PRIMARY', environment: 'prod'
    }, overrides);
  }

  // Every cell joined so a banner phrase or figure can be found regardless
  // of which row/column the implementation places it in.
  function flattenBlock(block) {
    return block.map(function (row) { return row.join(' ␟ '); }).join('\n');
  }
  function findGridHeaderRow(block) {
    for (var i = 0; i < block.length; i++) {
      if (block[i] && block[i][0] === 'Shop') return block[i];
    }
    return null;
  }
  function findShopRow(block, shopId) {
    for (var i = 0; i < block.length; i++) {
      if (block[i] && block[i][0] === shopId) return block[i];
    }
    return null;
  }

  var hasBlockFn = typeof shopSpendReportBlock_ === 'function';
  var hasBuildFn = typeof buildShopSpendReport === 'function';
  check('shopSpendReportBlock_ is defined', hasBlockFn);
  check('buildShopSpendReport is defined', hasBuildFn);

  if (!hasBlockFn) {
    console.log('  (skipping shopSpendReportBlock_ cases — function not defined)');
  } else {

  // --- Week ordering: numeric (year, weekNumber), never lexicographic ----
  (function () {
    var rows = [
      ssRow({ shop_id: 'shopA', week_label: '2026-W52', total_inc_gst: 100 }),
      ssRow({ shop_id: 'shopA', week_label: '2026-W9', total_inc_gst: 200 }),
      ssRow({ shop_id: 'shopA', week_label: '2027-W01', total_inc_gst: 300 }),
      ssRow({ shop_id: 'shopA', week_label: '2026-W10', total_inc_gst: 400 })
    ];
    var block = shopSpendReportBlock_(rows, pullRow());
    var header = findGridHeaderRow(block);
    check('grid header row found (first cell literal "Shop")', !!header);
    if (header) {
      eq('week columns sorted numerically: W9, W10, W52, then 2027-W01',
        header.slice(1), ['2026-W9', '2026-W10', '2026-W52', '2027-W01']);
      var lexOrder = header.slice(1).slice().sort();
      check('contrast: a lexicographic string sort of the same labels puts 2026-W10 before 2026-W9 — proving the grid is NOT string-sorted',
        lexOrder[0] === '2026-W10' && lexOrder.indexOf('2026-W9') > lexOrder.indexOf('2026-W10'));
    }
  })();

  // --- Latest snapshot wins: append order, not fetched_at --------------
  (function () {
    var rows = [
      ssRow({ shop_id: 'shopB', week_label: '2026-W31', total_inc_gst: 500, fetched_at: '2026-08-01T09:00:00+10:00' }),
      ssRow({ shop_id: 'shopB', week_label: '2026-W31', total_inc_gst: 999, fetched_at: '2026-08-02T09:00:00+10:00' })
    ];
    var block = shopSpendReportBlock_(rows, pullRow());
    var header = findGridHeaderRow(block);
    var shopRow = findShopRow(block, 'shopB');
    check('shop row found', !!shopRow && !!header);
    if (shopRow && header) {
      var col = header.indexOf('2026-W31');
      check('latest (last-appended) snapshot wins — cell shows 999, not 500',
        col > 0 && String(shopRow[col]).indexOf('999') !== -1 && String(shopRow[col]).indexOf('500') === -1);
    }

    // DST fixture: a +11:00 row appended BEFORE a +10:00 row for the same
    // key. A lexicographic compare on fetched_at text would rank '+10:00'
    // ahead of '+11:00' and pick the wrong row — resolution must be by
    // ARRAY (append) order only, per docs/schema.md's "latest = last row in
    // append order, never max(fetched_at)" rule.
    var dstRows = [
      ssRow({ shop_id: 'shopDst', week_label: '2026-W15', total_inc_gst: 111, fetched_at: '2026-04-05T08:00:00+11:00' }),
      ssRow({ shop_id: 'shopDst', week_label: '2026-W15', total_inc_gst: 222, fetched_at: '2026-04-05T08:30:00+10:00' })
    ];
    var dstBlock = shopSpendReportBlock_(dstRows, pullRow());
    var dstHeader = findGridHeaderRow(dstBlock);
    var dstShopRow = findShopRow(dstBlock, 'shopDst');
    check('DST fixture: shop row found', !!dstShopRow && !!dstHeader);
    if (dstShopRow && dstHeader) {
      var dstCol = dstHeader.indexOf('2026-W15');
      check('DST fixture: latest = append order — resolves to the SECOND row (222), not the first (111)',
        dstCol > 0 && String(dstShopRow[dstCol]).indexOf('222') !== -1 && String(dstShopRow[dstCol]).indexOf('111') === -1);
    }
  })();

  // --- Baseline build: only the "always" banners fire -------------------
  (function () {
    var rows = [ssRow({ shop_id: 'shopClean', week_label: '2026-W31', total_inc_gst: 500 })];
    var fetchedAt = '2026-08-03T09:30:00+10:00';
    var pull = pullRow({ fetched_at: fetchedAt });
    var block = shopSpendReportBlock_(rows, pull);
    var flat = flattenBlock(block);

    check('no unpriced-SKU banner', flat.indexOf('TOTALS ARE APPROXIMATE') === -1);
    check('no amended-orders banner', flat.indexOf('contain amended orders') === -1);
    check('no duplicate-shop-names banner', flat.indexOf('Possible duplicate shop names') === -1);
    check('no absent/stale banner', flat.indexOf('are absent from the latest pull') === -1);
    check('no unconfirmed cells', flat.indexOf('unconfirmed') === -1);

    check('always: GST treatment stated on the tab', flat.indexOf('EXCLUSIVE_PRIMARY') !== -1);
    check('always: gst:0-is-normal note mentions GST-free SKUs', flat.indexOf('GST-free') !== -1);
    check('always: drift wording present, never "stale pricing"',
      flat.toLowerCase().indexOf('drift') !== -1 && flat.indexOf('stale pricing') === -1);
    check('always: default (unassessed) pull renders "not assessed", never "matches" or "diverges"',
      flat.indexOf('not assessed') !== -1 && flat.indexOf('matches') === -1 && flat.indexOf('diverges') === -1);
    check('always: confirmed-orders-only note excludes Shopify/online',
      flat.indexOf('Confirmed orders only') !== -1 && flat.indexOf('Shopify') !== -1);
    check('always: last fetched_at shown', flat.indexOf(fetchedAt) !== -1);
  })();

  // --- Unassessed ("" or undefined) renders "not assessed", never a verdict --
  (function () {
    var rows = [ssRow({ shop_id: 'shopUnassessed', week_label: '2026-W31' })];

    var pullEmpty = pullRow({ diverges_from_live_pricing: '', matches_live_pricing: '' });
    var flatEmpty = flattenBlock(shopSpendReportBlock_(rows, pullEmpty));
    check('"" renders "not assessed", never "matches" and never "diverges"',
      flatEmpty.indexOf('not assessed') !== -1 &&
      flatEmpty.indexOf('matches') === -1 &&
      flatEmpty.indexOf('diverges') === -1);
    check('"" case never labelled "stale pricing"', flatEmpty.indexOf('stale pricing') === -1);

    // A legacy or short row read back from the Sheet yields undefined, not
    // '' — must render identically to the '' case, never as a verdict.
    var pullUndefined = pullRow({ diverges_from_live_pricing: undefined, matches_live_pricing: undefined });
    var flatUndefined = flattenBlock(shopSpendReportBlock_(rows, pullUndefined));
    check('undefined renders "not assessed" too (legacy/short row from the Sheet)',
      flatUndefined.indexOf('not assessed') !== -1 &&
      flatUndefined.indexOf('matches') === -1 &&
      flatUndefined.indexOf('diverges') === -1);
  })();

  // --- Legacy true/false still render drift/matches — no regression --------
  (function () {
    var rows = [ssRow({ shop_id: 'shopDrift', week_label: '2026-W31' })];

    var pullDiverges = pullRow({ diverges_from_live_pricing: true, matches_live_pricing: false });
    var flatDiverges = flattenBlock(shopSpendReportBlock_(rows, pullDiverges));
    check('legacy true renders "diverges", never "stale pricing" or "not assessed"',
      flatDiverges.toLowerCase().indexOf('drift') !== -1 &&
      flatDiverges.indexOf('diverges') !== -1 &&
      flatDiverges.indexOf('stale pricing') === -1 &&
      flatDiverges.indexOf('not assessed') === -1);

    var pullMatches = pullRow({ diverges_from_live_pricing: false, matches_live_pricing: true });
    var flatMatches = flattenBlock(shopSpendReportBlock_(rows, pullMatches));
    check('legacy false renders "matches", never "not assessed" or "diverges"',
      flatMatches.indexOf('matches') !== -1 &&
      flatMatches.indexOf('not assessed') === -1 &&
      flatMatches.indexOf('diverges') === -1);
  })();

  // --- Banner: warnings[] listed verbatim, never suppressed -------------
  (function () {
    var rows = [ssRow({ shop_id: 'shopW', week_label: '2026-W31' })];
    var pull = pullRow({
      warnings_count: 2,
      warnings: JSON.stringify(['upstream SKU pricing sheet stale for shopW', 'partial data returned for 2026-W31'])
    });
    var flat = flattenBlock(shopSpendReportBlock_(rows, pull));
    check('warning 1 listed verbatim', flat.indexOf('upstream SKU pricing sheet stale for shopW') !== -1);
    check('warning 2 listed verbatim', flat.indexOf('partial data returned for 2026-W31') !== -1);
  })();

  // --- Banner: unpriced SKUs -> approximate totals, '~' prefix ----------
  (function () {
    var rows = [ssRow({ shop_id: 'shopU', week_label: '2026-W31', total_inc_gst: 500 })];
    var pull = pullRow({ unpriced_sku_count: 6, unpriced_skus: JSON.stringify(['SKU-1', 'SKU-2']) });
    var block = shopSpendReportBlock_(rows, pull);
    var flat = flattenBlock(block);
    check('banner names the count and says line items were skipped entirely',
      flat.indexOf('TOTALS ARE APPROXIMATE') !== -1 &&
      flat.indexOf('6 SKUs unpriced') !== -1 &&
      flat.indexOf('skipped entirely') !== -1);

    var header = findGridHeaderRow(block);
    var shopRow = findShopRow(block, 'shopU');
    if (header && shopRow) {
      var col = header.indexOf('2026-W31');
      check('rendered total carries the ~ marker', col > 0 && String(shopRow[col]).indexOf('~') !== -1);
    }
  })();

  // --- Banner: amended orders -> provisional marking ---------------------
  (function () {
    var rows = [
      ssRow({ shop_id: 'shopAmA', week_label: '2026-W31', amended_count: 0, total_inc_gst: 100 }),
      ssRow({ shop_id: 'shopAmB', week_label: '2026-W31', amended_count: 3, total_inc_gst: 200 })
    ];
    var block = shopSpendReportBlock_(rows, pullRow());
    var flat = flattenBlock(block);
    check('banner names exactly 1 amended shop-week, marked provisional',
      flat.indexOf('1 shop-weeks contain amended orders') !== -1 && flat.indexOf('provisional') !== -1);

    var header = findGridHeaderRow(block);
    var amendedRow = findShopRow(block, 'shopAmB');
    var cleanRow = findShopRow(block, 'shopAmA');
    if (header && amendedRow && cleanRow) {
      var col = header.indexOf('2026-W31');
      check('amended shop-week cell is marked', col > 0 && String(amendedRow[col]).indexOf('amended') !== -1);
      check('non-amended shop-week cell is NOT marked', col > 0 && String(cleanRow[col]).indexOf('amended') === -1);
    }
  })();

  // --- Banner: possible duplicate shop names, surfaced but NOT merged ---
  (function () {
    var rows = [
      ssRow({ shop_id: 'Acme Cafe', week_label: '2026-W31', total_inc_gst: 100 }),
      ssRow({ shop_id: 'Acme Café', week_label: '2026-W31', total_inc_gst: 150 })
    ];
    var pull = pullRow({ possible_duplicate_shop_names: JSON.stringify(['Acme Cafe', 'Acme Café']) });
    var block = shopSpendReportBlock_(rows, pull);
    var flat = flattenBlock(block);
    check('banner states fix upstream, NOT merged automatically',
      flat.indexOf('Possible duplicate shop names') !== -1 && flat.indexOf('NOT merged automatically') !== -1);
    check('both flagged names listed', flat.indexOf('Acme Cafe') !== -1 && flat.indexOf('Acme Café') !== -1);
    check('both shop_ids remain two SEPARATE grid rows (never auto-merged)',
      !!findShopRow(block, 'Acme Cafe') && !!findShopRow(block, 'Acme Café') &&
      findShopRow(block, 'Acme Cafe') !== findShopRow(block, 'Acme Café'));
  })();

  // --- Banner: empty range + invalid labels -> 'unconfirmed', never $0 --
  (function () {
    var rows = [
      ssRow({ shop_id: 'shopE1', week_label: '2026-W31', total_inc_gst: 100 }),
      ssRow({ shop_id: 'shopE2', week_label: '2026-W32', total_inc_gst: 200 })
    ];
    var pull = pullRow({ empty_range_with_invalid_labels: true, invalid_week_labels: JSON.stringify(['2026-W99']) });
    var block = shopSpendReportBlock_(rows, pull);
    var flat = flattenBlock(block);
    check('no cell renders as literal "$0" anywhere in the block', flat.indexOf('$0') === -1);
    check('no cell is the bare number 0',
      block.every(function (row) { return row.every(function (cell) { return cell !== 0; }); }));

    var header = findGridHeaderRow(block);
    var row1 = findShopRow(block, 'shopE1');
    var row2 = findShopRow(block, 'shopE2');
    if (header && row1 && row2) {
      var col32 = header.indexOf('2026-W32');
      var col31 = header.indexOf('2026-W31');
      check("shopE1's missing 2026-W32 cell reads 'unconfirmed'", col32 > 0 && row1[col32] === 'unconfirmed');
      check("shopE2's missing 2026-W31 cell reads 'unconfirmed'", col31 > 0 && row2[col31] === 'unconfirmed');
    }
  })();

  // --- Banner: absent tombstone -> stale marking, not a dollar figure ---
  (function () {
    var rows = [
      ssRow({ shop_id: 'shopT', week_label: '2026-W31', presence: 'present', total_inc_gst: 400, fetched_at: '2026-08-01T09:00:00+10:00' }),
      ssRow({ shop_id: 'shopT', week_label: '2026-W31', presence: 'absent', total_inc_gst: 0, fetched_at: '2026-08-05T09:00:00+10:00' })
    ];
    var block = shopSpendReportBlock_(rows, pullRow());
    var flat = flattenBlock(block);
    check('banner names exactly 1 absent shop-week and calls the value stale',
      flat.indexOf('1 shop-weeks present in a prior pull are absent from the latest pull') !== -1 &&
      flat.indexOf('stale') !== -1);

    var header = findGridHeaderRow(block);
    var shopRow = findShopRow(block, 'shopT');
    if (header && shopRow) {
      var col = header.indexOf('2026-W31');
      check("absent latest snapshot renders as 'stale', not a dollar figure",
        col > 0 && shopRow[col] === 'stale');
    }
  })();

  } // end hasBlockFn block

  if (!hasBuildFn) {
    console.log('  (skipping buildShopSpendReport cases — function not defined)');
  } else {

  // --- Single write: exactly one clearContents + one setValues ----------
  (function () {
    freshSheets();
    var tabs = ensureShopSpendTabs_(currentSS);
    ingestShopSpendRows('shopspend', [shopSpendRowObj({ shop_id: 'shopSW', week_label: '2026-W31' })], 'T1', tabs.data);
    appendNewRows_(tabs.pulls, [pullRow()]);
    tabs.report.appendRow(['stale', 'report', 'content', 'from', 'a', 'prior', 'run']);

    var startLen = currentSS._writeLog.length;
    var res = buildShopSpendReport();
    var reportWrites = currentSS._writeLog.slice(startLen).filter(function (w) { return w.sheet === SHOPSPEND_REPORT_TAB; });

    check('buildShopSpendReport returns something', !!res);
    eq('exactly two write calls on the Report tab (clear + set)', reportWrites.length, 2);
    if (reportWrites.length === 2) {
      eq('first call is clearContents', reportWrites[0].type, 'clearContents');
      eq('second call is a single setValues (not per-row appendRow)', reportWrites[1].type, 'setValues');
    }
  })();

  // --- Lock: a held script lock is reported, not silently swallowed -----
  (function () {
    freshSheets();
    ensureShopSpendTabs_(currentSS);
    global.__forceLockTimeout = true;
    var startLen = currentSS._writeLog.length;
    var res;
    try {
      res = buildShopSpendReport();
    } finally {
      global.__forceLockTimeout = false;
    }
    var reportWrites = currentSS._writeLog.slice(startLen).filter(function (w) { return w.sheet === SHOPSPEND_REPORT_TAB; });
    check('a held lock is reported (refused:"locked") and nothing is written',
      !!res && res.refused === 'locked' && reportWrites.length === 0);
  })();

  // --- No mutation: ShopSpend / ShopSpendPulls are read-only inputs -----
  (function () {
    freshSheets();
    var tabs = ensureShopSpendTabs_(currentSS);
    ingestShopSpendRows('shopspend', [
      shopSpendRowObj({ shop_id: 'shopNM1', week_label: '2026-W31' }),
      shopSpendRowObj({ shop_id: 'shopNM2', week_label: '2026-W32', total_inc_gst: 300 })
    ], 'T1', tabs.data);
    appendNewRows_(tabs.pulls, [pullRow()]);

    var beforeData = tabs.data.getDataRange().getValues();
    var beforePulls = tabs.pulls.getDataRange().getValues();
    buildShopSpendReport();
    eq('ShopSpend tab byte-identical after a rebuild', tabs.data.getDataRange().getValues(), beforeData);
    eq('ShopSpendPulls tab byte-identical after a rebuild', tabs.pulls.getDataRange().getValues(), beforePulls);
  })();

  } // end hasBuildFn block
})();

(function testShopSpendWatchdog() {
  console.log('\nshopSpend — watchdog and trigger (step 7):');

  function spPullRow(overrides) {
    var f = Object.assign({
      fetched_at: '2026-08-03T05:00:00+10:00', environment: 'prod',
      from_week: '2026-W31', to_week: '2026-W31',
      matched: 1, returned: 1, truncated: false,
      warnings_count: 0, warnings: '[]',
      unpriced_sku_count: 0, unpriced_skus: '[]',
      amended_count: 0, possible_duplicate_shop_names: '[]',
      empty_range_with_invalid_labels: false, invalid_week_labels: '[]',
      gst_treatment: 'EXCLUSIVE_PRIMARY',
      diverges_from_live_pricing: false, matches_live_pricing: true,
      total_orders_scanned: 10, absent_shop_ids: '[]',
      diagnostics_json: '{}'
    }, overrides);
    return SHOPSPEND_PULLS_HEADERS.map(function (h) { return f[h]; });
  }

  // Monday 2026-08-03 14:00 Australia/Sydney (AEST, +10:00) — the watchdog's
  // own install schedule. The week that just closed (ended Sunday 2026-08-02)
  // is 2026-W31 (Jul27-Aug2 — the same span already used as fixture data
  // elsewhere in this file for that label).
  var NOW_MON = new Date('2026-08-03T04:00:00Z').getTime();

  // First Monday of January 2027, same 14:00 Sydney anchor but in DST (AEDT,
  // +11:00). The week that just closed spans 2026-12-28..2027-01-03, which is
  // ISO week 2026-W53 — NOT 2027-W00 or 2027-W01. Year-boundary regression.
  var NOW_YEAR_BOUNDARY = new Date('2027-01-04T03:00:00Z').getTime();

  var hasEvalFn = typeof shopSpendWatchdogEvaluate_ === 'function';
  var hasCoveredFn = typeof shopSpendCoveredWeeks_ === 'function';
  var hasWatchdogFn = typeof shopSpendWatchdog === 'function';
  var hasInstallFn = typeof installShopSpendWatchdogTrigger === 'function';
  check('shopSpendCoveredWeeks_ is defined', hasCoveredFn);
  check('shopSpendWatchdogEvaluate_ is defined', hasEvalFn);
  check('shopSpendWatchdog is defined', hasWatchdogFn);
  check('installShopSpendWatchdogTrigger is defined', hasInstallFn);

  // --- Registration guard: watched-but-exempt, never in STALENESS_SOURCES ---
  check('shopspend is NOT in STALENESS_SOURCES (global 96h threshold would false-alarm a 168h cadence)',
    STALENESS_SOURCES.indexOf('shopspend') === -1);

  if (!hasCoveredFn) {
    console.log('  (skipping shopSpendCoveredWeeks_ cases — function not defined)');
  } else {
    // --- Expands a span, sorted + deduped across overlapping rows ---------
    var spanRows = [
      spPullRow({ from_week: '2026-W29', to_week: '2026-W31' }),
      spPullRow({ from_week: '2026-W30', to_week: '2026-W32' })  // overlaps
    ];
    eq('expands + merges overlapping spans, sorted + deduped',
      shopSpendCoveredWeeks_(spanRows),
      ['2026-W29', '2026-W30', '2026-W31', '2026-W32']);

    // --- Empty tab -> [] -----------------------------------------------------
    eq('empty pulls tab yields [], not an error or null', shopSpendCoveredWeeks_([]), []);
  }

  if (!hasEvalFn) {
    console.log('  (skipping shopSpendWatchdogEvaluate_ cases — function not defined)');
  } else {
    // --- Covered week -> no alert ---------------------------------------------
    var coveredRows = [spPullRow({ fetched_at: '2026-08-03T05:00:00+10:00', from_week: '2026-W30', to_week: '2026-W31' })];
    var coveredResult = shopSpendWatchdogEvaluate_(coveredRows, NOW_MON);
    check('a pull spanning the just-closed week -> covered:true', coveredResult.covered === true);
    eq('weekLabel resolves to the just-closed ISO week', coveredResult.weekLabel, '2026-W31');
    eq("lastPullMs reflects the pull's fetched_at",
      coveredResult.lastPullMs, new Date('2026-08-03T05:00:00+10:00').getTime());

    // --- Missing week -> alert -------------------------------------------------
    var missingRows = [spPullRow({ fetched_at: '2026-07-27T05:00:00+10:00', from_week: '2026-W29', to_week: '2026-W30' })];
    var missingResult = shopSpendWatchdogEvaluate_(missingRows, NOW_MON);
    check('no covering pulls row -> covered:false', missingResult.covered === false);
    eq('weekLabel is still the just-closed week', missingResult.weekLabel, '2026-W31');
    eq("lastPullMs still reports the newest pull seen (even though it doesn't cover)",
      missingResult.lastPullMs, new Date('2026-07-27T05:00:00+10:00').getTime());

    // --- A pull for a DIFFERENT week does not count as coverage ---------------
    var differentWeekRows = [spPullRow({ from_week: '2026-W25', to_week: '2026-W25' })];
    check('a pull for an unrelated week does not satisfy coverage',
      shopSpendWatchdogEvaluate_(differentWeekRows, NOW_MON).covered === false);

    // --- Empty tab (cold start) -> alert, lastPullMs null ----------------------
    var coldResult = shopSpendWatchdogEvaluate_([], NOW_MON);
    check('cold start -> covered:false', coldResult.covered === false);
    eq("cold start -> lastPullMs null (mirrors stalenessEvaluate_'s never-seen convention)",
      coldResult.lastPullMs, null);

    // --- One span parser: shopSpendWatchdogEvaluate_ must AGREE with --------
    // shopSpendCoveredWeeks_ on the same fixture, not parse spans itself.
    if (hasCoveredFn) {
      var agreeRows = [spPullRow({ from_week: '2026-W29', to_week: '2026-W31' })];
      var agreeResult = shopSpendWatchdogEvaluate_(agreeRows, NOW_MON);
      var coveredSet = shopSpendCoveredWeeks_(agreeRows);
      eq('shopSpendWatchdogEvaluate_.covered agrees with shopSpendCoveredWeeks_ for the same fixture',
        agreeResult.covered, coveredSet.indexOf(agreeResult.weekLabel) !== -1);
      check('...and that agreement is a real "covered" (true), not both trivially false',
        agreeResult.covered === true);
    }

    // --- Year boundary ----------------------------------------------------------
    var yearBoundaryResult = shopSpendWatchdogEvaluate_([], NOW_YEAR_BOUNDARY);
    eq('first Monday of Jan 2027 resolves the just-closed week to 2026-W53, not 2027-W00/W01',
      yearBoundaryResult.weekLabel, '2026-W53');
  }

  if (!hasWatchdogFn) {
    console.log('  (skipping shopSpendWatchdog() integration cases — function not defined)');
  } else {
    function buildPullsSheet(rows) {
      freshSheets();
      var tabs = ensureShopSpendTabs_(currentSS);
      for (var i = 0; i < rows.length; i++) tabs.pulls.appendRow(rows[i]);
      return tabs;
    }
    function resetCalendar() {
      calendarEvents = [];
      calendarFailMode = null;
    }

    // --- Covered week -> shopSpendWatchdog() raises no alert -------------------
    resetCalendar();
    buildPullsSheet([spPullRow({ fetched_at: '2026-08-03T05:00:00+10:00', from_week: '2026-W30', to_week: '2026-W31' })]);
    withMockNow('2026-08-03T04:00:00Z', function () { shopSpendWatchdog(); });
    eq('covered week: no calendar event raised', calendarEvents.length, 0);

    // --- Missing week -> shopSpendWatchdog() raises exactly one alert ----------
    resetCalendar();
    buildPullsSheet([spPullRow({ fetched_at: '2026-07-27T05:00:00+10:00', from_week: '2026-W29', to_week: '2026-W30' })]);
    withMockNow('2026-08-03T04:00:00Z', function () { shopSpendWatchdog(); });
    eq('missing week: exactly one calendar event raised', calendarEvents.length, 1);
    if (calendarEvents.length === 1) {
      eq('alert title matches the shopspend source (stable, no varying number)',
        calendarEvents[0]._title, stalenessEventTitle_('shopspend'));
      check('alert is ORANGE like every other staleness alert', calendarEvents[0]._color === 'ORANGE');
    }

    // --- Cold start (empty ShopSpendPulls tab) -> alert, never-seen wording ----
    resetCalendar();
    buildPullsSheet([]);
    withMockNow('2026-08-03T04:00:00Z', function () { shopSpendWatchdog(); });
    eq('cold start: exactly one calendar event raised', calendarEvents.length, 1);
    if (calendarEvents.length === 1) {
      check('cold start: description uses the never-seen wording (ageHours: null)',
        calendarEvents[0]._description.indexOf('never seen since the watchdog was installed') !== -1);
    }

    // --- Never throws: malformed rows + a Calendar that throws -----------------
    resetCalendar();
    calendarFailMode = 'all';
    var malformedTabs = buildPullsSheet([]);
    // Garbage rows a hand-edited or partially-written sheet could contain —
    // written directly, bypassing normalizePullMetadataRow_ — the watchdog
    // must survive reading these, not just well-formed data.
    malformedTabs.pulls.appendRow([undefined, null, {}, [], 'not-a-number', NaN]);
    malformedTabs.pulls.appendRow(['garbage']);
    var threwMalformed = false;
    withMockNow('2026-08-03T04:00:00Z', function () {
      try { shopSpendWatchdog(); } catch (e) { threwMalformed = true; }
    });
    check('malformed pulls rows + a broken calendar never throw out of the handler', !threwMalformed);

    // --- Zero-arg safe: an event-object argument must not corrupt the run -----
    var fakeTriggerEvent = { triggerUid: 'some-trigger-id' };

    resetCalendar();
    buildPullsSheet([spPullRow({ fetched_at: '2026-07-27T05:00:00+10:00', from_week: '2026-W29', to_week: '2026-W30' })]);
    withMockNow('2026-08-03T04:00:00Z', function () { shopSpendWatchdog(); });
    var noArgEvents = calendarEvents.length;

    resetCalendar();
    buildPullsSheet([spPullRow({ fetched_at: '2026-07-27T05:00:00+10:00', from_week: '2026-W29', to_week: '2026-W30' })]);
    var threwOnEventArg = false;
    withMockNow('2026-08-03T04:00:00Z', function () {
      try { shopSpendWatchdog(fakeTriggerEvent); } catch (e) { threwOnEventArg = true; }
    });
    check('an event-object argument does not throw', !threwOnEventArg);
    eq('shopSpendWatchdog(eventObject) behaves identically to shopSpendWatchdog() (same alert count)',
      calendarEvents.length, noArgEvents);
  }

  if (!hasInstallFn) {
    console.log('  (skipping installShopSpendWatchdogTrigger cases — function not defined)');
  } else {
    // --- Trigger install is idempotent -----------------------------------------
    installShopSpendWatchdogTrigger();
    installShopSpendWatchdogTrigger();
    var watchdogTriggers = ScriptApp.getProjectTriggers()
      .filter(function (t) { return t.getHandlerFunction() === 'shopSpendWatchdog'; });
    eq('installing twice leaves exactly one trigger for shopSpendWatchdog', watchdogTriggers.length, 1);
    if (watchdogTriggers.length === 1) {
      var cfg = watchdogTriggers[0]._cfg;
      eq('trigger is MONDAY', cfg.weekDay, ScriptApp.WeekDay.MONDAY);
      eq('trigger is hour 14', cfg.hour, 14);
      eq('trigger is Australia/Sydney', cfg.timezone, 'Australia/Sydney');
    }
  }
})();

(function testDoGetShopSpendCoverage() {
  console.log('\ndoGet — fn dispatch + shopspendCoverage (step 8):');

  function spPullRow(overrides) {
    var f = Object.assign({
      fetched_at: '2026-08-03T05:00:00+10:00', environment: 'prod',
      from_week: '2026-W31', to_week: '2026-W31',
      matched: 1, returned: 1, truncated: false,
      warnings_count: 0, warnings: '[]',
      unpriced_sku_count: 0, unpriced_skus: '[]',
      amended_count: 0, possible_duplicate_shop_names: '[]',
      empty_range_with_invalid_labels: false, invalid_week_labels: '[]',
      gst_treatment: 'EXCLUSIVE_PRIMARY',
      diverges_from_live_pricing: false, matches_live_pricing: true,
      total_orders_scanned: 10, absent_shop_ids: '[]',
      diagnostics_json: '{}'
    }, overrides);
    return SHOPSPEND_PULLS_HEADERS.map(function (h) { return f[h]; });
  }

  function seedSummary() {
    freshSheets();
    var summSheet = makeSheet(['week_start', 'week_end', 'supplier', 'location', 'total_spend', 'summarized_at']);
    summSheet.appendRow(['2026-06-15', '2026-06-21', 'Food and Dairy Co', 'York St', 300, 'TS']);
    summSheet.appendRow(['2026-06-15', '2026-06-21', 'Butterboy', 'York St', 80, 'TS']);
    summSheet.appendRow(['2026-06-08', '2026-06-14', 'Food and Dairy Co', 'York St', 250, 'TS']);
    currentSS._sheets['Summary'] = summSheet;
    scriptProps = { API_READ_TOKEN: 'secret123' };
  }

  // --- No fn → unchanged legacy Summary response --------------------------
  seedSummary();
  var noFn = JSON.parse(doGet({
    parameter: { token: 'secret123', from: '2026-06-15', to: '2026-06-21' }
  }).getContent());
  eq('no fn: result ok', noFn.result, 'ok');
  eq('no fn: count', noFn.count, 2);
  eq('no fn: week_start', noFn.week_start, '2026-06-15');
  eq('no fn: week_end', noFn.week_end, '2026-06-21');
  eq('no fn: first row supplier', noFn.rows[0].supplier, 'Food and Dairy Co');
  eq('no fn: first row total_spend', noFn.rows[0].total_spend, 300);

  // --- fn=summary → identical to omitting fn -------------------------------
  seedSummary();
  var explicitSummary = JSON.parse(doGet({
    parameter: { token: 'secret123', from: '2026-06-15', to: '2026-06-21', fn: 'summary' }
  }).getContent());
  eq('fn=summary matches omitted-fn response', explicitSummary, noFn);

  // --- fn=shopspendCoverage → covered weeks from ShopSpendPulls -----------
  freshSheets();
  var tabs = ensureShopSpendTabs_(currentSS);
  tabs.pulls.appendRow(spPullRow({ from_week: '2026-W29', to_week: '2026-W31' }));
  scriptProps = { API_READ_TOKEN: 'secret123' };
  var coverage = JSON.parse(doGet({
    parameter: { token: 'secret123', fn: 'shopspendCoverage' }
  }).getContent());
  eq('shopspendCoverage: result ok', coverage.result, 'ok');
  eq('shopspendCoverage: count', coverage.count, 3);
  eq('shopspendCoverage: weeks match shopSpendCoveredWeeks_ span expansion',
    coverage.weeks, ['2026-W29', '2026-W30', '2026-W31']);

  // --- Empty / missing ShopSpendPulls → ok, count 0, weeks [] -------------
  freshSheets();
  ensureShopSpendTabs_(currentSS);
  scriptProps = { API_READ_TOKEN: 'secret123' };
  var emptyCoverage = JSON.parse(doGet({
    parameter: { token: 'secret123', fn: 'shopspendCoverage' }
  }).getContent());
  eq('empty ShopSpendPulls: result ok (not error)', emptyCoverage.result, 'ok');
  eq('empty ShopSpendPulls: count 0', emptyCoverage.count, 0);
  eq('empty ShopSpendPulls: weeks []', emptyCoverage.weeks, []);

  freshSheets(); // no ensureShopSpendTabs_ call at all — tab genuinely missing
  scriptProps = { API_READ_TOKEN: 'secret123' };
  var missingTabCoverage = JSON.parse(doGet({
    parameter: { token: 'secret123', fn: 'shopspendCoverage' }
  }).getContent());
  eq('missing ShopSpendPulls tab: result ok (not error)', missingTabCoverage.result, 'ok');
  eq('missing ShopSpendPulls tab: count 0', missingTabCoverage.count, 0);
  eq('missing ShopSpendPulls tab: weeks []', missingTabCoverage.weeks, []);

  // --- Missing token → unauthorized on the coverage path -------------------
  freshSheets();
  ensureShopSpendTabs_(currentSS);
  scriptProps = { API_READ_TOKEN: 'secret123' };
  var noToken = JSON.parse(doGet({ parameter: { fn: 'shopspendCoverage' } }).getContent());
  eq('coverage path: missing token → error', noToken.result, 'error');
  eq('coverage path: missing token → unauthorized message', noToken.message, 'unauthorized');

  // --- Bad token → unauthorized on the coverage path ------------------------
  var badToken = JSON.parse(doGet({
    parameter: { token: 'wrong', fn: 'shopspendCoverage' }
  }).getContent());
  eq('coverage path: bad token → error', badToken.result, 'error');
  eq('coverage path: bad token → unauthorized message', badToken.message, 'unauthorized');

  // --- Unknown fn → error, NOT the Summary payload --------------------------
  seedSummary();
  var unknownFn = JSON.parse(doGet({
    parameter: { token: 'secret123', from: '2026-06-15', to: '2026-06-21', fn: 'nope' }
  }).getContent());
  eq('unknown fn: result error', unknownFn.result, 'error');
  check('unknown fn: response has no rows array (did not fall through to Summary)',
    unknownFn.rows === undefined);

  // --- Auth runs before dispatch: unknown fn + bad token → unauthorized ----
  scriptProps = { API_READ_TOKEN: 'secret123' };
  var unknownFnBadToken = JSON.parse(doGet({
    parameter: { token: 'wrong', fn: 'nope' }
  }).getContent());
  eq('unknown fn + bad token: still unauthorized, not an unknown-fn error',
    unknownFnBadToken.message, 'unauthorized');
})();

/* ------------------------------------------------------------------ *
 * doPost — weeks_verified_empty token gate (step 0: dopost-token-gate)
 * ------------------------------------------------------------------ */

(function testDoPostWeeksVerifiedEmptyTokenGate() {
  console.log('\ndoPost — weeks_verified_empty token gate (step 0):');

  function tokenGateRow(overrides) {
    return Object.assign({
      date: '2026-07-27', shop_id: 'shop_1', week_label: '2026-W31',
      week_start: '2026-07-27', week_end: '2026-08-02',
      order_count: 12, amended_count: 1, total_ex_gst: 500, gst: 0, total_inc_gst: 500
    }, overrides);
  }

  var savedProps;

  // --- weeks_verified_empty present, no token field → unauthorized --------
  savedProps = scriptProps;
  scriptProps = { API_READ_TOKEN: 'test-token' };
  freshSheets();
  var noToken = doPostJson({
    source: 'shopspend', kind: 'shopspend', extracted_at: 'TS', rows: [],
    weeks_complete: ['2026-W31'], weeks_verified_empty: ['2026-W31']
  });
  eq('no token field: result error', noToken.result, 'error');
  eq('no token field: code UNAUTHORIZED (machine-readable for poster degradation)',
    noToken.code, 'UNAUTHORIZED');
  eq('no token field: message unauthorized', noToken.message, 'unauthorized');
  scriptProps = savedProps;

  // --- weeks_verified_empty present, wrong token → unauthorized -----------
  savedProps = scriptProps;
  scriptProps = { API_READ_TOKEN: 'test-token' };
  freshSheets();
  var wrongToken = doPostJson({
    source: 'shopspend', kind: 'shopspend', extracted_at: 'TS', rows: [],
    weeks_complete: ['2026-W31'], weeks_verified_empty: ['2026-W31'],
    token: 'wrong-token'
  });
  eq('wrong token: result error', wrongToken.result, 'error');
  eq('wrong token: message unauthorized', wrongToken.message, 'unauthorized');
  eq('wrong token: code UNAUTHORIZED', wrongToken.code, 'UNAUTHORIZED');
  scriptProps = savedProps;

  // --- weeks_verified_empty present, correct token → processing proceeds --
  savedProps = scriptProps;
  scriptProps = { API_READ_TOKEN: 'test-token' };
  freshSheets();
  var correctToken = doPostJson({
    source: 'shopspend', kind: 'shopspend', extracted_at: 'TS', rows: [],
    weeks_complete: ['2026-W31'], weeks_verified_empty: ['2026-W31'],
    token: 'test-token'
  });
  eq('correct token: result ok', correctToken.result, 'ok');
  check('correct token: tombstonesWritten present', 'tombstonesWritten' in correctToken);
  check('correct token: tombstonesSkipped present', 'tombstonesSkipped' in correctToken);
  scriptProps = savedProps;

  // --- weeks_verified_empty: [] present but empty, no token → unauthorized
  //     (presence-gated, not content-gated) ---------------------------------
  savedProps = scriptProps;
  scriptProps = { API_READ_TOKEN: 'test-token' };
  freshSheets();
  var emptyArrayNoToken = doPostJson({
    source: 'shopspend', kind: 'shopspend', extracted_at: 'TS', rows: [],
    weeks_complete: [], weeks_verified_empty: []
  });
  eq('empty weeks_verified_empty array, no token: result error', emptyArrayNoToken.result, 'error');
  eq('empty weeks_verified_empty array, no token: still unauthorized',
    emptyArrayNoToken.message, 'unauthorized');
  scriptProps = savedProps;

  // --- field absent, no token, shopspend rows + weeks_complete → unaffected
  savedProps = scriptProps;
  scriptProps = {};
  freshSheets();
  var absentShopspend = doPostJson({
    source: 'shopspend', kind: 'shopspend', extracted_at: 'TS',
    rows: [tokenGateRow()], weeks_complete: ['2026-W31']
  });
  eq('field absent, shopspend payload: result ok', absentShopspend.result, 'ok');
  scriptProps = savedProps;

  // --- field absent, no token, kind suppliers → unaffected -----------------
  savedProps = scriptProps;
  scriptProps = {};
  freshSheets();
  var absentSuppliers = doPostJson({
    source: 'food_dairy_co', kind: 'suppliers', extracted_at: 'TS',
    rows: [{ date: '2026-07-27', total: 10, invoice_ref: 'GATE-1' }]
  });
  eq('field absent, suppliers payload: result ok', absentSuppliers.result, 'ok');
  scriptProps = savedProps;

  // --- API_READ_TOKEN unset, field present, any token → unauthorized
  //     (fail-closed) -------------------------------------------------------
  savedProps = scriptProps;
  scriptProps = {};
  freshSheets();
  var unsetProp = doPostJson({
    source: 'shopspend', kind: 'shopspend', extracted_at: 'TS', rows: [],
    weeks_complete: ['2026-W31'], weeks_verified_empty: ['2026-W31'],
    token: 'any-token-at-all'
  });
  eq('property unset: result error', unsetProp.result, 'error');
  eq('property unset: message unauthorized (fail-closed)', unsetProp.message, 'unauthorized');
  eq('property unset: code UNAUTHORIZED', unsetProp.code, 'UNAUTHORIZED');
  scriptProps = savedProps;

  // --- auth precedes validation: malformed weeks_verified_empty, no token
  //     → unauthorized, NOT the validation message ---------------------------
  savedProps = scriptProps;
  scriptProps = { API_READ_TOKEN: 'test-token' };
  freshSheets();
  var malformedNoToken = doPostJson({
    source: 'shopspend', kind: 'shopspend', extracted_at: 'TS', rows: [],
    weeks_complete: ['2026-W31'], weeks_verified_empty: 'not-an-array'
  });
  eq('malformed weeks_verified_empty, no token: result error', malformedNoToken.result, 'error');
  eq('malformed weeks_verified_empty, no token: unauthorized (not validation error)',
    malformedNoToken.message, 'unauthorized');
  scriptProps = savedProps;

  // --- same malformed payload WITH the correct token → gate passes through,
  //     validation error surfaces -------------------------------------------
  savedProps = scriptProps;
  scriptProps = { API_READ_TOKEN: 'test-token' };
  freshSheets();
  var malformedWithToken = doPostJson({
    source: 'shopspend', kind: 'shopspend', extracted_at: 'TS', rows: [],
    weeks_complete: ['2026-W31'], weeks_verified_empty: 'not-an-array',
    token: 'test-token'
  });
  eq('malformed weeks_verified_empty, correct token: result error', malformedWithToken.result, 'error');
  eq('malformed weeks_verified_empty, correct token: validation error surfaces',
    malformedWithToken.message, 'invalid weeks_verified_empty');
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ *
 * orderapp-pulls step 0 — orderapp.gs shared fetch/auth/failure plumbing
 * ------------------------------------------------------------------ */

(function testOrderAppFetchAndClassify() {
  console.log('\norderapp: orderAppFetch_ / orderAppClassifyResponse_ / orderAppBuildUrl_:');

  const REAL_URL_FETCH = global.UrlFetchApp;
  const savedProps = scriptProps;

  // --- token property unset: skip-safe, zero fetches ---
  scriptProps = {};
  let fetchCalls = 0;
  global.UrlFetchApp = {
    fetch: () => {
      fetchCalls++;
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true }) };
    },
  };
  const noTokenRes = orderAppFetch_({ foo: 'bar' });
  eq('no token: result shape', noTokenRes, { ok: false, reason: 'no-token' });
  eq('no token: UrlFetchApp.fetch called zero times', fetchCalls, 0);
  global.UrlFetchApp = REAL_URL_FETCH;
  scriptProps = savedProps;

  // --- orderAppClassifyResponse_ is pure: (httpCode, bodyText) -> {ok,...} ---
  const okBody = { ok: true, weeks: [{ label: '2026-W31' }] };
  eq('HTTP 200 + ok:true passes the parsed body through',
    orderAppClassifyResponse_(200, JSON.stringify(okBody)),
    { ok: true, body: okBody });

  eq('HTTP 200 + ok:false api error -> api:<ERROR> reason',
    orderAppClassifyResponse_(200, JSON.stringify({ ok: false, error: 'UNAUTHORIZED' })),
    { ok: false, reason: 'api:UNAUTHORIZED' });

  eq('HTTP 500 -> http-<code> reason',
    orderAppClassifyResponse_(500, 'server error'),
    { ok: false, reason: 'http-500' });

  // An expired /exec deployment serves an HTML login page — must classify
  // as a normal failure reason, never throw.
  let htmlThrew = false;
  let htmlRes;
  try {
    htmlRes = orderAppClassifyResponse_(200, '<html><body>please login</body></html>');
  } catch (err) {
    htmlThrew = true;
  }
  check('HTML login page does not throw', !htmlThrew);
  eq('HTML login page -> parse reason', htmlRes, { ok: false, reason: 'parse' });

  // --- orderAppBuildUrl_ is pure: percent-encode param values ---
  const built = orderAppBuildUrl_('https://example.com/exec', { a: 'x&y', b: 'x y', c: 'x+y' });
  check('orderAppBuildUrl_ starts with execUrl + "?"',
    built.indexOf('https://example.com/exec?') === 0);
  check('orderAppBuildUrl_ percent-encodes "&" in a value', built.indexOf('a=x%26y') !== -1);
  check('orderAppBuildUrl_ percent-encodes space in a value', built.indexOf('b=x%20y') !== -1);
  check('orderAppBuildUrl_ percent-encodes "+" in a value', built.indexOf('c=x%2By') !== -1);
})();

(function testOrderAppFailureAccounting() {
  console.log('\norderapp: run start/success/alert failure accounting:');

  const SRC = 'orderapp_test_source'; // no colons — see step 0 note

  function reset() {
    scriptProps = {};
    calendarEvents = [];
    calendarFailMode = null;
    clearLoggedMessages();
  }

  // --- start x1 then success: counter resets to 0, heartbeat stamped once ---
  reset();
  orderAppRunStart_(SRC);
  orderAppRunSuccess_(SRC);
  eq('start x1 + success: failcount resets to 0',
    scriptProps['ORDERAPP_FAILCOUNT_' + SRC], '0');
  check('start x1 + success: heartbeat stamped', ('LAST_INGEST_' + SRC) in scriptProps);

  // --- start x2 with no success between: exactly ONE alert, on the 2nd call only ---
  reset();
  orderAppRunStart_(SRC);
  eq('first consecutive start: no alert yet', calendarEvents.length, 0);
  orderAppRunStart_(SRC);
  eq('second consecutive start (no success between): exactly one alert', calendarEvents.length, 1);

  // --- fail-then-success: alert wording + recovery log + counter ends at 0 ---
  reset();
  orderAppRunStart_(SRC);
  orderAppRunStart_(SRC); // -> raises the alert
  eq('alert raised after the 2nd failed start', calendarEvents.length, 1);
  const alertEvent = calendarEvents[0];
  check('alert title names the source', alertEvent._title.indexOf(SRC) !== -1);
  check('alert title says "did not complete"', alertEvent._title.indexOf('did not complete') !== -1);
  check('alert body says "retrying"', alertEvent._description.indexOf('retrying') !== -1);
  check('alert body names the GAS trigger', /trigger/i.test(alertEvent._description));
  check('alert body names the ORDER_APP_COST_TOKEN property',
    alertEvent._description.indexOf('ORDER_APP_COST_TOKEN') !== -1);
  check('alert body names the /exec URL', alertEvent._description.indexOf('/exec') !== -1);
  check('alert body does NOT mention Task Scheduler (wrong remediation class)',
    alertEvent._description.indexOf('Task Scheduler') === -1);

  orderAppRunSuccess_(SRC);
  eq('after recovery: failcount back to 0', scriptProps['ORDERAPP_FAILCOUNT_' + SRC], '0');
  check('after recovery: "recovered" was logged',
    lastLoggedMessages().some((m) => m.indexOf(SRC) !== -1 && m.indexOf('recovered') !== -1));

  // --- simulated crash: start called, then nothing (no success, no alert path
  //     re-entered) — counter stays incremented, heartbeat never stamped ---
  reset();
  orderAppRunStart_(SRC);
  eq('crash after start: failcount remains 1', scriptProps['ORDERAPP_FAILCOUNT_' + SRC], '1');
  check('crash after start: heartbeat NOT stamped', !(('LAST_INGEST_' + SRC) in scriptProps));

  // --- not-armed skip: token unset is NOT failure. A trigger installed before
  //     the token is pasted fires start->skip forever; without the reset that
  //     builds to a false "did not complete" alert on run 2 and every run after.
  reset();
  orderAppRunStart_(SRC);
  orderAppRunSkipped_(SRC);
  eq('skip resets the failcount to 0', scriptProps['ORDERAPP_FAILCOUNT_' + SRC], '0');
  check('skip stamps NO heartbeat', !(('LAST_INGEST_' + SRC) in scriptProps));
  orderAppRunStart_(SRC);
  orderAppRunSkipped_(SRC);
  orderAppRunStart_(SRC);
  orderAppRunSkipped_(SRC);
  eq('repeated start->skip cycles never alert', calendarEvents.length, 0);

  // --- a broken alert calendar must never throw out of orderAppRaiseAlert_ ---
  reset();
  calendarFailMode = 'all';
  let alertThrew = false;
  try {
    orderAppRaiseAlert_(SRC, 2);
  } catch (err) {
    alertThrew = true;
  }
  check('a broken calendar does not throw out of orderAppRaiseAlert_', !alertThrew);
})();

/* ------------------------------------------------------------------ *
 * orderapp-pulls step 1 — isoWeekLabel_ / lastCompletedWeeks_
 * ------------------------------------------------------------------ */

(function testIsoWeekLabelHelpers() {
  console.log('\norderapp: isoWeekLabel_ / lastCompletedWeeks_:');

  eq('2026-01-01 (Thursday) -> 2026-W01',
    isoWeekLabel_('2026-01-01'), '2026-W01');

  eq('2024-12-30 (Monday belonging to the next ISO year) -> 2025-W01',
    isoWeekLabel_('2024-12-30'), '2025-W01');

  eq('2021-01-01 (Friday belonging to the previous ISO year) -> 2020-W53',
    isoWeekLabel_('2021-01-01'), '2020-W53');

  eq('mid-year Monday and the Sunday of the same week share a label (Monday)',
    isoWeekLabel_('2026-06-15'), '2026-W25');
  eq('mid-year Monday and the Sunday of the same week share a label (Sunday)',
    isoWeekLabel_('2026-06-21'), '2026-W25');

  eq('zero-padding: a week-5 date yields W05',
    isoWeekLabel_('2026-01-26'), '2026-W05');

  const last4 = lastCompletedWeeks_('2026-08-06', 4);
  eq('lastCompletedWeeks_(\'2026-08-06\', 4): 4 entries oldest-first',
    last4.map((w) => w.label), ['2026-W28', '2026-W29', '2026-W30', '2026-W31']);
  eq('lastCompletedWeeks_: full {label,start,end} shape',
    last4,
    [
      { label: '2026-W28', start: '2026-07-06', end: '2026-07-12' },
      { label: '2026-W29', start: '2026-07-13', end: '2026-07-19' },
      { label: '2026-W30', start: '2026-07-20', end: '2026-07-26' },
      { label: '2026-W31', start: '2026-07-27', end: '2026-08-02' }
    ]);
  check('lastCompletedWeeks_: every start is a Monday',
    last4.every((w) => new Date(w.start + 'T12:00:00Z').getUTCDay() === 1));
  check('lastCompletedWeeks_: every end is start+6 and < today',
    last4.every((w) => addDaysStr_(w.start, 6) === w.end && w.end < '2026-08-06'));

  // --- boundary: called on a Monday, the current week is never included ---
  const mondayCase = lastCompletedWeeks_('2026-08-03', 1);
  eq('called on a Monday: the newest entry is the week that ended yesterday',
    mondayCase,
    [{ label: '2026-W31', start: '2026-07-27', end: '2026-08-02' }]);
})();

/* ------------------------------------------------------------------ *
 * orderapp-pulls step 2 — shopifyWeeklyPull / shopifyWeeklyPull_impl_
 * ------------------------------------------------------------------ */

(function testShopifyWeeklyPull() {
  console.log('\norderapp: shopifyWeeklyPull_impl_ / shopifyWeeklyPull:');

  const REAL_URL_FETCH = global.UrlFetchApp;
  const TOKEN = 'shopify-test-token';
  const SHOPIFY_SUPPLIER = 'shopify_orderapp';
  const STAMP_PATTERN = "yyyy-MM-dd'T'HH:mm:ssXXX";

  function reset() {
    currentSS = makeSpreadsheet();
    scriptProps = { ORDER_APP_COST_TOKEN: TOKEN };
    calendarEvents = [];
    calendarFailMode = null;
    clearLoggedMessages();
    global.__forceLockTimeout = false;
  }

  // Sydney-local ISO datetime strings, matching what the Order app returns
  // for meta.weekStart / meta.weekEndExclusive.
  function weekBody(week, grossSales, orderCount) {
    return {
      ok: true,
      meta: {
        weekStart: week.start + 'T00:00:00+10:00',
        weekEndExclusive: addDaysStr_(week.end, 1) + 'T00:00:00+10:00',
        snapshot: true
      },
      summary: { orderCount: orderCount, grossSales: grossSales }
    };
  }

  // Route UrlFetchApp.fetch by the week= query param so each requested week
  // gets its own scripted response (a success body, or {ok:false,error:...}).
  function armShopifyFetch(bodiesByLabel) {
    global.UrlFetchApp = {
      fetch: (url) => {
        const m = /[?&]week=([^&]+)/.exec(String(url));
        const label = m ? decodeURIComponent(m[1]) : null;
        const body = bodiesByLabel[label];
        if (body === undefined) throw new Error('armShopifyFetch: no scripted response for week ' + label);
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
      },
    };
  }

  function summaryRows() {
    var sheet = currentSS.getSheetByName('Summary');
    return sheet ? sheet.getDataRange().getValues() : null;
  }

  function findSummaryRow(rows, weekStart) {
    for (var i = 1; i < rows.length; i++) {
      if (cellDate(rows[i][0]) === weekStart) return rows[i];
    }
    return null;
  }

  // The 4 requested weeks are derived from todayStr_() — genuinely "today" in
  // this environment (todayStr_ reads a bare `new Date()`, which withMockNow
  // cannot pin — see the top-of-file note on Date.now()/new Date() convention).
  const weeks4 = lastCompletedWeeks_(todayStr_(), 4);

  eq('SHOPIFY_REPULL_WEEKS is 4', SHOPIFY_REPULL_WEEKS, 4);

  /* --- case 1: 4 mocked weeks -> 4 Summary rows, exact column order,
   *     including a genuine zero-sales week (index 2) written as a real 0 ---
   */
  reset();
  const gross1 = [111.11, 222.22, 0, 444.44];
  const orders1 = [5, 6, 0, 8];
  const bodies1 = {};
  weeks4.forEach((w, i) => { bodies1[w.label] = weekBody(w, gross1[i], orders1[i]); });
  armShopifyFetch(bodies1);

  var pulledAt1, res1;
  withMockNow('2026-08-06T00:00:00Z', function () {
    pulledAt1 = mockFormatDate(new Date(Date.now()), 'Australia/Sydney', STAMP_PATTERN);
    res1 = shopifyWeeklyPull_impl_();
  });

  eq('case1: weeksRequested', res1.weeksRequested, 4);
  eq('case1: weeksFetched', res1.weeksFetched, 4);
  eq('case1: rowsAdded', res1.rowsAdded, 4);
  eq('case1: rowsUpdated', res1.rowsUpdated, 0);
  eq('case1: duplicatesSkipped', res1.duplicatesSkipped, 0);
  check('case1: no apiFailed flag on full success', !res1.apiFailed);

  var rows1 = summaryRows();
  eq('case1: header + 4 rows', rows1.length, 5);
  weeks4.forEach((w, i) => {
    var row = findSummaryRow(rows1, w.start);
    check('case1: a row exists for week ' + w.label, !!row);
    if (!row) return;
    eq('case1: row for ' + w.label + ' week_end', cellDate(row[1]), w.end);
    eq('case1: row for ' + w.label + ' supplier token is shopify_orderapp, never "shopify"', row[2], SHOPIFY_SUPPLIER);
    eq('case1: row for ' + w.label + ' location is online', row[3], 'online');
    eq('case1: row for ' + w.label + ' total is the raw grossSales (incl. real zero)', row[4], gross1[i]);
    eq('case1: row for ' + w.label + ' summarized_at stamp', row[5], pulledAt1);
    eq('case1: row for ' + w.label + ' department is Roastery', row[6], 'Roastery');
    eq('case1: row for ' + w.label + ' kind is revenue', row[7], 'revenue');
  });

  /* --- case 2: re-run with ONE week's gross changed -> that row updates in
   *     place (amount + stamp); the other 3 settle as duplicatesSkipped;
   *     row count is unchanged (settling-order case) ---
   */
  const gross2 = gross1.slice();
  gross2[1] = 999.99; // only week index 1 changes
  const bodies2 = {};
  weeks4.forEach((w, i) => { bodies2[w.label] = weekBody(w, gross2[i], orders1[i]); });
  armShopifyFetch(bodies2);

  var pulledAt2, res2;
  withMockNow('2026-08-07T00:00:00Z', function () {
    pulledAt2 = mockFormatDate(new Date(Date.now()), 'Australia/Sydney', STAMP_PATTERN);
    res2 = shopifyWeeklyPull_impl_();
  });

  eq('case2: rowsAdded stays 0 (settling)', res2.rowsAdded, 0);
  eq('case2: exactly the changed week updates', res2.rowsUpdated, 1);
  eq('case2: the other 3 settle as duplicatesSkipped', res2.duplicatesSkipped, 3);

  var rows2 = summaryRows();
  eq('case2: row count unchanged', rows2.length, 5);
  var changedRow2 = findSummaryRow(rows2, weeks4[1].start);
  var unchangedRow2 = findSummaryRow(rows2, weeks4[0].start);
  eq('case2: changed row total updated in place', changedRow2[4], 999.99);
  eq('case2: changed row stamp updated in place', changedRow2[5], pulledAt2);
  eq('case2: an UNCHANGED row keeps its ORIGINAL stamp (no write happened)', unchangedRow2[5], pulledAt1);
  eq('case2: an UNCHANGED row keeps its original total', unchangedRow2[4], gross1[0]);

  /* --- case 3: one of 4 weeks API-fails -> the other 3 ARE written,
   *     apiFailed:true, heartbeat NOT stamped, failcount NOT reset ---
   */
  reset();
  const bodies3 = {};
  weeks4.forEach((w, i) => { bodies3[w.label] = (i === 2) ? { ok: false, error: 'UPSTREAM' } : weekBody(w, 50 + i, 1); });
  armShopifyFetch(bodies3);

  var res3 = shopifyWeeklyPull(); // the lock-wrapped entry point — exercises the accounting
  check('case3: wrapper surfaces apiFailed:true from the impl', res3 && res3.apiFailed === true);
  eq('case3: failcount was incremented by orderAppRunStart_ (before the lock) and never reset',
    scriptProps['ORDERAPP_FAILCOUNT_' + SHOPIFY_SUPPLIER], '1');
  check('case3: heartbeat NOT stamped on a partial failure', !(('LAST_INGEST_' + SHOPIFY_SUPPLIER) in scriptProps));

  var rows3 = summaryRows();
  eq('case3: the 3 successful weeks ARE written', rows3.length, 4);

  /* --- case 4 (zero-sales week) is covered above: case1 index 2 asserts a
   *     real $0 row, not a skipped/omitted one. ---
   */

  /* --- case 5: key-disjointness — weeklySummarize must NEVER produce a
   *     Summary row keyed supplier='shopify_orderapp' from Revenue rows
   *     carrying source='shopify' or source='coffee_order_app'; those two
   *     writers (and this new one) must not be able to collide. ---
   */
  reset();
  withMockNow('2026-08-06T00:00:00Z', function () {
    var revSheet = ensureSheet(currentSS, 'Revenue', REVENUE_HEADERS);
    revSheet.appendRow(['2026-07-28', 'Roastery', 'online', 'guest', 100, 'ord-1', 'shopify', 'TS']);
    revSheet.appendRow(['2026-07-28', 'Roastery', 'online', 'guest', 100, 'ord-2', 'coffee_order_app', 'TS']);
    currentSS._sheets['Revenue'] = revSheet;
    weeklySummarize('2026-07-28');
  });
  var rows5 = summaryRows();
  eq('case5: sanity — both revenue groups landed (test is not vacuous)', rows5.length, 3);
  check('case5: the real "shopify" writer still gets its own Summary row',
    rows5.slice(1).some((r) => r[2] === 'shopify'));
  check('case5: the real "coffee_order_app" writer still gets its own Summary row',
    rows5.slice(1).some((r) => r[2] === 'coffee_order_app'));
  check('case5: weeklySummarize NEVER writes a Summary row keyed supplier=shopify_orderapp',
    rows5.slice(1).every((r) => r[2] !== SHOPIFY_SUPPLIER));

  /* --- case 6: Sheet Date read-back — a re-read hands week_start back as a
   *     real Date object (mirroring live Sheets auto-coercion on write);
   *     dedup must still work via coerceDateStr_/rowKey_ local-component
   *     coercion, not a string comparison that would silently never match. ---
   */
  reset();
  const bodies6 = {};
  weeks4.forEach((w, i) => { bodies6[w.label] = weekBody(w, 77 + i, 2); });
  armShopifyFetch(bodies6);
  shopifyWeeklyPull_impl_();

  var rawRows6 = currentSS.getSheetByName('Summary').getDataRange().getValues();
  check('case6: the week_start cell the Sheet hands back for dedup IS a Date object, not a string',
    rawRows6[1][0] instanceof Date);

  var res6 = shopifyWeeklyPull_impl_(); // identical data re-pulled against those Date cells
  eq('case6: Date-object week_start cells still dedup cleanly (no re-add)', res6.rowsAdded, 0);
  eq('case6: identical figures -> all 4 duplicatesSkipped', res6.duplicatesSkipped, 4);
  eq('case6: Summary row count unchanged', summaryRows().length, 5);

  /* --- case 7: lock timeout — orderAppRunStart_ already ran (counter
   *     incremented) before the lock is even attempted; nothing written ---
   */
  reset();
  global.__forceLockTimeout = true;
  var res7 = shopifyWeeklyPull();
  eq('case7: lock timeout return shape', res7, { locked: true });
  eq('case7: failcount was still incremented before the lock attempt',
    scriptProps['ORDERAPP_FAILCOUNT_' + SHOPIFY_SUPPLIER], '1');
  check('case7: a loud log records the lock timeout', lastLoggedMessages().some((m) => /lock/i.test(m)));
  check('case7: nothing was written to Summary', !currentSS.getSheetByName('Summary'));
  global.__forceLockTimeout = false;

  /* --- case 8: token unset -> {noToken:true}, nothing written, no heartbeat,
   *     and NO alert loop: a trigger armed before the token is pasted fires
   *     start->skip every week — the skip resets the counter, so the second
   *     (and every later) run never crosses the alert threshold. --- */
  reset();
  scriptProps = {};
  var res8 = shopifyWeeklyPull_impl_();
  eq('case8: no-token return shape', res8, { noToken: true });
  check('case8: nothing written to Summary', !currentSS.getSheetByName('Summary'));
  check('case8: no heartbeat stamped', !(('LAST_INGEST_' + SHOPIFY_SUPPLIER) in scriptProps));
  eq('case8: failcount reset by the not-armed skip',
    scriptProps['ORDERAPP_FAILCOUNT_' + SHOPIFY_SUPPLIER], '0');
  shopifyWeeklyPull(); // full entry point: start -> skip
  shopifyWeeklyPull(); // second scheduled run — the old bug alerted HERE
  eq('case8: repeated not-armed scheduled runs raise no alert', calendarEvents.length, 0);

  /* --- case 9: excluded buckets are surfaced, not discarded. The metric is
   *     gross of PAID/PARTIALLY_PAID: a refunded order drops its FULL amount
   *     into excluded — the buckets exist so that shrink can be reconciled. --- */
  reset();
  var weeks9 = lastCompletedWeeks_(todayStr_(), SHOPIFY_REPULL_WEEKS);
  var bodies9 = {};
  weeks9.forEach((w, i) => { bodies9[w.label] = weekBody(w, 200 + i, 3); });
  var excl9 = bodies9[weeks9[1].label];
  excl9.excluded = {
    byStatusTotals: { orderCount: 1, gross: 400 },
    cancelled: { count: 1, gross: 55.5 },
    test: { count: 0 }
  };
  armShopifyFetch(bodies9);
  var res9 = shopifyWeeklyPull_impl_();
  eq('case9: excludedGross totals every held-out bucket', res9.excludedGross, 455.5);
  check('case9: the held-out gross is logged with the week label',
    lastLoggedMessages().some((m) => m.indexOf(weeks9[1].label) !== -1 && m.indexOf('455.50') !== -1));
  var row9 = findSummaryRow(currentSS.getSheetByName('Summary').getDataRange().getValues(), weeks9[1].start);
  eq('case9: the Summary figure itself stays the API grossSales (excluded is surfaced, never added back)',
    row9[4], 201);
  delete bodies9[weeks9[1].label].excluded; // normal weeks carry no excluded buckets
  var res9b = shopifyWeeklyPull_impl_();
  eq('case9: weeks without excluded buckets report excludedGross 0', res9b.excludedGross, 0);

  global.UrlFetchApp = REAL_URL_FETCH;
})();

/* ------------------------------------------------------------------ *
 * orderapp-pulls step 3 — greenBeanInvoices_
 * ------------------------------------------------------------------ */

(function testGreenBeanInvoices() {
  console.log('\norderapp: greenBeanInvoices_:');

  // --- case: 3 lines, 1 invoice -> one row; total = sum; date = earliest dateLocal ---
  const case1 = greenBeanInvoices_([
    { dateLocal: '2026-06-15', supplierRaw: 'ACME Beans', supplierKey: 'acme_beans', invoiceNum: 'INV-1', totalCostIncGst: 100, status: 'RECEIVED' },
    { dateLocal: '2026-06-14', supplierRaw: 'ACME Beans', supplierKey: 'acme_beans', invoiceNum: 'INV-1', totalCostIncGst: 50, status: 'RECEIVED' },
    { dateLocal: '2026-06-16', supplierRaw: 'ACME Beans', supplierKey: 'acme_beans', invoiceNum: 'INV-1', totalCostIncGst: 25, status: 'RECEIVED' }
  ]);
  eq('3 lines/1 invoice: one summed row, date = earliest dateLocal', case1, [
    { date: '2026-06-14', supplier: 'ACME Beans', total: 175, invoice_ref: 'acme_beans/INV-1', department: 'Roastery' }
  ]);

  // --- case: two suppliers both carrying invoiceNum:'INV-100' -> two rows,
  //     distinct refs via the mandatory supplierKey prefix ---
  const case2 = greenBeanInvoices_([
    { dateLocal: '2026-06-10', supplierRaw: 'Bean Co', supplierKey: 'bean_co', invoiceNum: 'INV-100', totalCostIncGst: 200, status: 'RECEIVED' },
    { dateLocal: '2026-06-11', supplierRaw: 'Coffee Ltd', supplierKey: 'coffee_ltd', invoiceNum: 'INV-100', totalCostIncGst: 300, status: 'RECEIVED' }
  ]);
  eq('two suppliers sharing invoiceNum INV-100: two rows with distinct refs', case2, [
    { date: '2026-06-10', supplier: 'Bean Co', total: 200, invoice_ref: 'bean_co/INV-100', department: 'Roastery' },
    { date: '2026-06-11', supplier: 'Coffee Ltd', total: 300, invoice_ref: 'coffee_ltd/INV-100', department: 'Roastery' }
  ]);

  // --- case: blank invoiceNum, same supplier, two different days -> two rows,
  //     grouped per supplier per Sydney day (noinv-<date> ref) ---
  const case3 = greenBeanInvoices_([
    { dateLocal: '2026-06-01', supplierRaw: 'Roast Supply', supplierKey: 'roast_supply', invoiceNum: '', totalCostIncGst: 10, status: 'RECEIVED' },
    { dateLocal: '2026-06-02', supplierRaw: 'Roast Supply', supplierKey: 'roast_supply', invoiceNum: '', totalCostIncGst: 20, status: 'RECEIVED' }
  ]);
  eq('blank invoiceNum, same supplier, two different days: two noinv- rows', case3, [
    { date: '2026-06-01', supplier: 'Roast Supply', total: 10, invoice_ref: 'roast_supply/noinv-2026-06-01', department: 'Roastery' },
    { date: '2026-06-02', supplier: 'Roast Supply', total: 20, invoice_ref: 'roast_supply/noinv-2026-06-02', department: 'Roastery' }
  ]);

  // --- case: blank/missing invoiceNum, same supplier, same day, two lines ->
  //     one summed row (invoiceNum undefined counts as missing, same as '') ---
  const case4 = greenBeanInvoices_([
    { dateLocal: '2026-06-05', supplierRaw: 'Green Bean Traders', supplierKey: 'green_bean_traders', invoiceNum: '', totalCostIncGst: 15, status: 'RECEIVED' },
    { dateLocal: '2026-06-05', supplierRaw: 'Green Bean Traders', supplierKey: 'green_bean_traders', invoiceNum: undefined, totalCostIncGst: 5, status: 'PENDING' }
  ]);
  eq('blank/missing invoiceNum, same supplier+day, two lines: one summed row', case4, [
    { date: '2026-06-05', supplier: 'Green Bean Traders', total: 20, invoice_ref: 'green_bean_traders/noinv-2026-06-05', department: 'Roastery' }
  ]);

  // --- case: rounding happens ONCE at emit, not per-line ---
  const case5 = greenBeanInvoices_([
    { dateLocal: '2026-06-20', supplierRaw: 'Precise Coffee', supplierKey: 'precise_coffee', invoiceNum: 'INV-500', totalCostIncGst: 10.005, status: 'RECEIVED' },
    { dateLocal: '2026-06-20', supplierRaw: 'Precise Coffee', supplierKey: 'precise_coffee', invoiceNum: 'INV-500', totalCostIncGst: 0.001, status: 'RECEIVED' }
  ]);
  eq('rounding: 10.005 + 0.001 -> total 10.01, rounded once at emit', case5, [
    { date: '2026-06-20', supplier: 'Precise Coffee', total: 10.01, invoice_ref: 'precise_coffee/INV-500', department: 'Roastery' }
  ]);

  // --- case: empty input -> [] ---
  eq('empty input -> []', greenBeanInvoices_([]), []);

  // --- case: a flagged row with totalCostIncGst:0 still contributes a row,
  //     never dropped ---
  const case7 = greenBeanInvoices_([
    { dateLocal: '2026-06-25', supplierRaw: 'Flagged Supplier', supplierKey: 'flagged_supplier', invoiceNum: 'INV-700', totalCostIncGst: 0, status: 'RECEIVED', flags: ['non_numeric_source'] }
  ]);
  eq('flagged row with totalCostIncGst:0 still contributes a row', case7, [
    { date: '2026-06-25', supplier: 'Flagged Supplier', total: 0, invoice_ref: 'flagged_supplier/INV-700', department: 'Roastery' }
  ]);

  // --- case: mixed statuses (RECEIVED + PENDING) in one invoice -> single
  //     summed row, both lines counted (no status filtering) ---
  const case8 = greenBeanInvoices_([
    { dateLocal: '2026-06-30', supplierRaw: 'Mixed Status Co', supplierKey: 'mixed_status_co', invoiceNum: 'INV-800', totalCostIncGst: 40, status: 'RECEIVED' },
    { dateLocal: '2026-06-30', supplierRaw: 'Mixed Status Co', supplierKey: 'mixed_status_co', invoiceNum: 'INV-800', totalCostIncGst: 60, status: 'PENDING' }
  ]);
  eq('mixed statuses in one invoice: single summed row, both lines counted', case8, [
    { date: '2026-06-30', supplier: 'Mixed Status Co', total: 100, invoice_ref: 'mixed_status_co/INV-800', department: 'Roastery' }
  ]);

  // --- case: output order is deterministic (sorted by invoice_ref), regardless
  //     of input order ---
  const case9 = greenBeanInvoices_([
    { dateLocal: '2026-07-01', supplierRaw: 'Zzz Supplier', supplierKey: 'zzz_supplier', invoiceNum: 'INV-1', totalCostIncGst: 1, status: 'RECEIVED' },
    { dateLocal: '2026-07-01', supplierRaw: 'Aaa Supplier', supplierKey: 'aaa_supplier', invoiceNum: 'INV-1', totalCostIncGst: 2, status: 'RECEIVED' },
    { dateLocal: '2026-07-01', supplierRaw: 'Mmm Supplier', supplierKey: 'mmm_supplier', invoiceNum: 'INV-1', totalCostIncGst: 3, status: 'RECEIVED' }
  ]);
  eq('output order is deterministic: sorted by invoice_ref', case9.map((r) => r.invoice_ref), [
    'aaa_supplier/INV-1', 'mmm_supplier/INV-1', 'zzz_supplier/INV-1'
  ]);
})();

/* ------------------------------------------------------------------ *
 * orderapp-pulls step 4 — greenBeanWindow_ / greenBeanFetchAllRows_ /
 * greenBeanPull / greenBeanPull_impl_
 * ------------------------------------------------------------------ */

(function testGreenBeanWindow() {
  console.log('\norderapp: greenBeanWindow_:');

  eq('GREENBEAN_RESUM_CAP is 5', GREENBEAN_RESUM_CAP, 5);
  eq('GREENBEAN_RESUM_QUEUE_PROP name', GREENBEAN_RESUM_QUEUE_PROP, 'ORDERAPP_RESUM_QUEUE_greenbean');

  eq('year boundary: 2026-01-15 -> from = 1st of Nov 2025', greenBeanWindow_('2026-01-15'),
    { from: '2025-11-01', to: '2026-01-15' });
  eq('mid-year: 2026-08-06 -> from = 1st of Jun 2026', greenBeanWindow_('2026-08-06'),
    { from: '2026-06-01', to: '2026-08-06' });
  eq('month-2 rolls back a year cleanly: 2026-03-10 -> from = 2026-01-01', greenBeanWindow_('2026-03-10'),
    { from: '2026-01-01', to: '2026-03-10' });
})();

(function testGreenBeanFetchAllRowsPaging() {
  console.log('\norderapp: greenBeanFetchAllRows_ paging:');

  const REAL_URL_FETCH = global.UrlFetchApp;
  function reset() {
    currentSS = makeSpreadsheet();
    scriptProps = { ORDER_APP_COST_TOKEN: 'gb-token' };
    clearLoggedMessages();
  }

  /* --- case: two pages -> rows concatenated, offsets 0 then page1's
   *     returned count; the request carries the fixed greenBeanCost params
   *     and the greenBeanWindow_-computed from/to. --- */
  reset();
  const page1Rows = [
    { dateLocal: '2026-06-01', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 1, status: 'RECEIVED' },
    { dateLocal: '2026-06-02', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 2, status: 'RECEIVED' },
    { dateLocal: '2026-06-03', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 3, status: 'RECEIVED' }
  ];
  const page2Rows = [
    { dateLocal: '2026-06-04', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 4, status: 'RECEIVED' },
    { dateLocal: '2026-06-05', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 5, status: 'RECEIVED' }
  ];
  const requestedUrls = [];
  global.UrlFetchApp = {
    fetch: (url) => {
      requestedUrls.push(String(url));
      const m = /[?&]offset=([^&]+)/.exec(String(url));
      const offset = m ? Number(decodeURIComponent(m[1])) : 0;
      if (offset === 0) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ ok: true, meta: { paging: { truncated: true, rowsIncluded: true, returned: page1Rows.length } }, rows: page1Rows })
        };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, meta: { paging: { truncated: false, rowsIncluded: true, returned: page2Rows.length } }, rows: page2Rows })
      };
    },
  };
  const allRows = greenBeanFetchAllRows_();
  eq('paging: rows concatenated across both pages', allRows, page1Rows.concat(page2Rows));
  eq('paging: exactly 2 requests made', requestedUrls.length, 2);
  check('paging: first request carries offset=0', /[?&]offset=0(&|$)/.test(requestedUrls[0]));
  check('paging: second request carries offset=' + page1Rows.length,
    new RegExp('[?&]offset=' + page1Rows.length + '(&|$)').test(requestedUrls[1]));
  check('paging: request carries api=greenBeanCost', requestedUrls[0].indexOf('api=greenBeanCost') !== -1);
  check('paging: request carries status=ALL', requestedUrls[0].indexOf('status=ALL') !== -1);
  check('paging: request carries include=rows', requestedUrls[0].indexOf('include=rows') !== -1);
  check('paging: request carries limit=5000', requestedUrls[0].indexOf('limit=5000') !== -1);
  const expectedWindow = greenBeanWindow_(todayStr_());
  check('paging: request carries the computed from=', requestedUrls[0].indexOf('from=' + expectedWindow.from) !== -1);
  check('paging: request carries the computed to=', requestedUrls[0].indexOf('to=' + expectedWindow.to) !== -1);

  /* --- case: size-guard — truncated AND rows not included -> abort,
   *     returns null (never [] and never a silently partial array) --- */
  reset();
  global.UrlFetchApp = {
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, meta: { paging: { truncated: true, rowsIncluded: false, returned: 5000 } }, rows: [] })
    }),
  };
  const abortRows = greenBeanFetchAllRows_();
  check('size-guard: returns null, not [] or a partial array', abortRows === null);

  /* --- case: offset paging is not snapshot-stable (the Order app re-slices
   *     the live sheet per request), so a row inserted between pages can be
   *     resent. rowNumber is stable per row — a resent line is dropped, not
   *     double-summed into the invoice total. --- */
  reset();
  const dupePage1 = [
    { rowNumber: 10, dateLocal: '2026-06-01', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 1, status: 'RECEIVED' },
    { rowNumber: 11, dateLocal: '2026-06-02', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 2, status: 'RECEIVED' }
  ];
  const dupePage2 = [
    { rowNumber: 11, dateLocal: '2026-06-02', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 2, status: 'RECEIVED' },
    { rowNumber: 12, dateLocal: '2026-06-03', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 3, status: 'RECEIVED' }
  ];
  global.UrlFetchApp = {
    fetch: (url) => {
      const m = /[?&]offset=([^&]+)/.exec(String(url));
      const offset = m ? Number(decodeURIComponent(m[1])) : 0;
      const page = offset === 0 ? dupePage1 : dupePage2;
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, meta: { paging: { truncated: offset === 0, rowsIncluded: true, returned: page.length } }, rows: page })
      };
    },
  };
  const dedupedRows = greenBeanFetchAllRows_();
  eq('page-shift dupe: resent rowNumber kept once', dedupedRows.length, 3);
  eq('page-shift dupe: distinct rowNumbers survive in order',
    dedupedRows.map((r) => r.rowNumber), [10, 11, 12]);
  check('page-shift dupe: the skip is logged',
    lastLoggedMessages().some((m) => /duplicate row/i.test(m)));

  /* --- case: upstream diagnostics.warnings are logged verbatim — the API
   *     coerces non-numeric cells to 0 and drops invalid-Timestamp rows,
   *     reporting both ONLY here. --- */
  reset();
  global.UrlFetchApp = {
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        ok: true,
        meta: { paging: { truncated: false, rowsIncluded: true, returned: 1 } },
        diagnostics: { warnings: ['1 row(s) hidden by the from/to filter because their Timestamp cell is not a valid date.'] },
        rows: [{ rowNumber: 5, dateLocal: '2026-06-01', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 1, status: 'RECEIVED' }]
      })
    }),
  };
  calendarEvents = [];
  greenBeanFetchAllRows_();
  check('upstream warnings are logged verbatim',
    lastLoggedMessages().some((m) => m.indexOf('UPSTREAM WARNING') !== -1 && m.indexOf('Timestamp cell is not a valid date') !== -1));
  eq('upstream warnings raise ONE data-quality calendar alert', calendarEvents.length, 1);
  check('upstream-warning alert says the spend may be incomplete',
    calendarEvents[0]._description.indexOf('incomplete') !== -1);

  global.UrlFetchApp = REAL_URL_FETCH;
})();

(function testGreenBeanPullIngestAndResummarize() {
  console.log('\norderapp: greenBeanPull / greenBeanPull_impl_ — ingest + snapshot-diff resummarize:');

  const REAL_URL_FETCH = global.UrlFetchApp;
  const REAL_WEEKLY_SUMMARIZE = global.weeklySummarize;
  let weeklySummarizeCalls;

  // Spies on weeklySummarize while still running the REAL implementation —
  // this run is lock-wrapped (SCRIPT_LOCK_DEPTH_ reentrancy, Code.gs:100-139),
  // so nested weeklySummarize calls must actually succeed, not just be
  // recorded as no-ops.
  function armWeeklySummarizeSpy() {
    weeklySummarizeCalls = [];
    global.weeklySummarize = function (weekStartOverride) {
      weeklySummarizeCalls.push(weekStartOverride);
      return REAL_WEEKLY_SUMMARIZE(weekStartOverride);
    };
  }

  function line(dateLocal, supplierKey, supplierRaw, invoiceNum, total) {
    return { dateLocal: dateLocal, supplierRaw: supplierRaw, supplierKey: supplierKey, invoiceNum: invoiceNum, totalCostIncGst: total, status: 'RECEIVED' };
  }

  function armFetch(rows) {
    global.UrlFetchApp = {
      fetch: () => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, meta: { paging: { truncated: false, rowsIncluded: true, returned: rows.length } }, rows: rows })
      }),
    };
  }

  function suppliersRows() {
    return currentSS.getSheetByName('Suppliers').getDataRange().getValues();
  }
  function findSupplierRow(rows, invoiceRef) {
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][3]) === invoiceRef) return rows[i];
    }
    return null;
  }
  function queueProp() {
    const raw = scriptProps[GREENBEAN_RESUM_QUEUE_PROP];
    return raw ? JSON.parse(raw) : [];
  }

  // 8 completed weeks (oldest..newest) + the current, not-yet-completed week.
  // todayStr_()/lastCompletedWeeks_ read a bare `new Date()`, which
  // withMockNow cannot pin (see the shopify suite's note above) — so these
  // are genuinely "today" in whatever environment the suite runs in, same
  // convention as the shopify tests' weeks4.
  const weeksAll = lastCompletedWeeks_(todayStr_(), 8);
  const currentWeekStart = weekStartForDate_(todayStr_());

  currentSS = makeSpreadsheet();
  scriptProps = { ORDER_APP_COST_TOKEN: 'gb-token' };
  clearLoggedMessages();

  /* --- Run 1 (first-ever pull): 7 distinct completed weeks (weeksAll[1..7])
   *     each carrying at least one NEW invoice, plus one invoice dated in
   *     the CURRENT (incomplete) week -> exactly 5 of the 7 affected weeks
   *     are resummarized (cap), the oldest 2 are queued; the current-week
   *     invoice never counts as an affected week at all. --- */
  const run1Lines = [];
  for (let i = 1; i <= 7; i++) {
    run1Lines.push(line(weeksAll[i].start, 'plainw' + i, 'Plain Supplier ' + i, 'PLAIN-' + i, 100 + i));
  }
  run1Lines.push(line(weeksAll[7].start, 'changeco', 'Change Co', 'CHANGED-1', 100));
  run1Lines.push(line(weeksAll[6].start, 'staybase', 'Stay Base Co', 'UNCHANGED-1', 50));
  run1Lines.push(line(todayStr_(), 'curweek', 'Current Week Co', 'CUR-1', 10));

  armFetch(run1Lines);
  armWeeklySummarizeSpy();
  const res1 = greenBeanPull();

  eq('run1: rowsFetched = raw API row count', res1.rowsFetched, run1Lines.length);
  eq('run1: invoices = grouped invoice count (10 distinct supplierKey/invoiceNum pairs)', res1.invoices.length, 10);
  eq('run1: rowsAdded (all new)', res1.rowsAdded, 10);
  eq('run1: rowsUpdated', res1.rowsUpdated, 0);
  eq('run1: duplicatesSkipped', res1.duplicatesSkipped, 0);
  eq('run1: weeksResummarized capped at 5', res1.weeksResummarized, 5);
  eq('run1: weeksQueued = the 2 overflow weeks', res1.weeksQueued, 2);
  check('run1: no apiFailed flag on full success', !res1.apiFailed);

  eq('run1: weeklySummarize called for exactly the 5 OLDEST affected weeks, oldest-first',
    weeklySummarizeCalls, [weeksAll[1].start, weeksAll[2].start, weeksAll[3].start, weeksAll[4].start, weeksAll[5].start]);
  check('run1: the current (incomplete) week was never resummarized',
    weeklySummarizeCalls.indexOf(currentWeekStart) === -1);

  eq('run1: the 2 overflow weeks are persisted to the queue property, oldest-first',
    queueProp(), [weeksAll[6].start, weeksAll[7].start]);

  eq('run1: Suppliers has header + 10 rows', suppliersRows().length, 11);
  check('run1: heartbeat stamped on full success (a non-empty queue is not a failure)',
    ('LAST_INGEST_greenbean' in scriptProps));

  /* --- Run 2 (following run, IDENTICAL data -> empty diff): the 2 queued
   *     weeks from run1 drain (get resummarized) even though nothing
   *     changed this run; the queue property empties. --- */
  armFetch(run1Lines);
  armWeeklySummarizeSpy();
  const res2 = greenBeanPull();

  eq('run2: rowsAdded (nothing new)', res2.rowsAdded, 0);
  eq('run2: rowsUpdated (nothing changed)', res2.rowsUpdated, 0);
  eq('run2: duplicatesSkipped (all 10 settle)', res2.duplicatesSkipped, 10);
  eq('run2: weeksResummarized = the 2 drained queue weeks', res2.weeksResummarized, 2);
  eq('run2: weeksQueued after drain', res2.weeksQueued, 0);
  eq('run2: weeklySummarize called for the 2 queued weeks, oldest-first',
    weeklySummarizeCalls, [weeksAll[6].start, weeksAll[7].start]);
  eq('run2: queue property is now empty', queueProp(), []);

  /* --- Run 3: a changed invoice (gains an EARLIER line -> resummarize must
   *     use the STORED date's week, not the recomputed min-date week), an
   *     unchanged invoice (contributes nothing), a brand-new invoice (its
   *     own computed week), and a CHANGED current-week invoice (ingested,
   *     but never resummarized/queued). --- */
  const run3Lines = [];
  for (let i = 1; i <= 7; i++) {
    run3Lines.push(line(weeksAll[i].start, 'plainw' + i, 'Plain Supplier ' + i, 'PLAIN-' + i, 100 + i)); // unchanged
  }
  run3Lines.push(line(weeksAll[7].start, 'changeco', 'Change Co', 'CHANGED-1', 100));    // original line, unchanged
  run3Lines.push(line(weeksAll[2].start, 'changeco', 'Change Co', 'CHANGED-1', 50));     // NEW line, EARLIER week -> total now differs
  run3Lines.push(line(weeksAll[6].start, 'staybase', 'Stay Base Co', 'UNCHANGED-1', 50)); // unchanged
  run3Lines.push(line(todayStr_(), 'curweek', 'Current Week Co', 'CUR-1', 20));           // changed, still current week
  run3Lines.push(line(weeksAll[3].start, 'newco', 'New Co', 'NEW-1', 77));                // brand new invoice

  armFetch(run3Lines);
  armWeeklySummarizeSpy();
  const res3 = greenBeanPull();

  eq('run3: rowsFetched = raw API row count (12; CHANGED-1 now carries 2 lines)', res3.rowsFetched, run3Lines.length);
  eq('run3: invoices = grouped invoice count (11; CHANGED-1 collapses to 1)', res3.invoices.length, 11);
  eq('run3: rowsAdded (NEW-1 only)', res3.rowsAdded, 1);
  eq('run3: rowsUpdated (CHANGED-1 + CUR-1)', res3.rowsUpdated, 2);
  eq('run3: duplicatesSkipped (7 plain + UNCHANGED-1)', res3.duplicatesSkipped, 8);

  eq('run3: weeklySummarize called for exactly {NEW-1 week, CHANGED-1 STORED week}, oldest-first',
    weeklySummarizeCalls, [weeksAll[3].start, weeksAll[7].start]);
  check('run3: the recomputed min-date week (from CHANGED-1\'s new earlier line) was NEVER resummarized',
    weeklySummarizeCalls.indexOf(weeksAll[2].start) === -1);
  check('run3: the unchanged invoice\'s week was never resummarized',
    weeklySummarizeCalls.indexOf(weeksAll[6].start) === -1);
  check('run3: the current week was never resummarized even though CUR-1 changed',
    weeklySummarizeCalls.indexOf(currentWeekStart) === -1);
  eq('run3: weeksResummarized', res3.weeksResummarized, 2);
  eq('run3: weeksQueued (nothing overflowed)', res3.weeksQueued, 0);
  eq('run3: queue property stays empty', queueProp(), []);
  check('run3: the current week was never queued either', queueProp().indexOf(currentWeekStart) === -1);

  const changedRow3 = findSupplierRow(suppliersRows(), 'changeco/CHANGED-1');
  check('run3: CHANGED-1 row exists', !!changedRow3);
  if (changedRow3) {
    eq('run3: CHANGED-1 total updated in place to the new summed value', Number(changedRow3[2]), 150);
    eq('run3: CHANGED-1 date column is untouched by the upsert (still the ORIGINAL stored date, not the new earlier one)',
      cellDate(changedRow3[0]), weeksAll[7].start);
  }
  const curRow3 = findSupplierRow(suppliersRows(), 'curweek/CUR-1');
  check('run3: CUR-1 row exists', !!curRow3);
  if (curRow3) {
    eq('run3: CUR-1 total updated in place even though its week is never resummarized', Number(curRow3[2]), 20);
  }

  /* --- token unset: nothing fetched, nothing written --- */
  currentSS = makeSpreadsheet();
  scriptProps = {};
  const res4 = greenBeanPull_impl_();
  eq('no-token: return shape', res4, { noToken: true });
  eq('no-token: Suppliers untouched (header row only)', suppliersRows().length, 1);

  /* --- size-guard abort, exercised through the full accounting wrapper:
   *     failcount increments (via orderAppRunStart_) but is NEVER reset, no
   *     heartbeat, Suppliers untouched, a loud log records the abort. --- */
  currentSS = makeSpreadsheet();
  scriptProps = { ORDER_APP_COST_TOKEN: 'gb-token', ORDERAPP_FAILCOUNT_greenbean: '1' };
  clearLoggedMessages();
  global.UrlFetchApp = {
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, meta: { paging: { truncated: true, rowsIncluded: false, returned: 5000 } }, rows: [] })
    }),
  };
  const res5 = greenBeanPull();
  check('size-guard abort: apiFailed:true surfaced from the wrapper', res5 && res5.apiFailed === true);
  eq('size-guard abort: failcount incremented by orderAppRunStart_ (1 -> 2) and NEVER reset',
    scriptProps.ORDERAPP_FAILCOUNT_greenbean, '2');
  check('size-guard abort: no heartbeat stamped', !('LAST_INGEST_greenbean' in scriptProps));
  eq('size-guard abort: Suppliers untouched (header row only)', suppliersRows().length, 1);
  check('size-guard abort: a loud log records the abort',
    lastLoggedMessages().some((m) => /truncat|abort|incomplete/i.test(m)));

  global.UrlFetchApp = REAL_URL_FETCH;
  global.weeklySummarize = REAL_WEEKLY_SUMMARIZE;
})();

/* ------------------------------------------------------------------ *
 * orderapp: flagged intake rows are surfaced (phase-end review fix).
 * Upstream coerces a non-numeric PriceKg/TotalKg to 0 and records it only in
 * the row's flags[] — the line still ingests (locked decision: never dropped),
 * but a $0 committed-spend line usually means an understated invoice, so the
 * count must be loud.
 * ------------------------------------------------------------------ */
(function testGreenBeanFlaggedRowsSurfaced() {
  console.log('\norderapp: greenBeanPull_impl_ — flagged rows surfaced:');

  const REAL_URL_FETCH = global.UrlFetchApp;
  currentSS = makeSpreadsheet();
  scriptProps = { ORDER_APP_COST_TOKEN: 'gb-token' };
  clearLoggedMessages();

  // Both rows dated in the current (incomplete) week — no resummarize noise.
  const today = todayStr_();
  global.UrlFetchApp = {
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        ok: true,
        meta: { paging: { truncated: false, rowsIncluded: true, returned: 2 } },
        rows: [
          { rowNumber: 2, dateLocal: today, supplierRaw: 'Flag Co', supplierKey: 'flag_co', invoiceNum: 'F-1', totalCostIncGst: 0, status: 'RECEIVED', flags: ['NON_NUMERIC_PRICE_KG'] },
          { rowNumber: 3, dateLocal: today, supplierRaw: 'Fine Co', supplierKey: 'fine_co', invoiceNum: 'OK-1', totalCostIncGst: 42, status: 'RECEIVED' }
        ]
      })
    }),
  };

  calendarEvents = [];
  const res = greenBeanPull_impl_();
  eq('flaggedRows counts rows carrying flags[]', res.flaggedRows, 1);
  check('flagged count is logged with remediation pointer',
    lastLoggedMessages().some((m) => m.indexOf('flagged intake row') !== -1 && m.indexOf('06_Stock_Intake') !== -1));
  eq('the flagged $0 line still ingested (never dropped)', res.rowsAdded, 2);
  eq('flagged rows raise ONE data-quality calendar alert', calendarEvents.length, 1);
  check('data-quality alert names the source and understated risk',
    calendarEvents[0]._title.indexOf('data quality: greenbean') !== -1 &&
    calendarEvents[0]._description.indexOf('UNDERSTATED') !== -1);

  global.UrlFetchApp = REAL_URL_FETCH;
})();

/* ------------------------------------------------------------------ *
 * orderapp: phase-end review round 2 — crash-safe queue, case-insensitive
 * snapshot diff, upstream-warning alert, zero-row window, online-revenue
 * ingest guard.
 * ------------------------------------------------------------------ */
(function testGreenBeanRound2Fixes() {
  console.log('\norderapp: round-2 fixes — crash-safe queue / snapshot casing / zero-row window:');

  const REAL_URL_FETCH = global.UrlFetchApp;
  const REAL_WEEKLY_SUMMARIZE = global.weeklySummarize;

  function armFetch(rows) {
    global.UrlFetchApp = {
      fetch: () => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, meta: { paging: { truncated: false, rowsIncluded: true, returned: rows.length } }, rows: rows })
      }),
    };
  }
  function queueProp() {
    const raw = scriptProps.ORDERAPP_RESUM_QUEUE_greenbean;
    return raw ? JSON.parse(raw) : [];
  }
  function reset() {
    currentSS = makeSpreadsheet();
    scriptProps = { ORDER_APP_COST_TOKEN: 'gb-token' };
    calendarEvents = [];
    clearLoggedMessages();
  }

  const weeks = lastCompletedWeeks_(todayStr_(), 8);

  /* --- crash-safe queue: the FULL affected list is persisted BEFORE the
   *     resummarize loop. Suppliers already holds the new totals at that
   *     point, so a mid-loop death would otherwise lose the diff forever. --- */
  reset();
  const crashLines = [];
  for (let i = 0; i < 7; i++) {
    crashLines.push({ dateLocal: weeks[i].start, supplierRaw: 'S' + i, supplierKey: 's' + i, invoiceNum: 'C-' + i, totalCostIncGst: 10 + i, status: 'RECEIVED' });
  }
  armFetch(crashLines);
  let summarizeCalls = 0;
  global.weeklySummarize = function () {
    summarizeCalls++;
    if (summarizeCalls === 2) throw new Error('simulated 6-minute death');
    return 'ok';
  };
  let crashThrew = false;
  try { greenBeanPull_impl_(); } catch (err) { crashThrew = true; }
  check('mid-loop death propagates (fail-open counting sees an incomplete run)', crashThrew);
  eq('the queue property still holds ALL 7 affected weeks (persisted pre-loop)',
    queueProp(), weeks.slice(0, 7).map((w) => w.start));
  check('no heartbeat stamped on the dead run', !('LAST_INGEST_greenbean' in scriptProps));
  global.weeklySummarize = REAL_WEEKLY_SUMMARIZE;

  /* --- snapshot casing: a retyped invoiceNum ('c-0' -> 'C-0') matches the
   *     same sheet row via upsertRows_'s case-insensitive key; the snapshot
   *     lookup must therefore hit too — the invoice classifies as an UPDATE
   *     whose affected week is the STORED week, never as a brand-new row. --- */
  reset();
  armFetch([{ dateLocal: weeks[0].start, supplierRaw: 'Case Co', supplierKey: 'case_co', invoiceNum: 'MIX-1', totalCostIncGst: 100, status: 'RECEIVED' }]);
  greenBeanPull_impl_(); // seeds Suppliers with case_co/MIX-1
  clearLoggedMessages();
  // same invoice retyped lowercase, in a LATER week, with a changed total
  armFetch([{ dateLocal: weeks[5].start, supplierRaw: 'Case Co', supplierKey: 'case_co', invoiceNum: 'mix-1', totalCostIncGst: 150, status: 'RECEIVED' }]);
  let casingCalls = [];
  global.weeklySummarize = function (w) { casingCalls.push(w); return REAL_WEEKLY_SUMMARIZE(w); };
  const casingRes = greenBeanPull_impl_();
  eq('retyped-casing invoice updates the existing row, adds nothing', casingRes.rowsAdded, 0);
  eq('retyped-casing invoice counts as updated', casingRes.rowsUpdated, 1);
  eq('affected week = the STORED row week, not the retyped line week',
    casingCalls, [weeks[0].start]);
  global.weeklySummarize = REAL_WEEKLY_SUMMARIZE;

  /* --- zero-row full window: completes (no alert spam) but warns loudly --- */
  reset();
  armFetch([]);
  const zeroRes = greenBeanPull_impl_();
  eq('zero-row window: run completes', zeroRes.rowsFetched, 0);
  eq('zero-row window: no failure alert', calendarEvents.length, 0);
  check('zero-row window: loud WARNING logged',
    lastLoggedMessages().some((m) => m.indexOf('0 intake rows across the entire 3-month window') !== -1));

  global.UrlFetchApp = REAL_URL_FETCH;
  global.weeklySummarize = REAL_WEEKLY_SUMMARIZE;
})();

/* ------------------------------------------------------------------ *
 * validateIngest_ — online-revenue exclusivity guard (PRD-10, round 2):
 * the other half of the coffee_order_app suppliers rejection. Online
 * revenue's only sanctioned producer is the shopifyWeeklyPull Summary
 * write; a POSTed online revenue row would double-count the week.
 * ------------------------------------------------------------------ */
(function testOnlineRevenueIngestGuard() {
  console.log('\nvalidateIngest_ — online-channel revenue rejection (PRD-10):');

  function revenueBody(channel, source) {
    return {
      source: source || 'coffee_order_app',
      kind: 'revenue',
      extracted_at: '2026-08-06T10:00:00+10:00',
      rows: [{ date: '2026-08-01', department: 'Roastery', channel: channel, customer: 'X', amount: 10, order_ref: 'OR-1' }]
    };
  }

  const rejected = validateIngest_(revenueBody('online'));
  eq('channel=online revenue is rejected', rejected.ok, false);
  check('rejection message names the shopify_orderapp exclusivity',
    rejected.message.indexOf('shopify_orderapp') !== -1 && rejected.message.indexOf('PRD-10') !== -1);
  eq('casing does not bypass the guard', validateIngest_(revenueBody(' Online ')).ok, false);
  eq('wholesale revenue still accepted', validateIngest_(revenueBody('wholesale')).ok, true);
  eq('any source is blocked, not just coffee_order_app',
    validateIngest_(revenueBody('online', 'future_connector')).ok, false);
})();

/*
 * orderapp-pulls step 6 — installOrderAppTriggers
 */
(function testInstallOrderAppTriggers() {
  console.log('\norderapp: installOrderAppTriggers (step 6):');

  var hasInstallFn = typeof installOrderAppTriggers === 'function';
  check('installOrderAppTriggers is defined', hasInstallFn);

  if (!hasInstallFn) {
    console.log('  (skipping installOrderAppTriggers cases — function not defined)');
    return;
  }

  // Unrelated trigger present before install — the installer must only ever
  // touch its own two handler names, never sweep the whole trigger list.
  scriptTriggers = [];
  ScriptApp.newTrigger('shopSpendWatchdog')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(14)
    .inTimezone('Australia/Sydney').create();

  installOrderAppTriggers();
  installOrderAppTriggers();

  var shopifyTriggers = ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'shopifyWeeklyPull'; });
  var greenBeanTriggers = ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'greenBeanPull'; });
  var watchdogTriggers = ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'shopSpendWatchdog'; });

  eq('installing twice leaves exactly one trigger for shopifyWeeklyPull', shopifyTriggers.length, 1);
  eq('installing twice leaves exactly one trigger for greenBeanPull', greenBeanTriggers.length, 1);
  check('installer does not delete the unrelated shopSpendWatchdog trigger',
    watchdogTriggers.length === 1);

  if (shopifyTriggers.length === 1) {
    var shopifyCfg = shopifyTriggers[0]._cfg;
    eq('shopify trigger is MONDAY', shopifyCfg.weekDay, ScriptApp.WeekDay.MONDAY);
    eq('shopify trigger is hour 5', shopifyCfg.hour, 5);
    eq('shopify trigger is Australia/Sydney', shopifyCfg.timezone, 'Australia/Sydney');
  }

  if (greenBeanTriggers.length === 1) {
    var greenBeanCfg = greenBeanTriggers[0]._cfg;
    eq('greenbean trigger is TUESDAY', greenBeanCfg.weekDay, ScriptApp.WeekDay.TUESDAY);
    eq('greenbean trigger is hour 5', greenBeanCfg.hour, 5);
    eq('greenbean trigger is Australia/Sydney', greenBeanCfg.timezone, 'Australia/Sydney');
  }

  scriptTriggers = [];
})();

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
