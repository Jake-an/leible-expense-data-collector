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

// REAL Drive-OCR text for the Mayers documents, harvested 2026-08-20.
// See that file header for why the old hand-written fixtures were themselves a bug.
const {
  MAYERS_OCR_3446281_NORTH,
  MAYERS_OCR_3463868_PITT,
  MAYERS_OCR_3434688_YORK,
  MAYERS_OCR_STATEMENT_LEI04D,
} = require('./fixtures_mayers_ocr.js');

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
  // deleteRow call log (row numbers, in call order) — needed to assert a
  // guarded deletion path backs up before its first delete and deletes
  // bottom-up (descending row indices), not just that the final row count is
  // right. Same rationale as writeOrderLog below: post-state alone cannot
  // answer an ordering question.
  const deleteRowCalls = [];
  // Records multi-row/whole-row write calls (appendRow, setValues) so tests
  // can assert HOW a batch was written — one setValues() block vs N
  // appendRow() calls — not just the resulting sheet state, which the two
  // approaches make identical. Per-cell setValue() is not recorded: no test
  // needs its call count.
  function recordWrite(type, numRows) {
    const entry = { type, sheet: name, numRows };
    writeCalls.push(entry);
    if (globalWriteLog) globalWriteLog.push(entry);
    writeOrderLog.push({ sheet: name, type: type });
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
      setValue(v) {
        setCell(row - 1, col - 1, v);
        writeOrderLog.push({ sheet: name, type: 'setValue', row: row, col: col });
        return chain;
      },
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
  // Counts getDataRange() calls so a test can assert a multi-week caller
  // filters an external source sheet once, not once per week (labourWeeklyPull_).
  let dataRangeCallCount = 0;
  return {
    _rows: rows,
    appendRow: (a) => { rows.push(a.map(sheetCoerceOnWrite)); recordWrite('appendRow', 1); },
    deleteRow: (rowNum) => {
      deleteRowCalls.push(rowNum);
      writeOrderLog.push({ sheet: name, type: 'deleteRow', row: rowNum });
      rows.splice(rowNum - 1, 1);
    },
    getDeleteRowCalls: () => deleteRowCalls.slice(),
    // Real Sheet#clearContents wipes every cell (incl. the header row) but
    // leaves the sheet object itself intact — a rebuilt report has no fixed
    // header, so the mock just empties the row store.
    clearContents: () => { const n = rows.length; rows.length = 0; recordWrite('clearContents', n); },
    getDataRange: () => { dataRangeCallCount++; return { getValues: () => rows.map((r) => r.slice()) }; },
    getDataRangeCallCount: () => dataRangeCallCount,
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

// Cross-sheet write-order log: appendRow / setValues / per-cell setValue all
// push here, in call order, regardless of which sheet or which mechanism —
// needed to assert "the backup snapshot is written before any Summary
// setValue" (PRD-12 guarded write path). The pre-existing writeCalls log is
// per-spreadsheet but excludes per-cell setValue by design (see the comment
// above it), and rangeCalls is per-sheet — neither can answer a cross-sheet
// ordering question, which is why this is a separate, additive log.
let writeOrderLog = [];
function getWriteOrderLog() { return writeOrderLog.slice(); }
function clearWriteOrderLog() { writeOrderLog = []; }

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
    // Real GAS has getKeys(); the mock did not, so mayersRepairSnapshotWeeks_
    // would have enumerated nothing and the zero-arg rollback would have
    // reported "nothing to roll back" over a live snapshot.
    getKeys: () => Object.keys(scriptProps),
  }),
};

// Calendar stub — captures created events so alert behaviour is assertable.
let calendarEvents = [];
let calendarFailMode = null;   // 'byId' | 'all' | null
// step8 FIX4: counts getEventsForDay() calls so a test can assert the day's
// events are read ONCE per invocation (raiseCalendarAlert_/its callers),
// regardless of how many alerts are raised in that invocation.
let getEventsForDayCallCount = 0;
function resetGetEventsForDayCallCount() { getEventsForDayCallCount = 0; }
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
  // RED is additive here for the summary-heal high-severity alert (PRD-12) —
  // every pre-existing alert in this codebase only ever used ORANGE.
  EventColor: { ORANGE: 'ORANGE', RED: 'RED' },
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
    getEventsForDay: () => { getEventsForDayCallCount++; return calendarEvents.slice(); },
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
// Re-entrant: restores the PREVIOUS Date.now, not the real one. A nested
// withMockNow used to hand the real clock back to its enclosing block, so a
// suite-wide pin silently expired at the first inner mock — which matters now
// that todayStr_ is mock-observable (Code.gs: new Date(Date.now())).
function withMockNow(isoInstant, fn) {
  const ms = new Date(isoInstant).getTime();
  const prev = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = prev; }
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
/* PHASE FREEZE (Code.gs SUMMARY_HEAL_FROZEN_, 2026-08-26). The frozen WRITE
 * paths — the multi-week heal window, runSummaryOrphanSweep's apply half and
 * restoreSummaryWeekFromBackup — still have to be CORRECT for the day the
 * freeze is lifted, so every pre-existing test that exercises one runs its
 * body with the freeze off. The freeze's own refusals are asserted separately
 * (the step10 FIX3 block at the end of this file). Toggling works because
 * load() uses indirect eval, so each `var` in the .gs files is a real,
 * writable globalThis property (same mechanism the MAYERS_PARSER_VERSION
 * tests already rely on). try/finally, never a bare reassign: a throw inside
 * a wrapped block would otherwise leave the freeze OFF for every test after
 * it, and the freeze tests would then pass vacuously. */
function withHealUnfrozen(fn) {
  const saved = globalThis.SUMMARY_HEAL_FROZEN_;
  globalThis.SUMMARY_HEAL_FROZEN_ = false;
  try { return fn(); } finally { globalThis.SUMMARY_HEAL_FROZEN_ = saved; }
}

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
load('summary_audit.gs');
load('summary_drift_repair.gs');  // TEMPORARY — deleted with the file after the repair verifies

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
  eq('batch of 3 with 1 dup → 2 added, 1 skipped', r1,
    { rowsAdded: 2, rowsUpdated: 0, duplicatesSkipped: 1, updates: [], archivedSkipped: 0 });
  const r2 = ingestSupplierRows('kent_paper', batch, 'TS', sheet);
  eq('re-ingest same batch → 0 added (all dup vs sheet)', r2,
    { rowsAdded: 0, rowsUpdated: 0, duplicatesSkipped: 3, updates: [], archivedSkipped: 0 });
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

console.log('mayersShopFromText_ — REAL Drive-OCR fixtures');
// Fixture fidelity first: if someone "tidies" a fixture, this fails before the
// shop assertions do, so the failure names the real cause rather than looking
// like a parser regression. Verified 2026-08-20 — all four fixtures reproduce
// the harvest Doc's recorded production verdicts byte for byte.
check('North fixture is real OCR — the Bill-To run-on line is intact',
  MAYERS_OCR_3446281_NORTH.indexOf('LEIBLE COFFEE NORTH SYDNEY LEGEND STAR INVESTMENTS PTY LTD 5 BLUES ST') !== -1);
check('North fixture carries its LEI07D account code',
  MAYERS_OCR_3446281_NORTH.indexOf('LEI07D') !== -1);

// [1] THE DEFECT, on the text that caused it. Live Suppliers row 3446281
// ($570.15, wk 2026-07-27) stored
//   'UNMAPPED: LEIBLE COFFEE NORTH SYDNEY 5 BLUES ST NORTH SYDNEY NSW 2060 '
// because /\bBLUE\s*ST/i matches 'BLUE' inside 'BLUES' and then demands 'ST'
// where an 'S' stands. Jake, 2026-08-20: "if you see 5 blue street it is north
// sydney invoice".
eq('real 3446281 (5 BLUES ST) → Leible North',
  mayersShopFromText_(MAYERS_OCR_3446281_NORTH), 'Leible North');
eq('real 3446281 parses whole — North, $570.15, ref and date intact',
  parseMayersInvoice_(MAYERS_OCR_3446281_NORTH, '2026-07-31'),
  { date: '2026-07-31', total: 570.15, invoice_ref: '3446281', location: 'Leible North' });

// [2][3] No regression on the two shops that already resolved correctly.
eq('real 3463868 (130 PITT ST) → Leible Pitt',
  mayersShopFromText_(MAYERS_OCR_3463868_PITT), 'Leible Pitt');
eq('real 3434688 (89 YORK ST) → Leible York',
  mayersShopFromText_(MAYERS_OCR_3434688_YORK), 'Leible York');

// [4] The monthly LEI04D statement is not an invoice and never will be: no
// 'Invoice No', no 'Deliver To', and its only 'Total' is a balance with no
// cents-anchored value adjacent. This is the permanent-failure document the
// unparseable memo (8ae39d8) exists to stop re-OCRing every day.
check('real LEI04D statement → parseMayersInvoice_ returns null',
  parseMayersInvoice_(MAYERS_OCR_STATEMENT_LEI04D, '2026-08-04') === null);

console.log('mayersShopFromText_ — two-pass Deliver-To scoping');
// [5] Steal guard. The goods went to Crows Nest; a North Sydney address sits in
// the Bill-To block. Pass 1 scopes to Deliver-To, so Bill-To cannot win.
eq('Deliver-To Crows Nest beats a stray BLUES ST in Bill-To',
  mayersShopFromText_([
    'Bill To :', 'LEIBLE COFFEE NORTH SYDNEY 5 BLUES ST', 'NORTH SYDNEY NSW 2060',
    'Deliver To:', 'LEIBLE COFFEE ROASTERY', '4 BURLINGTON ST', 'CROWS NEST NSW 2065',
  ].join('\n')), 'Leible Crowsnest');
// [5b] The same guard with the SINGULAR spelling, which the old whole-text scan
// did match. This one fails without the two-pass split — the widened regex
// alone cannot save it, because MAYERS_SHOP_RULES_ tests North before Crowsnest
// and a whole-text scan has no way to prefer the delivery address.
eq('Deliver-To Crows Nest beats a stray singular BLUE ST in Bill-To',
  mayersShopFromText_([
    'Bill To :', 'LEIBLE COFFEE NORTH SYDNEY', 'BLUE ST', 'NORTH SYDNEY NSW 2060',
    'Deliver To:', '4 BURLINGTON ST', 'CROWS NEST NSW 2065',
  ].join('\n')), 'Leible Crowsnest');

// [6] Whole-text retry. Pass 2 is byte-identical to the scan this function has
// always done, so scoping can only ever REASSIGN a shop, never lose one.
eq('no Deliver To marker at all → whole-text retry still finds York',
  mayersShopFromText_('LEIBLE COFFEE\n89 YORK ST\nSYDNEY NSW 2000'), 'Leible York');
// The rejected strict-Deliver-To-only design (decision 2) would return UNMAPPED
// here: the shop address sits past the 120-char capture window.
eq('address outside the Deliver-To window → whole-text retry still finds it',
  mayersShopFromText_(
    'Deliver To:\nATTN GOODS INWARD\n' + 'x'.repeat(140) + '\n130 PITT ST\nSYDNEY'),
  'Leible Pitt');

// [7][8] Fallbacks, unchanged.
eq('no address anywhere → empty string', mayersShopFromText_('just some random text'), '');
check('unknown address under Deliver To → UNMAPPED prefix',
  mayersShopFromText_('Deliver To:\n99 GEORGE ST\nSYDNEY').indexOf('UNMAPPED:') === 0);

// [9] Back-compat for the singular spelling. SYNTHETIC — no Mayers invoice has
// ever contained 'BLUE ST'. It survives only to prove the widening to
// /\bBLUES?\s*ST/i did not drop the singular form; the real-invoice claim is
// carried by case [1] above. The assertion this replaces asserted the singular
// spelling as though it were real, which is why 1112 green tests coexisted with
// a live money bug for two months (decisions.md, decision 8).
eq('synthetic singular BLUE ST still → Leible North',
  mayersShopFromText_('BLUE ST\nNORTH SYDNEY NSW 2060'), 'Leible North');
eq('Burlington → Leible Crowsnest', mayersShopFromText_('4 BURLINGTON ST\nCROWS NEST'), 'Leible Crowsnest');
eq('Crows Nest keyword → Leible Crowsnest', mayersShopFromText_('CROWS NEST NSW 2065'), 'Leible Crowsnest');

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

console.log('aggregateSupplierRows_ revenue grain — online is pull-owned and EXCLUDED');
(function () {
  // Revenue row order: [date, department, channel, customer, amount, order_ref, source, extracted_at]

  // 1 + 2 + 8: online rows produce NO Summary group at all (orderapp-pulls
  // phase, PRD-10): the pull-owned supplier='shopify_orderapp' row is the sole
  // online figure; a derived per-source row would sit beside it under a
  // different key and doGet would sum both. Exclusion is counted + logged.
  clearLoggedMessages();
  var online = [
    ['2026-06-16', 'Roastery', 'online', '#1041', 62, 'O-1', 'shopify', 'TS'],
    ['2026-06-17', 'Roastery', 'online', '#1042', 48.5, 'O-2', 'shopify', 'TS'],
    ['2026-06-18', 'Roastery', 'online', 'Sarah Chen', 120, 'O-3', 'shopify', 'TS'],
  ];
  var r1 = aggregateSupplierRows_(online, '2026-06-15', '2026-06-21', 'revenue');
  eq('online: rows are excluded, no derived group', r1.length, 0);
  check('online: the exclusion is logged with count + dollars',
    lastLoggedMessages().some(function (m) {
      return m.indexOf('excluded 3 historical channel=online') !== -1 && m.indexOf('$230.5') !== -1;
    }));

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

  // 4: both channels in one call — online excluded, wholesale preserved.
  var mixed = online.concat(wholesale);
  var r3 = aggregateSupplierRows_(mixed, '2026-06-15', '2026-06-21', 'revenue');
  eq('mixed: 2 groups (0 online + 2 wholesale)', r3.length, 2);
  eq('mixed: sorted keys → Bar Mero, Cafe X',
    r3.map(function (g) { return g.supplier; }).join(','), 'Bar Mero,Cafe X');

  // 5: the exclusion is case-insensitive AND trims — a mixed-casing residual
  // row must not sneak back in as a derived group.
  var capitalised = [
    ['2026-06-16', 'Roastery', 'Online', '#2001', 10, 'C-1', 'shopify', 'TS'],
    ['2026-06-17', 'Roastery', ' ONLINE ', '#2002', 20, 'C-2', 'shopify', 'TS'],
  ];
  var r4 = aggregateSupplierRows_(capitalised, '2026-06-15', '2026-06-21', 'revenue');
  eq('"Online" / " ONLINE " are excluded too', r4.length, 0);

  // 7: department still splits (non-online).
  var twoDepts = [
    ['2026-06-16', 'Roastery', 'wholesale', 'Cafe Z', 50, 'D-1', 'coffee_order_app', 'TS'],
    ['2026-06-17', 'Cafe', 'wholesale', 'Cafe Z', 70, 'D-2', 'coffee_order_app', 'TS'],
  ];
  var r6 = aggregateSupplierRows_(twoDepts, '2026-06-15', '2026-06-21', 'revenue');
  eq('two departments → two groups', r6.length, 2);
  eq('...Cafe sorts first', r6[0].department + '|' + r6[0].total, 'Cafe|70');
  eq('...Roastery second', r6[1].department + '|' + r6[1].total, 'Roastery|50');

  // 10: Date-object date cells (the project's most-repeated trap) still filter
  // correctly — coerceDateStr_ is untouched, this guards against regressing it.
  var dateCells = [
    [new Date(2026, 5, 16), 'Roastery', 'wholesale', 'Cafe D', 100, 'DT-1', 'coffee_order_app', 'TS'],
    [new Date(2026, 5, 10), 'Roastery', 'wholesale', 'Cafe D', 999, 'DT-2', 'coffee_order_app', 'TS'], // before week
    [new Date(2026, 5, 25), 'Roastery', 'wholesale', 'Cafe D', 888, 'DT-3', 'coffee_order_app', 'TS'], // after week
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
 * The cleanup round trip: purge → re-summarize. SEMANTICS CHANGED by the
 * orderapp-pulls phase (PRD-10): online revenue is pull-owned, so
 * aggregateSupplierRows_ no longer derives ANY online Summary row from
 * Revenue — a resummarize after the purge regenerates NOTHING online. The
 * backup tab is the permanent record of purged figures; go-forward weeks
 * come from shopifyWeeklyPull. This test pins the NEW contract so the live
 * runbook can rely on it.
 * ------------------------------------------------------------------ */

(function testOnlineRevenueCleanupRoundTrip() {
  console.log('\nonline-revenue cleanup round trip (purge → resummarize, pull-owned semantics):');

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
  eq('re-summarize still walks both weeks', res.weeks, 2);

  // NEW contract: nothing online comes back — the pull owns the channel and
  // the backup tab is the record. Regenerating a per-source row here would
  // recreate the exact double-count the phase closed.
  var out = s.getDataRange().getValues();
  check('re-summarize regenerates NO online Summary row',
    out.slice(1).every((r) => String(r[3]).trim().toLowerCase() !== 'online'));
  var backupOut = currentSS.getSheetByName(ONLINE_REVENUE_BACKUP_TAB).getDataRange().getValues();
  eq('the backup tab remains the permanent record of every purged figure (+header)',
    backupOut.length, 4);
  eq('backup keeps the recent-week dollars', backupOut.slice(1).reduce((a, r) => a + Number(r[4]), 0), 180);

  // Post-cleanup, the trigger's Monday run must be a no-op on these weeks
  // rather than deriving anything online: Summary stays empty (header only).
  var rerun = weeklySummarize('2026-06-15');
  eq('re-running the week adds nothing', rerun.summariesAdded, 0);
  eq('re-running the week updates nothing', rerun.summariesUpdated, 0);
  eq('Summary row count unchanged by the re-run (header only)', s.getDataRange().getValues().length, 1);

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
 * Step 1 — labourWeeklyPull_ reports summaryUpdated and takes a week list
 *
 * PRD-12: the correction alert needs to see a labour correction as a real
 * update, not a silent zero — labourWeeklyPull_ dropped rowsUpdated on the
 * floor (Code.gs:781: `summaryAdded: summaryResult.rowsAdded` only). It also
 * now takes a week LIST so a multi-week heal can filter the external
 * LABOUR_COST source once instead of once per week.
 * ------------------------------------------------------------------ */

(function testLabourWeeklyPullReportsUpdatesAndWeekList() {
  console.log('\nlabourWeeklyPull_ — summaryUpdated + week list:');

  function seedLabourWeeks(weekRows) {
    currentSS = makeSpreadsheet();
    scriptProps = { LABOUR_SHEET_ID: 'labour-sheet-id' };
    var src = currentSS.insertSheet('LABOUR_COST');
    src.appendRow(['week_start', 'week_end', 'location', 'total', 'iso_week', 'pulled_at']);
    weekRows.forEach(function (r) { src.appendRow(r); });
    return src;
  }

  // Case: a one-element list behaves exactly like the old single-week call
  // (see testLabourWeeklyPullDedup above for the values this mirrors).
  var src1 = seedLabourWeeks([
    ['2026-06-15', '2026-06-21', 'york', 4830.14, '2026-W25', 'x'],
    ['2026-06-15', '2026-06-21', 'pitt', 6720.32, '2026-W25', 'x'],
  ]);
  var ss1 = currentSS;
  var summSheet1 = ensureSheet(ss1, SUMMARY_TAB, SUMMARY_HEADERS);
  var week1 = { start: '2026-06-15', end: '2026-06-21' };
  var res1 = labourWeeklyPull_([week1], ss1, summSheet1, 'T1');
  eq('one-element list: labourAdded matches the old single-week call', res1.labourAdded, 2);
  eq('one-element list: summaryAdded matches the old single-week call', res1.summaryAdded, 2);

  // summaryUpdated must be present (not undefined) even when nothing updated.
  check('summaryUpdated is defined on a plain add', res1.summaryUpdated !== undefined);
  eq('nothing to update yet -> summaryUpdated 0', res1.summaryUpdated, 0);

  // A labour correction (changed total for an already-summarized week) must
  // surface as summaryUpdated >= 1, not a silent summaryAdded:0 — the whole
  // point of this step, since "read the returned counts" is the verification
  // instruction for this path.
  src1.getRange(2, 4).setValue(5200.00); // york's total, same week/location
  var res2 = labourWeeklyPull_([week1], ss1, summSheet1, 'T2');
  eq('correction: no new Labour tab rows (dedup by week||location)', res2.labourAdded, 0);
  check('correction: summaryUpdated is at least 1 (not a silent zero)', res2.summaryUpdated >= 1);

  // A 4-week list reads the external LABOUR_COST source exactly once, not
  // once per week — a naive per-week loop would pay four cross-spreadsheet
  // reads for what should be one.
  var src4 = seedLabourWeeks([
    ['2026-06-15', '2026-06-21', 'york', 100, '2026-W25', 'x'],
    ['2026-06-22', '2026-06-28', 'york', 110, '2026-W26', 'x'],
    ['2026-06-29', '2026-07-05', 'york', 120, '2026-W27', 'x'],
    ['2026-07-06', '2026-07-12', 'york', 130, '2026-W28', 'x'],
  ]);
  var ss4 = currentSS;
  var summSheet4 = ensureSheet(ss4, SUMMARY_TAB, SUMMARY_HEADERS);
  var weeks4 = [
    { start: '2026-06-15', end: '2026-06-21' },
    { start: '2026-06-22', end: '2026-06-28' },
    { start: '2026-06-29', end: '2026-07-05' },
    { start: '2026-07-06', end: '2026-07-12' },
  ];
  var res4 = labourWeeklyPull_(weeks4, ss4, summSheet4, 'T4');
  eq('4-week list: all 4 weeks land in the Labour tab', res4.labourAdded, 4);
  eq('4-week list: all 4 weeks land in Summary', res4.summaryAdded, 4);
  eq('4-week list reads the external source exactly once, not once per week',
    src4.getDataRangeCallCount(), 1);
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
 * Per-source staleness thresholds (phase-end review round 9): the orderapp
 * fail-open counter only fires INSIDE a running handler, so a deleted /
 * disabled / never-installed trigger was invisible — heartbeats stamped but
 * unread. The weekly and monthly sources are now watched at cadence-fit
 * thresholds instead of being exempt from the 96h default.
 * ------------------------------------------------------------------ */
(function testStalenessPerSourceThresholds() {
  console.log('\nstaleness per-source thresholds:');

  const HOUR = 3600000;
  const OV = { shopify_orderapp: 168, greenbean: 168, recurring: 744 };

  // Weekly cadence, healthy week: last success Mon 05:00, checked the
  // following Sun 11:00 → ~150h. The 96h default would cry wolf here; the
  // 168h override stays silent.
  const mon5 = new Date('2026-07-27T05:00:00+10:00').getTime();      // Mon 05:00 Sydney
  const sun11 = new Date('2026-08-02T11:00:00+10:00').getTime();     // following Sun 11:00
  const nextMon11 = new Date('2026-08-03T11:00:00+10:00').getTime(); // following Mon 11:00
  eq('healthy-week worst case is ~150h', Math.round((sun11 - mon5) / HOUR), 150);
  const healthy = stalenessEvaluate_({ shopify_orderapp: mon5 }, ['shopify_orderapp'], sun11, 96, OV)[0];
  eq('weekly source at 150h is FRESH under its 168h override', healthy.stale, false);
  eq('the report entry carries its own threshold', healthy.thresholdHours, 168);

  // The review finding's scenario: the Monday trigger stops firing → the
  // same Monday's 11:00 check sees ~174h and alerts THAT day.
  eq('a missed weekly run reads ~174h at the next check', Math.round((nextMon11 - mon5) / HOUR), 174);
  eq('a weekly trigger that stopped firing alerts the day its run was missed',
    stalenessEvaluate_({ shopify_orderapp: mon5 }, ['shopify_orderapp'], nextMon11, 96, OV)[0].stale, true);

  // Un-overridden sources keep the default, and the 4-arg pure form
  // (no overrides) is unchanged.
  const plain = stalenessEvaluate_({ square: mon5 }, ['square'], nextMon11, 96, OV)[0];
  eq('un-overridden source still judged at the 96h default', plain.stale, true);
  eq('un-overridden entry carries the default threshold', plain.thresholdHours, 96);
  eq('overrides omitted → default applies to every source',
    stalenessEvaluate_({ shopify_orderapp: mon5 }, ['shopify_orderapp'], nextMon11, 96)[0].stale, true);

  // recurring (monthly, 1st 05:00, 744h = 31 days): a 31-day month's last
  // healthy check (~726h) is silent; a missed 1st-of-month run (~750h) alerts.
  const jul1 = new Date('2026-07-01T05:00:00+10:00').getTime();
  const jul31Check = new Date('2026-07-31T11:00:00+10:00').getTime();
  const aug1Check = new Date('2026-08-01T11:00:00+10:00').getTime();
  eq('31-day month-end check is ~726h', Math.round((jul31Check - jul1) / HOUR), 726);
  eq('recurring at ~726h is FRESH under 744', stalenessEvaluate_({ recurring: jul1 }, ['recurring'], jul31Check, 96, OV)[0].stale, false);
  eq('recurring missed-run at ~750h is STALE', stalenessEvaluate_({ recurring: jul1 }, ['recurring'], aug1Check, 96, OV)[0].stale, true);

  // End to end through stalenessRun_: heartbeats exist for every source (the
  // triggers RAN once), then the greenbean trigger dies. Only greenbean goes
  // stale, and its event body names the 168h override, not the 96h default.
  calendarEvents = [];
  calendarFailMode = null;
  currentSS = makeSpreadsheet();
  scriptProps = {};
  for (const s of STALENESS_SOURCES) {
    scriptProps['LAST_INGEST_' + s] = new Date(nextMon11 - 1 * HOUR).toISOString();
  }
  scriptProps['LAST_INGEST_greenbean'] = new Date(nextMon11 - 200 * HOUR).toISOString();
  const res = stalenessRun_(nextMon11);
  eq('only the dead weekly source is stale', res.stale.map((e) => e.source), ['greenbean']);
  eq('one orange event raised for it', res.eventsCreated, 1);
  check('event body names the 168h threshold, not the 96h default',
    calendarEvents[0]._description.indexOf('threshold 168h') !== -1);
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
      res, { rowsAdded: 0, rowsUpdated: 1, duplicatesSkipped: 0,
        updates: [{ key: rowKey_(second, SALES_KEY_COLS), from: 100, to: 150 }] });
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
 * Step 1 — upsertRows_ reports which rows it actually rewrote
 *
 * PRD-12: the correction alert must be driven by what upsertRows_ actually
 * wrote, not a week-age heuristic — the heuristic was blind to a genuine
 * correction on the newest week and would have false-alerted on labour and
 * other directly-written rows.
 * ------------------------------------------------------------------ */

(function testUpsertRowsReportsUpdates() {
  console.log('\nupsertRows_ — updates report:');

  freshSheets();
  var sheet = currentSS.getSheetByName('Sales');

  // Seed one existing row (amount 100), then, in a single batch: rewrite it
  // (real update), and add a brand-new row — so `updates` can't accidentally
  // pick up the new-row case too.
  var seed = normalizeSalesRow_('2026-07-01', 'York', 100, 'square', 'T0', 'Cafe');
  upsertRows_(sheet, [seed], SALES_KEY_COLS, 2, 4);

  var changed = normalizeSalesRow_('2026-07-01', 'York', 150, 'square', 'T1', 'Cafe');
  var freshRow = normalizeSalesRow_('2026-07-02', 'Pitt', 50, 'square', 'T1', 'Cafe');
  var res = upsertRows_(sheet, [changed, freshRow], SALES_KEY_COLS, 2, 4);

  eq('changed row → rowsUpdated 1', res.rowsUpdated, 1);
  eq('new row → rowsAdded 1', res.rowsAdded, 1);
  eq('nothing skipped in this batch', res.duplicatesSkipped, 0);
  eq('updates reports exactly the one rewritten row', (res.updates || []).length, 1);
  eq('updates entry carries key/from/to for the rewritten row',
    (res.updates || [])[0], { key: rowKey_(changed, SALES_KEY_COLS), from: 100, to: 150 });
  check('the brand-new row is NOT in updates',
    !(res.updates || []).some((u) => u.key === rowKey_(freshRow, SALES_KEY_COLS)));

  // Unchanged-amount re-post: duplicatesSkipped, NOT updates.
  var again = normalizeSalesRow_('2026-07-01', 'York', 150, 'square', 'T2', 'Cafe');
  var noop = upsertRows_(sheet, [again], SALES_KEY_COLS, 2, 4);
  eq('unchanged amount → duplicatesSkipped 1', noop.duplicatesSkipped, 1);
  eq('unchanged amount → rowsUpdated 0', noop.rowsUpdated, 0);
  eq('unchanged amount → updates is empty', noop.updates, []);

  // Brand-new row alone: rowsAdded, NOT updates.
  var onlyNew = normalizeSalesRow_('2026-07-03', 'North', 30, 'square', 'T1', 'Cafe');
  var addOnly = upsertRows_(sheet, [onlyNew], SALES_KEY_COLS, 2, 4);
  eq('brand-new row → rowsAdded 1', addOnly.rowsAdded, 1);
  eq('brand-new row → updates is empty', addOnly.updates, []);

  // Regression: every pre-existing scenario keeps its exact rowsAdded /
  // rowsUpdated / duplicatesSkipped values now that `updates` exists —
  // the fields, positions and meaning documented in Code.gs:607 are
  // unaffected for the other four callers of upsertRows_.
  freshSheets();
  (function () {
    var s2 = currentSS.getSheetByName('Sales');
    var first = normalizeSalesRow_('2026-07-01', 'York', 100, 'square', 'T1', 'Cafe');
    upsertRows_(s2, [first], SALES_KEY_COLS, 2, 4);
    var second = normalizeSalesRow_('2026-07-01', 'York', 150, 'square', 'T2', 'Cafe');
    var r2 = upsertRows_(s2, [second], SALES_KEY_COLS, 2, 4);
    eq('regression: rowsAdded unaffected by the updates addition', r2.rowsAdded, 0);
    eq('regression: rowsUpdated unaffected by the updates addition', r2.rowsUpdated, 1);
    eq('regression: duplicatesSkipped unaffected by the updates addition', r2.duplicatesSkipped, 0);
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

  // 14: end-to-end — online is pull-owned (PRD-10): a week of residual online
  // Revenue rows yields ZERO derived Summary rows, and doGet serves nothing
  // for that week until the shopifyWeeklyPull row lands (which the shopify
  // suite covers). Deriving a row here would double-count beside the pull row.
  (function () {
    currentSS = makeSpreadsheet();
    scriptProps = { API_READ_TOKEN: 'tok' };
    var rev = ensureSheet(currentSS, 'Revenue', REVENUE_HEADERS);
    rev.appendRow(['2026-06-16', 'Roastery', 'online', '#1041', 62, 'E-1', 'shopify', 'x']);
    rev.appendRow(['2026-06-17', 'Roastery', 'online', '#1042', 48.5, 'E-2', 'shopify', 'x']);
    rev.appendRow(['2026-06-18', 'Roastery', 'online', 'Sarah Chen', 120, 'E-3', 'shopify', 'x']);

    var res = weeklySummarize('2026-06-15');
    eq('a week of residual online orders → NO derived Summary row', res.summariesAdded, 0);

    var served = JSON.parse(doGet({ parameter: {
      token: 'tok', from: '2026-06-15', to: '2026-06-21', department: 'Roastery'
    } }).getContent());
    eq('doGet serves nothing for the week (pull row not yet landed)', served.count, 0);
  })();

  // 12: idempotency — the revenue grouping key must be stable across runs, or
  // a re-summarize would append a second row instead of upserting. (Wholesale
  // fixture: online no longer derives Summary rows at all.)
  (function () {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    var rev = ensureSheet(currentSS, 'Revenue', REVENUE_HEADERS);
    rev.appendRow(['2026-06-16', 'Roastery', 'wholesale', 'Idem Cafe', 62, 'I-1', 'coffee_order_app', 'x']);

    var first = weeklySummarize('2026-06-15');
    eq('first summarize adds the wholesale revenue row', first.summariesAdded, 1);
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
    eq('amended wholesale revenue updates in place', third.summariesUpdated, 1);
    eq('...and still appends nothing', third.summariesAdded, 0);
    var amended = currentSS.getSheetByName('Summary').getDataRange().getValues();
    eq('Summary row count still unchanged', amended.length, before.length);
    eq('Summary total reflects the amendment', amended[1][4], 99);
  })();

  // 13: legacy customer-keyed online Summary rows are ORPHANED, never updated
  // and never re-derived — documents WHY the cleanup runbook (apply + backup)
  // exists: only the cleanup removes them; a summarize run leaves the stale 62
  // sitting there while deriving nothing new online.
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
    eq('legacy row is orphaned in place, nothing new derived (1 row)', revenueRows.length, 1);
    eq('...the stale figure persists until the cleanup removes it', revenueRows[0][4], 62);
  })();

  // Case-variant channels in ONE week now SUM correctly (non-online).
  // aggregateSupplierRows_ groups on the SAME .trim().toLowerCase()
  // normalization rowKey_ uses (REVIEW FIXES 2026-08-26, FIX 2), so
  // 'wholesale' and 'Wholesale' collapse into ONE aggregation group before
  // Summary is even written — no split-then-silently-dropped-duplicate.
  // FORMERLY: two raw-string groups collapsed onto the same Summary key and
  // upsertRows_ discarded the second as a duplicate — 100 + 25 reported as
  // 25, not 125. Recorded in TODO.md. (Online variants are excluded outright,
  // so this only ever applied to non-online channels.)
  (function () {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    var rev = ensureSheet(currentSS, 'Revenue', REVENUE_HEADERS);
    rev.appendRow(['2026-06-16', 'Roastery', 'wholesale', 'Case Cafe', 100, 'V-1', 'coffee_order_app', 'x']);
    rev.appendRow(['2026-06-17', 'Roastery', 'Wholesale', 'Case Cafe', 25, 'V-2', 'coffee_order_app', 'x']);

    weeklySummarize('2026-06-15');
    var revRows = currentSS.getSheetByName('Summary').getDataRange().getValues()
      .slice(1).filter(function (r) { return r[7] === 'revenue'; });
    eq('mixed channel casing collapses to ONE Summary row', revRows.length, 1);
    eq('...and both are summed: reports the full 125, not 25', revRows[0][4], 125);
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
 * Round 9 closed the cadence loophole: 'recurring', 'shopify_orderapp' and
 * 'greenbean' were exempt because the 96h default would cry wolf on their
 * weekly/monthly cadence — which left a deleted or never-installed trigger
 * invisible (the fail-open counter only fires inside a running handler).
 * They are now watched at per-source thresholds. The one remaining exemption
 * must name a REAL alternative watchdog, not just a cadence excuse.
 */
(function testEveryHeartbeatSourceIsWatched() {
  console.log('\nstaleness — every heartbeat source is watched:');

  var STAMPS_HEARTBEAT = ['square', 'mayers', 'roastery', 'recurring', 'shopspend', 'shopify_orderapp', 'greenbean'];
  var EXEMPT = {
    shopspend: 'has its own dedicated weekly watchdog trigger (shopSpendWatchdog, Mon 14:00) reading ShopSpendPulls'
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

  // --- Per-source thresholds: a watched source whose cadence exceeds the
  // 96h default MUST carry an override, or re-adding it just trades
  // "unwatched" for "cries wolf daily"; and an override for an unwatched
  // source is dead config. ---
  eq("shopify_orderapp override = weekly cadence (168h)", STALENESS_THRESHOLD_OVERRIDES.shopify_orderapp, 168);
  eq("greenbean override = weekly cadence (168h)", STALENESS_THRESHOLD_OVERRIDES.greenbean, 168);
  eq("recurring override = 31 days (744h)", STALENESS_THRESHOLD_OVERRIDES.recurring, 744);
  check('every override belongs to a watched source (no dead config)',
    Object.keys(STALENESS_THRESHOLD_OVERRIDES).every(function (s) {
      return STALENESS_SOURCES.indexOf(s) !== -1;
    }));

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
  check('shopspend is NOT in STALENESS_SOURCES (its own shopSpendWatchdog trigger covers it; both would double-alert)',
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

// Pinned suite-wide: weeks4 is derived from PINNED_TODAY below, and every
// shopifyWeeklyPull_impl_ call must request that SAME 4-week set. Cases 1/2
// re-pin to distinct instants inside for their stamp assertions.
withMockNow('2026-08-06T00:00:00Z', function testShopifyWeeklyPull() {
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

  // todayStr_ is now mock-observable (Code.gs: new Date(Date.now())), so the
  // 4 requested weeks must be derived from the SAME date every withMockNow
  // block below pins — not from the real clock. All three pinned instants
  // (2026-08-06, 2026-08-07) fall in the week of Mon 2026-08-03, so they
  // resolve to one identical 4-week set.
  const PINNED_TODAY = '2026-08-06';
  const weeks4 = lastCompletedWeeks_(PINNED_TODAY, 4);

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

  /* --- case 5: online is PULL-OWNED — weeklySummarize must derive NO online
   *     Summary row at all from residual channel='online' Revenue rows (any
   *     source). A derived per-source row would sit BESIDE the pull-owned
   *     shopify_orderapp row (different key, both served by doGet) and the
   *     week would double-count. Non-online channels are untouched. ---
   */
  reset();
  withMockNow('2026-08-06T00:00:00Z', function () {
    var revSheet = ensureSheet(currentSS, 'Revenue', REVENUE_HEADERS);
    revSheet.appendRow(['2026-07-28', 'Roastery', 'online', 'guest', 100, 'ord-1', 'shopify', 'TS']);
    revSheet.appendRow(['2026-07-28', 'Roastery', 'Online', 'guest', 100, 'ord-2', 'coffee_order_app', 'TS']);
    revSheet.appendRow(['2026-07-28', 'Roastery', 'wholesale', 'Cafe X', 340, 'ord-3', 'coffee_order_app', 'TS']);
    currentSS._sheets['Revenue'] = revSheet;
    clearLoggedMessages();
    weeklySummarize('2026-07-28');
  });
  var rows5 = summaryRows();
  check('case5: NO online Summary row is derived from Revenue (any source, any casing)',
    rows5.slice(1).every((r) => String(r[3]).trim().toLowerCase() !== 'online'));
  check('case5: wholesale revenue still summarizes per customer',
    rows5.slice(1).some((r) => r[2] === 'Cafe X' && r[4] === 340));
  check('case5: weeklySummarize NEVER writes a Summary row keyed supplier=shopify_orderapp',
    rows5.slice(1).every((r) => r[2] !== SHOPIFY_SUPPLIER));
  check('case5: the exclusion is logged with count + dollars',
    lastLoggedMessages().some((m) => m.indexOf('excluded 2 historical channel=online') !== -1 && m.indexOf('$200') !== -1));

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

  /* --- case 10: shape validation — malformed {ok:true} bodies must not throw
   *     out of a trigger, must not write NaN money, and a weekStart that does
   *     not echo the requested week (API ignored/clamped the param) must not
   *     write one week four times. --- */
  reset();
  var weeks10 = lastCompletedWeeks_(todayStr_(), SHOPIFY_REPULL_WEEKS);
  var bodies10 = {};
  weeks10.forEach((w, i) => { bodies10[w.label] = weekBody(w, 300 + i, 2); });
  delete bodies10[weeks10[0].label].summary;                       // missing summary
  bodies10[weeks10[1].label].summary.grossSales = 'not-a-number';  // NaN money
  bodies10[weeks10[2].label].meta.weekStart =                      // clamped week
    weeks10[3].start + 'T00:00:00+10:00';
  armShopifyFetch(bodies10);
  var thrown10 = false;
  var res10;
  try { res10 = shopifyWeeklyPull_impl_(); } catch (err) { thrown10 = true; }
  check('case10: malformed bodies never throw out of the pull', !thrown10);
  eq('case10: only the one well-shaped week is written', res10.rowsAdded, 1);
  check('case10: run marked apiFailed (no heartbeat)', res10.apiFailed === true);
  check('case10: heartbeat NOT stamped', !(('LAST_INGEST_' + SHOPIFY_SUPPLIER) in scriptProps));
  var rows10 = currentSS.getSheetByName('Summary').getDataRange().getValues();
  eq('case10: exactly one data row landed', rows10.length, 2);
  check('case10: no NaN total anywhere', rows10.slice(1).every((r) => isFinite(Number(r[4]))));
  check('case10: each rejection is logged with its reason',
    lastLoggedMessages().filter((m) => m.indexOf('shape validation') !== -1).length === 3);
  check('case10: the clamped-week rejection names the echo mismatch',
    lastLoggedMessages().some((m) => m.indexOf('does not echo') !== -1));

  global.UrlFetchApp = REAL_URL_FETCH;
});

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

  // --- case: invoiceNum casing drift WITHIN one invoice ('INV-700' +
  //     'inv-700') must group as ONE invoice with the full sum. Case-sensitive
  //     grouping would emit two rows whose refs collapse to one dedup key at
  //     the sheet (rowKey_ lowercases) and the second row's money would
  //     silently vanish as an in-batch duplicate. Ref keeps first-seen casing.
  const caseDrift = greenBeanInvoices_([
    { dateLocal: '2026-06-10', supplierRaw: 'ACME Beans', supplierKey: 'acme_beans', invoiceNum: 'INV-700', totalCostIncGst: 500, status: 'RECEIVED' },
    { dateLocal: '2026-06-11', supplierRaw: 'ACME Beans', supplierKey: 'acme_beans', invoiceNum: 'inv-700', totalCostIncGst: 300, status: 'RECEIVED' }
  ]);
  eq('casing-drifted invoiceNum: ONE row, full sum, first-seen casing', caseDrift, [
    { date: '2026-06-10', supplier: 'ACME Beans', total: 800, invoice_ref: 'acme_beans/INV-700', department: 'Roastery' }
  ]);

  // --- case: money accumulation coerces like every other money read — a
  //     string-typed totalCostIncGst must SUM, never concatenate (0+'50' ->
  //     '050' -> a 100x-overstated invoice); undefined counts as 0 ---
  const caseCoerce = greenBeanInvoices_([
    { dateLocal: '2026-06-20', supplierRaw: 'Str Co', supplierKey: 'str_co', invoiceNum: 'S-1', totalCostIncGst: '50', status: 'RECEIVED' },
    { dateLocal: '2026-06-21', supplierRaw: 'Str Co', supplierKey: 'str_co', invoiceNum: 'S-1', totalCostIncGst: '25.5', status: 'RECEIVED' },
    { dateLocal: '2026-06-22', supplierRaw: 'Str Co', supplierKey: 'str_co', invoiceNum: 'S-1', totalCostIncGst: undefined, status: 'RECEIVED' }
  ]);
  eq('string/undefined totals sum numerically, never concatenate', caseCoerce, [
    { date: '2026-06-20', supplier: 'Str Co', total: 75.5, invoice_ref: 'str_co/S-1', department: 'Roastery' }
  ]);

  // --- case: BLANK_SUPPLIER fallback — a blank supplierRaw gets one explicit
  //     self-describing name, not the source token 'greenbean' in one column
  //     and 'unknown/...' in another ---
  const caseBlankSupplier = greenBeanInvoices_([
    { dateLocal: '2026-06-20', supplierRaw: '', supplierKey: 'unknown', invoiceNum: 'B-9', totalCostIncGst: 30, status: 'RECEIVED', flags: ['BLANK_SUPPLIER'] }
  ]);
  eq('blank supplierRaw -> explicit fallback name', caseBlankSupplier[0].supplier, 'Green Bean (unnamed supplier)');

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

  /* --- case: AMBIGUOUS rowsIncluded — truncated:true with rowsIncluded
   *     absent/non-boolean must abort too, not fall through both branches
   *     and silently ingest a partial window as complete. --- */
  reset();
  global.UrlFetchApp = {
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, meta: { paging: { truncated: true, returned: 100 } }, rows: [] })
    }),
  };
  check('ambiguous rowsIncluded (absent) on a truncated page: returns null',
    greenBeanFetchAllRows_() === null);

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
  eq('the fetch itself raises no alert (the impl owns the signature-gated alert)', calendarEvents.length, 0);

  /* --- case: non-advancing page — truncated:true with returned:0 (or a
   *     renamed/absent field) must abort, not re-issue the identical fetch
   *     until the 6-minute limit. --- */
  reset();
  let stuckFetches = 0;
  global.UrlFetchApp = {
    fetch: () => {
      stuckFetches++;
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, meta: { paging: { truncated: true, rowsIncluded: true, returned: 0 } }, rows: [] })
      };
    },
  };
  check('non-advancing page (returned:0): returns null', greenBeanFetchAllRows_() === null);
  eq('non-advancing page: aborts after ONE fetch, no infinite loop', stuckFetches, 1);
  check('non-advancing page: the abort is logged',
    lastLoggedMessages().some((m) => /cannot advance/i.test(m)));

  reset();
  global.UrlFetchApp = {
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, meta: { paging: { truncated: true, rowsIncluded: true } }, rows: [] })
    }),
  };
  check('absent paging.returned on a truncated page: returns null (NaN offset guard)',
    greenBeanFetchAllRows_() === null);

  /* --- case: page cap — a paging bug that advances but never terminates is
   *     cut off at GREENBEAN_MAX_PAGES. --- */
  reset();
  let cappedFetches = 0;
  global.UrlFetchApp = {
    fetch: () => {
      cappedFetches++;
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          ok: true,
          meta: { paging: { truncated: true, rowsIncluded: true, returned: 1 } },
          rows: [{ rowNumber: 1000 + cappedFetches, dateLocal: '2026-06-01', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 1, status: 'RECEIVED' }]
        })
      };
    },
  };
  check('runaway paging: returns null at the page cap', greenBeanFetchAllRows_() === null);
  eq('runaway paging: fetch count capped at GREENBEAN_MAX_PAGES', cappedFetches, GREENBEAN_MAX_PAGES);

  /* --- case: shape gate — an {ok:true} body missing meta/meta.paging must
   *     abort cleanly (null), never TypeError out of the Tuesday trigger.
   *     Same contract as shopifyValidWeekBody_ on the shopify side. --- */
  reset();
  global.UrlFetchApp = {
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, rows: [] }) // no meta at all
    }),
  };
  let shapeThrew = false;
  let shapeRes;
  try { shapeRes = greenBeanFetchAllRows_(); } catch (err) { shapeThrew = true; }
  check('missing meta.paging: does not throw', !shapeThrew);
  check('missing meta.paging: returns null (abort, no ingest)', shapeRes === null);
  check('missing meta.paging: the abort is logged as shape validation',
    lastLoggedMessages().some((m) => m.indexOf('missing meta.paging') !== -1));

  /* --- case: row DELETED mid-pagination — the offset window slides forward
   *     and a row is never returned; paging.matched exposes the shortfall,
   *     which must abort rather than silently ingest a short window. --- */
  reset();
  global.UrlFetchApp = {
    fetch: (url) => {
      const m = /[?&]offset=([^&]+)/.exec(String(url));
      const offset = m ? Number(decodeURIComponent(m[1])) : 0;
      const page = offset === 0
        ? [{ rowNumber: 1, dateLocal: '2026-06-01', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 1, status: 'RECEIVED' },
           { rowNumber: 2, dateLocal: '2026-06-02', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 2, status: 'RECEIVED' }]
        : [{ rowNumber: 4, dateLocal: '2026-06-04', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 4, status: 'RECEIVED' }];
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, meta: { paging: { truncated: offset === 0, rowsIncluded: true, returned: page.length, matched: 4 } }, rows: page })
      };
    },
  };
  check('deletion shortfall (3 collected vs matched=4): returns null', greenBeanFetchAllRows_() === null);
  check('deletion shortfall: the abort is logged',
    lastLoggedMessages().some((m) => m.indexOf('paging.matched') !== -1));

  /* --- case: identical upstream warning repeated on every page is collected
   *     ONCE (the producer recomputes it over the whole matched set) --- */
  reset();
  global.UrlFetchApp = {
    fetch: (url) => {
      const m = /[?&]offset=([^&]+)/.exec(String(url));
      const offset = m ? Number(decodeURIComponent(m[1])) : 0;
      const page = offset === 0
        ? [{ rowNumber: 1, dateLocal: '2026-06-01', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 1, status: 'RECEIVED' }]
        : [{ rowNumber: 2, dateLocal: '2026-06-02', supplierRaw: 'A', supplierKey: 'a', invoiceNum: 'A-1', totalCostIncGst: 2, status: 'RECEIVED' }];
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          ok: true,
          meta: { paging: { truncated: offset === 0, rowsIncluded: true, returned: 1, matched: 2 } },
          diagnostics: { warnings: ['same warning on every page'] },
          rows: page
        })
      };
    },
  };
  greenBeanFetchAllRows_();
  eq('repeated per-page warning collected once (dedup keeps signature stable)',
    lastLoggedMessages().filter((m) => m.indexOf('same warning on every page') !== -1).length, 1);

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

  /* --- Run 3: a changed invoice that gains an EARLIER line — its computed
   *     date genuinely moves, so the date-move self-heal updates the sheet
   *     row's date and resummarizes BOTH the old (stored) and new (computed)
   *     weeks; an unchanged invoice (contributes nothing), a brand-new
   *     invoice (its own computed week), and a CHANGED current-week invoice
   *     (ingested, but never resummarized/queued). --- */
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

  eq('run3: weeklySummarize called for {CHANGED-1 NEW week, NEW-1 week, CHANGED-1 OLD week}, oldest-first',
    weeklySummarizeCalls, [weeksAll[2].start, weeksAll[3].start, weeksAll[7].start]);
  check('run3: the unchanged invoice\'s week was never resummarized',
    weeklySummarizeCalls.indexOf(weeksAll[6].start) === -1);
  check('run3: the current week was never resummarized even though CUR-1 changed',
    weeklySummarizeCalls.indexOf(currentWeekStart) === -1);
  eq('run3: weeksResummarized', res3.weeksResummarized, 3);
  eq('run3: weeksQueued (nothing overflowed)', res3.weeksQueued, 0);
  eq('run3: queue property stays empty', queueProp(), []);
  check('run3: the current week was never queued either', queueProp().indexOf(currentWeekStart) === -1);

  const changedRow3 = findSupplierRow(suppliersRows(), 'changeco/CHANGED-1');
  check('run3: CHANGED-1 row exists', !!changedRow3);
  if (changedRow3) {
    eq('run3: CHANGED-1 total updated in place to the new summed value', Number(changedRow3[2]), 150);
    eq('run3: CHANGED-1 date column self-healed to the NEW computed date (the invoice moved weeks)',
      cellDate(changedRow3[0]), weeksAll[2].start);
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
    calendarEvents[0]._title.indexOf('data quality: greenbean_flags') !== -1 &&
    calendarEvents[0]._description.indexOf('UNDERSTATED') !== -1);

  /* --- signature suppression: the same unfixed cell sits in the rolling
   *     window ~13 weekly runs; only the FIRST (and any CHANGED) condition
   *     alerts, and a clean run re-arms the next occurrence. --- */
  greenBeanPull_impl_(); // identical condition, second run
  eq('unchanged condition: still exactly one alert', calendarEvents.length, 1);
  check('the suppression is logged',
    lastLoggedMessages().some((m) => m.indexOf('alert suppressed') !== -1));

  global.UrlFetchApp = { // condition CHANGES: a second flagged row appears
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        ok: true,
        meta: { paging: { truncated: false, rowsIncluded: true, returned: 3 } },
        rows: [
          { rowNumber: 2, dateLocal: today, supplierRaw: 'Flag Co', supplierKey: 'flag_co', invoiceNum: 'F-1', totalCostIncGst: 0, status: 'RECEIVED', flags: ['NON_NUMERIC_PRICE_KG'] },
          { rowNumber: 4, dateLocal: today, supplierRaw: 'Flag Co', supplierKey: 'flag_co', invoiceNum: 'F-2', totalCostIncGst: 0, status: 'RECEIVED', flags: ['NON_NUMERIC_TOTAL_KG'] },
          { rowNumber: 3, dateLocal: today, supplierRaw: 'Fine Co', supplierKey: 'fine_co', invoiceNum: 'OK-1', totalCostIncGst: 42, status: 'RECEIVED' }
        ]
      })
    }),
  };
  greenBeanPull_impl_();
  eq('changed condition (1 -> 2 flags): a second alert fires', calendarEvents.length, 2);

  global.UrlFetchApp = { // clean run: flags fixed
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        ok: true,
        meta: { paging: { truncated: false, rowsIncluded: true, returned: 1 } },
        rows: [{ rowNumber: 3, dateLocal: today, supplierRaw: 'Fine Co', supplierKey: 'fine_co', invoiceNum: 'OK-1', totalCostIncGst: 42, status: 'RECEIVED' }]
      })
    }),
  };
  greenBeanPull_impl_();
  eq('clean run: no new alert', calendarEvents.length, 2);
  check('clean run: signature cleared, next occurrence re-arms',
    !('ORDERAPP_DQ_SIG_greenbean_flags' in scriptProps));

  /* --- flag bucketing: the alert names the DISTINCT flags present, so a
   *     BLANK_SUPPLIER row is not misdiagnosed as a price-cell problem; the
   *     signature carries the flag names too (new flag type at equal count
   *     must re-alert). --- */
  global.UrlFetchApp = {
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        ok: true,
        meta: { paging: { truncated: false, rowsIncluded: true, returned: 3 } },
        rows: [
          { rowNumber: 5, dateLocal: today, supplierRaw: '', supplierKey: 'unknown', invoiceNum: 'B-1', totalCostIncGst: 30, status: 'RECEIVED', flags: ['BLANK_SUPPLIER'] },
          { rowNumber: 6, dateLocal: today, supplierRaw: 'Flag Co', supplierKey: 'flag_co', invoiceNum: 'F-3', totalCostIncGst: 0, status: 'RECEIVED', flags: ['NON_NUMERIC_PRICE_KG'] },
          // OK-1 stays in the feed: dropping a previously-ingested in-window
          // row would (correctly) trip the round-9 orphan alert and shadow
          // the flags alert this test asserts on.
          { rowNumber: 3, dateLocal: today, supplierRaw: 'Fine Co', supplierKey: 'fine_co', invoiceNum: 'OK-1', totalCostIncGst: 42, status: 'RECEIVED' }
        ]
      })
    }),
  };
  greenBeanPull_impl_();
  const flagAlert = calendarEvents[calendarEvents.length - 1];
  check('flag bucketing: alert names BLANK_SUPPLIER and NON_NUMERIC_PRICE_KG',
    flagAlert._description.indexOf('BLANK_SUPPLIER') !== -1 &&
    flagAlert._description.indexOf('NON_NUMERIC_PRICE_KG') !== -1);
  check('flag bucketing: signature carries the flag names',
    String(scriptProps.ORDERAPP_DQ_SIG_greenbean_flags).indexOf('BLANK_SUPPLIER') !== -1);

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
  eq('date also moved -> BOTH weeks resummarized (self-heal), oldest first — the point is the snapshot HIT, not an append',
    casingCalls, [weeks[0].start, weeks[5].start]);
  global.weeklySummarize = REAL_WEEKLY_SUMMARIZE;

  /* --- snapshot trim parity with rowKey_: a hand-edited Suppliers row whose
   *     invoice_ref carries surrounding whitespace is still HIT by the
   *     snapshot lookup (upsertRows_ trims too), so a changed invoice
   *     classifies as an update of the stored week, never as new. --- */
  reset();
  {
    const supp = currentSS.insertSheet('Suppliers');
    supp.appendRow(SUPPLIERS_HEADERS);
    supp.appendRow([weeks[0].start, 'Trim Co', 100, '  trim_co/T-1  ', '', 'greenbean', 'TS', 'Roastery']);
  }
  armFetch([{ rowNumber: 1, dateLocal: weeks[5].start, supplierRaw: 'Trim Co', supplierKey: 'trim_co', invoiceNum: 'T-1', totalCostIncGst: 150, status: 'RECEIVED' }]);
  let trimCalls = [];
  global.weeklySummarize = function (w) { trimCalls.push(w); return REAL_WEEKLY_SUMMARIZE(w); };
  const trimRes = greenBeanPull_impl_();
  eq('padded stored ref: classifies as update, not new', trimRes.rowsUpdated, 1);
  eq('padded stored ref: date also moved -> BOTH weeks resummarized (snapshot HIT proven, no append)',
    trimCalls, [weeks[0].start, weeks[5].start]);
  global.weeklySummarize = REAL_WEEKLY_SUMMARIZE;

  /* --- supplier rename surfaces as an ORPHAN (round 9 generalized the
   *     rename detector): the old ref is in-window but not re-submitted, so
   *     it alerts naming the stale ref, the rename hint names the new ref
   *     (same bare invoiceNum among this pull's NEW refs), and the runbook is
   *     attached; two suppliers legitimately sharing an invoiceNum in the
   *     SAME pull must NOT trip it. --- */
  reset();
  armFetch([{ rowNumber: 1, dateLocal: weeks[0].start, supplierRaw: 'Old Co', supplierKey: 'old_co', invoiceNum: 'R-9', totalCostIncGst: 100, status: 'RECEIVED' }]);
  greenBeanPull_impl_(); // seeds old_co/R-9
  calendarEvents = [];
  armFetch([{ rowNumber: 1, dateLocal: weeks[0].start, supplierRaw: 'Old Co.', supplierKey: 'old_co_2', invoiceNum: 'R-9', totalCostIncGst: 100, status: 'RECEIVED' }]);
  greenBeanPull_impl_();
  eq('rename: one data-quality alert raised', calendarEvents.length, 1);
  check('orphan alert names the stale old ref, hints the new ref, carries the runbook',
    calendarEvents[0]._description.indexOf('old_co/r-9') !== -1 &&
    calendarEvents[0]._description.indexOf('old_co_2/R-9') !== -1 &&
    calendarEvents[0]._description.indexOf('weeklySummarize') !== -1);

  reset();
  armFetch([
    { rowNumber: 1, dateLocal: weeks[0].start, supplierRaw: 'Share A', supplierKey: 'share_a', invoiceNum: 'INV-77', totalCostIncGst: 10, status: 'RECEIVED' },
    { rowNumber: 2, dateLocal: weeks[0].start, supplierRaw: 'Share B', supplierKey: 'share_b', invoiceNum: 'INV-77', totalCostIncGst: 20, status: 'RECEIVED' }
  ]);
  greenBeanPull_impl_(); // both keys seeded together
  calendarEvents = [];
  greenBeanPull_impl_(); // re-pull, both suppliers still present
  eq('legit shared invoiceNum across suppliers: no rename alert', calendarEvents.length, 0);

  /* --- PARTIAL rename: one invoice moves to the new spelling while another
   *     still carries the old key. The old KEY stays in the pull but the old
   *     REF is unsubmitted — this must alert (round-8 CRITICAL: it silently
   *     double-counted; the round-9 orphan sweep keys on the absent REF, so
   *     it covers this case by construction). --- */
  reset();
  armFetch([
    { rowNumber: 1, dateLocal: weeks[0].start, supplierRaw: 'Acme', supplierKey: 'acme', invoiceNum: 'INV-700', totalCostIncGst: 500, status: 'RECEIVED' },
    { rowNumber: 2, dateLocal: weeks[0].start, supplierRaw: 'Acme', supplierKey: 'acme', invoiceNum: 'INV-701', totalCostIncGst: 100, status: 'RECEIVED' }
  ]);
  greenBeanPull_impl_(); // seeds acme/INV-700 + acme/INV-701
  calendarEvents = [];
  armFetch([
    { rowNumber: 1, dateLocal: weeks[0].start, supplierRaw: 'Acme Coffee Co', supplierKey: 'acme coffee co', invoiceNum: 'INV-700', totalCostIncGst: 500, status: 'RECEIVED' },
    { rowNumber: 2, dateLocal: weeks[0].start, supplierRaw: 'Acme', supplierKey: 'acme', invoiceNum: 'INV-701', totalCostIncGst: 100, status: 'RECEIVED' }
  ]);
  greenBeanPull_impl_();
  eq('PARTIAL rename: alert fires even though the old key is still in the pull',
    calendarEvents.length, 1);
  check('partial-rename alert names the moved ref',
    calendarEvents[0]._description.indexOf('acme/inv-700') !== -1 &&
    calendarEvents[0]._description.indexOf('acme coffee co/INV-700') !== -1);

  /* --- date-move self-heal: same ref, same total, moved date — the Suppliers
   *     row's date cell is updated in place and BOTH weeks resummarize
   *     (round-8 important: previously the money stayed in the wrong ISO week
   *     forever with no signal). --- */
  reset();
  armFetch([{ rowNumber: 1, dateLocal: weeks[5].start, supplierRaw: 'Move Co', supplierKey: 'move_co', invoiceNum: 'M-1', totalCostIncGst: 250, status: 'RECEIVED' }]);
  greenBeanPull_impl_(); // seeds at weeks[5]
  clearLoggedMessages();
  armFetch([{ rowNumber: 1, dateLocal: weeks[1].start, supplierRaw: 'Move Co', supplierKey: 'move_co', invoiceNum: 'M-1', totalCostIncGst: 250, status: 'RECEIVED' }]);
  let moveCalls = [];
  global.weeklySummarize = function (w) { moveCalls.push(w); return REAL_WEEKLY_SUMMARIZE(w); };
  const moveRes = greenBeanPull_impl_();
  global.weeklySummarize = REAL_WEEKLY_SUMMARIZE;
  eq('date move: nothing added (same ref)', moveRes.rowsAdded, 0);
  const movedRow = currentSS.getSheetByName('Suppliers').getDataRange().getValues()
    .slice(1).filter((r) => String(r[3]) === 'move_co/M-1')[0];
  eq('date move: the Suppliers date cell now carries the NEW date',
    cellDate(movedRow[0]), weeks[1].start);
  eq('date move: BOTH weeks resummarized, oldest first',
    moveCalls, [weeks[1].start, weeks[5].start]);
  check('date move: the self-heal is logged',
    lastLoggedMessages().some((m) => m.indexOf('date moved') !== -1 && m.indexOf('move_co/M-1') !== -1));

  /* --- orphan detection is WINDOW-BOUNDED: a quiet supplier's OLD row
   *     (storedDate before the 3-month window) is legitimately absent from
   *     the pull and must NOT false-positive — the runbook it points at
   *     would zero real historical spend. --- */
  reset();
  {
    const supp = currentSS.insertSheet('Suppliers');
    supp.appendRow(SUPPLIERS_HEADERS);
    // historical row well before greenBeanWindow_ (month-2 start)
    supp.appendRow(['2025-01-15', 'Quiet Co', 77, 'quiet_co/1001', '', 'greenbean', 'TS', 'Roastery']);
  }
  armFetch([{ rowNumber: 1, dateLocal: weeks[0].start, supplierRaw: 'New Co', supplierKey: 'new_co', invoiceNum: '1001', totalCostIncGst: 50, status: 'RECEIVED' }]);
  calendarEvents = [];
  greenBeanPull_impl_();
  eq('out-of-window prior holder: no rename alert', calendarEvents.length, 0);

  /* --- upstream signature hashes CONTENT: the same 1-element warnings array
   *     with changed text ("3 rows" -> "40 rows") must re-alert --- */
  reset();
  const warnFetch = (text) => ({
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        ok: true,
        meta: { paging: { truncated: false, rowsIncluded: true, returned: 0 } },
        diagnostics: { warnings: [text] },
        rows: []
      })
    }),
  });
  global.UrlFetchApp = warnFetch('3 green-bean row(s) were excluded by the date filter');
  greenBeanPull_impl_();
  eq('content-hash sig: first warning alerts', calendarEvents.length, 1);
  greenBeanPull_impl_();
  eq('content-hash sig: unchanged text suppressed', calendarEvents.length, 1);
  global.UrlFetchApp = warnFetch('40 green-bean row(s) were excluded by the date filter');
  greenBeanPull_impl_();
  eq('content-hash sig: same count, changed text -> re-alerts', calendarEvents.length, 2);

  /* --- abort path surfaces collected warnings instead of discarding them --- */
  reset();
  global.UrlFetchApp = {
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        ok: true,
        meta: { paging: { truncated: true, rowsIncluded: false, returned: 5000 } },
        diagnostics: { warnings: ['payload too large to include rows'] },
        rows: []
      })
    }),
  };
  calendarEvents = [];
  const abortRes = greenBeanPull_impl_();
  check('abort: apiFailed surfaced', abortRes.apiFailed === true);
  eq('abort: the collected warnings still raise the data-quality alert', calendarEvents.length, 1);
  check('abort alert says the run ABORTED and carries the warning text',
    calendarEvents[0]._description.indexOf('ABORTED') !== -1 &&
    calendarEvents[0]._description.indexOf('payload too large') !== -1);

  /* --- upstream warnings: impl raises ONE signature-gated alert, suppresses
   *     while unchanged, clears on a clean pull --- */
  reset();
  const warnBody = (warnings) => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      ok: true,
      meta: { paging: { truncated: false, rowsIncluded: true, returned: 0 } },
      diagnostics: warnings.length ? { warnings: warnings } : {},
      rows: []
    })
  });
  global.UrlFetchApp = { fetch: () => warnBody(['1 row hidden: invalid Timestamp']) };
  greenBeanPull_impl_();
  eq('upstream warning: one alert from the impl', calendarEvents.length, 1);
  check('upstream alert says spend may be incomplete', calendarEvents[0]._description.indexOf('incomplete') !== -1);
  greenBeanPull_impl_();
  eq('unchanged upstream warning: suppressed on the next pull', calendarEvents.length, 1);
  global.UrlFetchApp = { fetch: () => warnBody([]) };
  greenBeanPull_impl_();
  check('clean pull clears the upstream signature',
    !('ORDERAPP_DQ_SIG_greenbean_upstream' in scriptProps));

  /* --- zero-row full window: completes (no alert spam) but warns loudly --- */
  reset();
  armFetch([]);
  const zeroRes = greenBeanPull_impl_();
  eq('zero-row window: run completes', zeroRes.rowsFetched, 0);
  eq('zero-row window: no failure alert', calendarEvents.length, 0);
  check('zero-row window: loud WARNING logged',
    lastLoggedMessages().some((m) => m.indexOf('0 intake rows across the entire 3-month window') !== -1));

  /* --- refused resummarize stays queued: the queue is the sole record of
   *     pending weeks, so only a call that actually completed may remove its
   *     week — a {refused:...} return must survive to the next run. --- */
  reset();
  armFetch([
    { rowNumber: 1, dateLocal: weeks[0].start, supplierRaw: 'Q1', supplierKey: 'q1', invoiceNum: 'Q-1', totalCostIncGst: 10, status: 'RECEIVED' },
    { rowNumber: 2, dateLocal: weeks[1].start, supplierRaw: 'Q2', supplierKey: 'q2', invoiceNum: 'Q-2', totalCostIncGst: 20, status: 'RECEIVED' }
  ]);
  global.weeklySummarize = function (w) {
    if (w === weeks[0].start) return { refused: 'locked' };
    return REAL_WEEKLY_SUMMARIZE(w);
  };
  const refusedRes = greenBeanPull_impl_();
  eq('refused week: counted out of weeksResummarized', refusedRes.weeksResummarized, 1);
  eq('refused week: stays in the queue property', queueProp(), [weeks[0].start]);
  check('refused week: the refusal is logged',
    lastLoggedMessages().some((m) => m.indexOf('did not complete for ' + weeks[0].start) !== -1));

  global.UrlFetchApp = REAL_URL_FETCH;
  global.weeklySummarize = REAL_WEEKLY_SUMMARIZE;
})();

/* ------------------------------------------------------------------ *
 * orderapp: phase-end review round 9 — orphan detection + extracted_at
 * stamp on the date-move self-heal.
 *
 * The CRITICAL: blank-invoice lines mint invoice_ref = '<key>/noinv-<date>',
 * so the date is part of the dedup identity — a date correction upstream
 * mints a NEW ref. The ref-equality self-heal can never fire (no matching
 * ref arrives) and the old bare-number rename probe compared 'noinv-<old>'
 * vs 'noinv-<new>' and stayed silent too: the old row survived, the new row
 * appended, and weeklySummarize actively rewrote Summary to DOUBLE the true
 * spend with zero alerts. The orphan sweep keys on the only signal that
 * survives every identity change: an in-window snapshot ref this pull did
 * not re-submit.
 * ------------------------------------------------------------------ */
(function testGreenBeanRound9OrphanDetection() {
  console.log('\norderapp: round-9 fixes — orphaned rows / noinv date-move / extracted_at stamp:');

  const REAL_URL_FETCH = global.UrlFetchApp;

  function armFetch(rows) {
    global.UrlFetchApp = {
      fetch: () => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, meta: { paging: { truncated: false, rowsIncluded: true, returned: rows.length } }, rows: rows })
      }),
    };
  }
  function reset() {
    currentSS = makeSpreadsheet();
    scriptProps = { ORDER_APP_COST_TOKEN: 'gb-token' };
    calendarEvents = [];
    clearLoggedMessages();
  }
  function plusDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  const weeks = lastCompletedWeeks_(todayStr_(), 8);

  /* --- noinv date-move (the round-9 CRITICAL, reviewer probe 3): a one-day
   *     correction inside the SAME ISO week previously left BOTH
   *     'noinv-<old>' and 'noinv-<new>' rows in Suppliers and doubled the
   *     week in Summary with no alert. The old row must now surface as an
   *     orphan. --- */
  reset();
  const day1 = weeks[1].start;            // a Monday, safely inside the pull window
  const day2 = plusDays(day1, 1);         // corrected to the Tuesday, same ISO week
  armFetch([{ rowNumber: 1, dateLocal: day1, supplierRaw: 'Slip Co', supplierKey: 'slip_co', invoiceNum: '', totalCostIncGst: 400, status: 'RECEIVED' }]);
  greenBeanPull_impl_(); // seeds slip_co/noinv-<day1>
  calendarEvents = [];
  armFetch([{ rowNumber: 1, dateLocal: day2, supplierRaw: 'Slip Co', supplierKey: 'slip_co', invoiceNum: '', totalCostIncGst: 400, status: 'RECEIVED' }]);
  greenBeanPull_impl_();
  // PRD-12: the queued weeklySummarize(week) for this same week now ALSO goes
  // through the guarded heal path, which raises its own (separate) loud
  // correction alert because the week's total genuinely moved 400 -> 800 (the
  // double-count the orphan alert below explains) — two alerts, not one, both
  // real signals of the same underlying stale row.
  eq('noinv date-move: the stale old row raises an orphan alert (was a silent double-count)',
    calendarEvents.length, 2);
  check('orphan alert names the stale noinv ref and the runbook',
    calendarEvents[0]._description.indexOf('slip_co/noinv-' + day1) !== -1 &&
    calendarEvents[0]._description.indexOf('weeklySummarize') !== -1);
  check('alert title carries the greenbean_orphan key',
    calendarEvents[0]._title.indexOf('greenbean_orphan') !== -1);

  /* --- upstream deletion inside the window: previously "goes stale
   *     silently" (schema.md limitation) — the vanished invoice now orphans
   *     and alerts, with NO rename hint (nothing new matches its number). --- */
  reset();
  armFetch([
    { rowNumber: 1, dateLocal: weeks[0].start, supplierRaw: 'Del Co', supplierKey: 'del_co', invoiceNum: 'D-1', totalCostIncGst: 90, status: 'RECEIVED' },
    { rowNumber: 2, dateLocal: weeks[0].start, supplierRaw: 'Keep Co', supplierKey: 'keep_co', invoiceNum: 'K-1', totalCostIncGst: 10, status: 'RECEIVED' }
  ]);
  greenBeanPull_impl_();
  calendarEvents = [];
  armFetch([{ rowNumber: 2, dateLocal: weeks[0].start, supplierRaw: 'Keep Co', supplierKey: 'keep_co', invoiceNum: 'K-1', totalCostIncGst: 10, status: 'RECEIVED' }]);
  greenBeanPull_impl_();
  eq('deleted upstream invoice: orphan alert fires', calendarEvents.length, 1);
  check('deletion orphan names the ref and carries no rename hint',
    calendarEvents[0]._description.indexOf('del_co/d-1') !== -1 &&
    calendarEvents[0]._description.indexOf('possibly renamed') === -1);

  /* --- the runbook's end state CLEARS the alert: zeroing the old row drops
   *     it from the orphan set (no money at stake), and the signature clears
   *     so the NEXT incident re-arms instead of being suppressed. --- */
  const suppSheet = currentSS.getSheetByName('Suppliers');
  const suppVals = suppSheet.getDataRange().getValues();
  for (let r = 1; r < suppVals.length; r++) {
    if (String(suppVals[r][3]) === 'del_co/D-1') suppSheet.getRange(r + 1, 3).setValue(0);
  }
  greenBeanPull_impl_();
  eq('zeroed row: no further orphan alert', calendarEvents.length, 1);
  check('zeroed row: orphan signature cleared (next incident re-arms)',
    !('ORDERAPP_DQ_SIG_greenbean_orphan' in scriptProps));

  /* --- extracted_at stamp on the date-move self-heal (round-9 minor):
   *     value+stamp convention — an in-place date correction must refresh
   *     extracted_at like every other in-place correction in the hub. --- */
  reset();
  armFetch([{ rowNumber: 1, dateLocal: weeks[5].start, supplierRaw: 'Stamp Co', supplierKey: 'stamp_co', invoiceNum: 'SM-1', totalCostIncGst: 250, status: 'RECEIVED' }]);
  greenBeanPull_impl_(); // seeds at weeks[5]
  {
    const sheet = currentSS.getSheetByName('Suppliers');
    const vals = sheet.getDataRange().getValues();
    for (let r = 1; r < vals.length; r++) {
      if (String(vals[r][3]) === 'stamp_co/SM-1') sheet.getRange(r + 1, 7).setValue('OLD-TS');
    }
  }
  armFetch([{ rowNumber: 1, dateLocal: weeks[1].start, supplierRaw: 'Stamp Co', supplierKey: 'stamp_co', invoiceNum: 'SM-1', totalCostIncGst: 250, status: 'RECEIVED' }]);
  greenBeanPull_impl_();
  const healed = currentSS.getSheetByName('Suppliers').getDataRange().getValues()
    .slice(1).filter((r) => String(r[3]) === 'stamp_co/SM-1')[0];
  eq('date-move self-heal still updates the date cell', cellDate(healed[0]), weeks[1].start);
  check('date-move self-heal re-stamps extracted_at alongside the date (value+stamp convention)',
    String(healed[6]) !== 'OLD-TS' && String(healed[6]).indexOf('T') !== -1);
  /* EXPECTATION CHANGED 2026-08-25 (summary-self-heal step 3), 0 -> 1, deliberately.
   *
   * At the SUPPLIERS level this assertion's original claim still holds: a re-dated
   * invoice is NOT an orphan there, because the ref is still present in the pull, and
   * orderapp's own sweep correctly stays silent about it.
   *
   * But the date move DOES orphan a SUMMARY row, and that is a real double-count, not a
   * false positive. The self-heal rewrites the Suppliers date and re-summarizes both
   * weeks; re-summarizing the OLD week then aggregates to no row for that key at all,
   * and upsertRows_ has no delete path — so the old week's Summary row survives holding
   * the full amount while the new week also gains it. The same money reads twice through
   * doGet, and every report built on it.
   *
   * Step 3's Summary-level orphan detection is what surfaces that. Per Jake's decision
   * (2026-08-25): alert on it, clear it with the gated manual sweep — never suppress it,
   * and never auto-delete on this path, because shopify_orderapp Summary rows are
   * unrebuildable and an automatic deleter over financial records is not recoverable.
   *
   * So: 1 alert, and it names the stale old-week row. If this ever goes back to 0, the
   * double-count has gone silent again — that is a regression, not a cleanup. */
  eq('date move orphans a Summary row — real double-count, must alert', calendarEvents.length, 1);

  global.UrlFetchApp = REAL_URL_FETCH;
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

  // The sibling suppliers gate must be equally casing/whitespace-proof.
  function suppliersBody(source) {
    return {
      source: source, kind: 'suppliers', extracted_at: '2026-08-06T10:00:00+10:00',
      rows: [{ date: '2026-08-01', supplier: 'X', total: 10, invoice_ref: 'X-1' }]
    };
  }
  eq('suppliers gate: exact source rejected', validateIngest_(suppliersBody('coffee_order_app')).ok, false);
  eq('suppliers gate: mixed casing rejected too', validateIngest_(suppliersBody('Coffee_Order_App')).ok, false);
  eq('suppliers gate: padded source rejected too', validateIngest_(suppliersBody(' coffee_order_app ')).ok, false);
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

// The monthly "Mayer's Fine Food statement" is not an invoice and can never
// parse, so mayersDailyPull never labels its thread, so MAYERS_SEARCH returns it
// again tomorrow — and Drive OCR runs on it every day forever. Verified against
// the live mailbox 2026-08-15: 8 threads match the search, `expense-ingested`
// covers 7. These tests assert the OCR is skipped on the second sighting.
//
// This is the FIRST coverage mayersDailyPull has ever had — global.GmailApp was
// `{}` — so the mock is deliberately faithful on the one axis that matters:
// search() honours the `-label:expense-ingested` clause by returning only
// unlabelled threads, exactly as Gmail does.
console.log('mayersDailyPull — unparseable-attachment memo (Drive OCR quota leak)');
(function () {
  const savedGmail = global.GmailApp;
  const savedExtract = globalThis.extractPdfText_;
  const savedVersion = globalThis.MAYERS_PARSER_VERSION;

  const INVOICE_TEXT = 'Invoice No: 3429816\nInvoice Date: 17-JUN-26\n' +
    'Deliver To:\n5 BLUES ST\nNORTH SYDNEY NSW 2060\nTotal: 736.74';
  const INVOICE2_TEXT = 'Invoice No: 3434688\nInvoice Date: 30-JUN-26\n' +
    'Deliver To:\n89 YORK ST\nSYDNEY\nTotal: 121.00';
  const STATEMENT_TEXT = "Mayer's Fine Food statement - 31 JUL 26\nAged balances follow.";

  let ocrCalls = [];        // attachment keys extractPdfText_ was actually asked for
  let ocrText = {};         // attachment name → text to return, or an Error to throw
  let allThreads = [];

  function attachment(name, size) {
    return {
      getContentType: () => 'application/pdf',
      getName: () => name,
      getSize: () => size,
    };
  }
  function message(name, size, dateIso) {
    return {
      getAttachments: () => [attachment(name, size)],
      getDate: () => new Date(dateIso),
    };
  }
  function thread(messages) {
    const t = {
      _labelled: false,
      _messages: messages,
      getMessages: () => t._messages,
      addLabel: () => { t._labelled = true; },
    };
    return t;
  }

  global.GmailApp = {
    // Models `-label:expense-ingested`: a labelled thread stops being returned.
    search: () => allThreads.filter((t) => !t._labelled),
    getUserLabelByName: () => ({ _name: MAYERS_LABEL }),
    createLabel: () => ({ _name: MAYERS_LABEL }),
  };
  globalThis.extractPdfText_ = function (pdf) {
    ocrCalls.push(pdf.getName() + ':' + pdf.getSize());
    const t = ocrText[pdf.getName()];
    if (t instanceof Error) throw t;
    return t;
  };

  function resetProps() { scriptProps = { HUB_SHEET_ID: 'hub' }; }
  function run() { ocrCalls = []; return mayersDailyPull(); }

  /* --- scenario: one real invoice + the statement ------------------ */
  freshSheets();
  resetProps();
  ocrText = { 'inv3429816.pdf': INVOICE_TEXT, 'statement-31JUL26.pdf': STATEMENT_TEXT };
  const invoiceThread = thread([message('inv3429816.pdf', 51200, '2026-06-17T04:10:24Z')]);
  const statementThread = thread([message('statement-31JUL26.pdf', 88000, '2026-08-04T03:40:26Z')]);
  allThreads = [invoiceThread, statementThread];

  const run1 = run();

  // Meta-assertion: the counter genuinely observes OCR. Without this, every
  // "0 OCR calls" assertion below could pass on a stub that is never wired in.
  eq('run 1 OCRs both attachments (mock observes real calls)', ocrCalls.length, 2);
  eq('run 1 ingests the invoice', run1.rowsAdded, 1);
  eq('run 1 counts the statement as unparsed', run1.unparsed, 1);
  eq('run 1 skips no OCR — nothing memoed yet', run1.ocrSkipped, 0);
  check('invoice thread is labelled', invoiceThread._labelled === true);
  check('statement thread stays UNLABELLED (a new attachment must still be seen)',
    statementThread._labelled === false);

  /* --- the leak: second sighting of the same statement -------------- */
  const run2 = run();
  eq('run 2 performs ZERO OCR — the daily statement re-OCR is gone', ocrCalls.length, 0);
  eq('run 2 reports the skip', run2.ocrSkipped, 1);
  eq('run 2 ingests nothing new', run2.rowsAdded, 0);
  check('statement thread is STILL unlabelled after being memoed',
    statementThread._labelled === false);

  /* --- a new attachment on that same thread is still processed ------ */
  ocrText['inv3434688.pdf'] = INVOICE2_TEXT;
  statementThread._messages = statementThread._messages.concat([
    message('inv3434688.pdf', 49000, '2026-06-30T20:05:00Z'),
  ]);
  const run3 = run();
  eq('a NEW attachment on the memoed thread is OCRd', ocrCalls, ['inv3434688.pdf:49000']);
  eq('the new invoice ingests', run3.rowsAdded, 1);
  eq('the statement beside it is still skipped', run3.ocrSkipped, 1);
  check('thread is labelled now that something parsed out of it',
    statementThread._labelled === true);

  /* --- a parser change retries every memoed document exactly once --- */
  // Fresh scenario on a statement-only thread: nothing ever parses out of it, so
  // it is never labelled and stays in the search for the whole sequence. (Reusing
  // the thread above would confound this — it now also carries a parseable
  // invoice, which re-labels the thread and adds a second OCR call.)
  freshSheets();
  resetProps();
  ocrText = { 'statement-31JUL26.pdf': STATEMENT_TEXT };
  allThreads = [thread([message('statement-31JUL26.pdf', 88000, '2026-08-04T03:40:26Z')])];

  run();                                  // first sighting: memoed
  const memoed = run();
  eq('memoed under the current version → no OCR', ocrCalls.length, 0);
  eq('…and reports the skip', memoed.ocrSkipped, 1);

  globalThis.MAYERS_PARSER_VERSION = savedVersion + 1;
  const run4 = run();
  eq('version bump re-OCRs the memoed statement exactly once',
    ocrCalls, ['statement-31JUL26.pdf:88000']);
  eq('version bump means nothing is skipped', run4.ocrSkipped, 0);
  const run5 = run();
  eq('and it is immediately re-memoed under the new version', ocrCalls.length, 0);
  eq('re-memoed under new version reports the skip', run5.ocrSkipped, 1);
  globalThis.MAYERS_PARSER_VERSION = savedVersion;

  /* --- a TRANSIENT OCR failure must never be memoed ----------------- */
  freshSheets();
  resetProps();
  ocrText = { 'flaky.pdf': new Error('rate limit exceeded for OCR') };
  const flakyThread = thread([message('flaky.pdf', 12345, '2026-08-10T01:00:00Z')]);
  allThreads = [flakyThread];

  const flaky1 = run();
  eq('a thrown OCR counts as unparsed', flaky1.unparsed, 1);
  const flaky2 = run();
  eq('a transient OCR failure is NOT memoed — it retries next run',
    ocrCalls, ['flaky.pdf:12345']);
  eq('and reports no skip', flaky2.ocrSkipped, 0);

  // Once OCR recovers, the invoice ingests normally.
  ocrText['flaky.pdf'] = INVOICE_TEXT;
  const flaky3 = run();
  eq('a recovered attachment ingests normally', flaky3.rowsAdded, 1);

  global.GmailApp = savedGmail;
  globalThis.extractPdfText_ = savedExtract;
  globalThis.MAYERS_PARSER_VERSION = savedVersion;
  scriptProps = {};
})();

console.log('mayers memo helpers');
(function () {
  const savedVersion = globalThis.MAYERS_PARSER_VERSION;
  scriptProps = {};

  eq('attachment key pairs name with byte size',
    mayersAttachmentKey_({ getName: () => 'a.pdf', getSize: () => 42 }), 'a.pdf:42');
  check('same name, different size → different key',
    mayersAttachmentKey_({ getName: () => 'a.pdf', getSize: () => 42 }) !==
    mayersAttachmentKey_({ getName: () => 'a.pdf', getSize: () => 43 }));

  eq('absent memo loads as empty', mayersLoadUnparseable_(), {});

  mayersSaveUnparseable_({ 'x.pdf:1': 1000 });
  eq('round-trips at the current version', mayersLoadUnparseable_(), { 'x.pdf:1': 1000 });

  globalThis.MAYERS_PARSER_VERSION = savedVersion + 1;
  eq('a version bump discards the whole memo', mayersLoadUnparseable_(), {});
  globalThis.MAYERS_PARSER_VERSION = savedVersion;

  scriptProps[MAYERS_UNPARSEABLE_PROP] = '{not json';
  eq('corrupt memo degrades to empty, not a throw', mayersLoadUnparseable_(), {});

  // Eviction: oldest-first, capped. Guards the 9KB Script-Properties value limit.
  const many = {};
  for (let i = 0; i < MAYERS_UNPARSEABLE_MAX_ + 50; i++) many['f' + i + '.pdf:1'] = i;
  mayersSaveUnparseable_(many);
  const kept = mayersLoadUnparseable_();
  eq('memo is capped at MAYERS_UNPARSEABLE_MAX_',
    Object.keys(kept).length, MAYERS_UNPARSEABLE_MAX_);
  check('oldest entry was evicted', kept['f0.pdf:1'] === undefined);
  check('newest entry was kept',
    kept['f' + (MAYERS_UNPARSEABLE_MAX_ + 49) + '.pdf:1'] !== undefined);

  globalThis.MAYERS_PARSER_VERSION = savedVersion;
  scriptProps = {};
})();

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */

// mayers.gs — RETAINED location-repair rollback.
//
// The repair itself (mayers_repair.gs) was deleted after it verified on
// 2026-08-24, but its artifacts are kept ON PURPOSE and stay live in
// production: the Summary_mayers_location_backup tab holds the only copy of the
// four deleted Summary rows, and MAYERS_REPAIR_SNAPSHOT_<week> holds the
// original Suppliers locations. restoreMayersLocationSnapshot() is the only
// code that knows how to consume them, so it lives in mayers.gs and is covered
// here — a retained rollback artifact with no working rollback is worse than
// no artifact at all.
//
// These fixtures hand-build the post-apply state (Sheet + snapshot + backup
// tab) exactly as the real apply left it, which is what lets this coverage
// outlive the file that produced it.
console.log('mayers.gs — retained location-repair rollback');
(function testRetainedMayersRollback() {
  const savedSS = currentSS;
  const savedProps = scriptProps;

  const HINT = 'UNMAPPED: LEIBLE COFFEE NORTH SYDNEY 5 BLUES ST NORTH SYDNEY NSW 2060 ';
  const TS = '2026-08-24T12:54:00+10:00';
  const WEEK = '2026-07-06';

  // The real snapshot shape, as mayersRepairApplyWeek_ wrote it.
  function snapshot(opts) {
    opts = opts || {};
    return {
      week: WEEK,
      capturedAt: TS,
      rows: [{
        invoice_ref: '3437634', location: HINT, total: 703.75,
        date: '2026-07-08', department: 'Cafe', supplier: 'Mayers'
      }],
      staleKeys: [{
        week_start: WEEK, department: 'Cafe', kind: 'spend',
        supplier: 'Mayers', location: HINT, refs: ['3437634']
      }],
      targetKeys: [{
        department: 'Cafe', kind: 'spend', supplier: 'Mayers', location: 'Leible North',
        existedBefore: opts.targetExisted === true,
        totalBefore: opts.targetExisted === true ? opts.totalBefore : null
      }]
    };
  }

  /** The Sheet as the apply left it: location rewritten, stale row deleted,
   *  target row present, original safe in the backup tab. */
  function seedPostApply(opts) {
    opts = opts || {};
    scriptProps = {};
    currentSS = makeSpreadsheet();

    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supp.appendRow(['2026-07-08', 'Mayers', 703.75, '3437634', 'Leible North', 'mayers', TS, 'Cafe']);
    supp.appendRow(['2026-07-09', 'Kent Paper', 40.00, 'KP-9', 'Leible York', 'kent_paper', TS, 'Cafe']);

    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summ.appendRow([WEEK, '2026-07-12', 'Mayers', 'Leible North',
      opts.targetExisted ? 703.75 + opts.totalBefore : 703.75, TS, 'Cafe', 'spend']);
    // A co-located unrebuildable row: same week, blank location, different
    // supplier. Rollback must not touch it — the full key tuple is the only
    // thing separating them.
    summ.appendRow([WEEK, '2026-07-12', 'Bennetts', '', 14219, TS, 'Roastery', 'spend']);
    summ.appendRow([WEEK, '2026-07-12', 'Kent Paper', 'Leible York', 40.00, TS, 'Cafe', 'spend']);

    const backup = ensureSheet(currentSS, MAYERS_REPAIR_BACKUP_TAB, SUMMARY_HEADERS);
    backup.appendRow([WEEK, '2026-07-12', 'Mayers', HINT, 703.75, TS, 'Cafe', 'spend']);

    scriptProps[MAYERS_REPAIR_SNAPSHOT_PREFIX_ + WEEK] = JSON.stringify(snapshot(opts));
  }

  function summaryState() {
    return currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues().slice(1)
      .map((r) => JSON.stringify([cellDate(r[0]), String(r[2]), String(r[3]), Number(r[4]),
        String(r[6]), String(r[7])])).sort();
  }
  function supplierLocation(ref) {
    const hit = currentSS.getSheetByName(SUPPLIERS_TAB).getDataRange().getValues().slice(1)
      .filter((r) => String(r[3]) === ref);
    return hit.length ? String(hit[0][4]) : null;
  }
  function findSummary(supplier, location) {
    return currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues().slice(1)
      .filter((r) => String(r[2]).trim().toLowerCase() === supplier.toLowerCase()
        && String(r[3]).trim().toLowerCase() === location.trim().toLowerCase());
  }

  /* ---- the artifacts the cleanup deliberately kept -------------------- */
  eq('the backup tab name is retained', MAYERS_REPAIR_BACKUP_TAB, 'Summary_mayers_location_backup');
  eq('the snapshot key prefix is retained', MAYERS_REPAIR_SNAPSHOT_PREFIX_, 'MAYERS_REPAIR_SNAPSHOT_');
  eq('the rollback entry point survives the cleanup',
    typeof restoreMayersLocationSnapshot, 'function');

  /* ---- rollback restores Suppliers AND Summary ------------------------ */
  seedPostApply();
  (function () {
    const res = restoreMayersLocationSnapshot();
    eq('zero-arg rollback finds the week from its property alone', res.weeks, 1);
    eq('the Suppliers location is back to the original UNMAPPED value',
      supplierLocation('3437634'), HINT);
    eq('the stale Summary row is re-appended from the backup tab',
      findSummary('Mayers', HINT).length, 1);
    eq('...with its original amount', Number(findSummary('Mayers', HINT)[0][4]), 703.75);
    eq('the target-location row the repair created is removed',
      findSummary('Mayers', 'Leible North').length, 0);
    eq('the co-located Bennetts row is untouched', findSummary('Bennetts', '').length, 1);
    eq('...with its total intact', Number(findSummary('Bennetts', '')[0][4]), 14219);
    eq('an unrelated supplier in the same week is untouched',
      Number(findSummary('Kent Paper', 'Leible York')[0][4]), 40.00);
  })();

  /* ---- rollback is idempotent ----------------------------------------- */
  seedPostApply();
  (function () {
    restoreMayersLocationSnapshot();
    const after1 = summaryState();
    const res2 = restoreMayersLocationSnapshot();
    eq('a second rollback changes nothing', summaryState(), after1);
    eq('...and re-appends nothing (no double-count)', res2.results[0].staleRowsRestored, 0);
    eq('...and deletes nothing', res2.results[0].targetRowsDeleted, 0);
    eq('exactly one stale row is present, not two', findSummary('Mayers', HINT).length, 1);
  })();

  /* ---- a pre-existing target row is RESTORED, not deleted -------------- */
  // The apply records whether the target key already held a row. If it did,
  // rolling back must put its old amount back rather than delete it — deleting
  // would destroy a figure the repair never created.
  seedPostApply({ targetExisted: true, totalBefore: 500 });
  (function () {
    restoreMayersLocationSnapshot();
    const target = findSummary('Mayers', 'Leible North');
    eq('a pre-existing target row survives rollback', target.length, 1);
    eq('...restored to its pre-repair amount', Number(target[0][4]), 500);
  })();

  /* ---- refusals ------------------------------------------------------- */
  seedPostApply();
  (function () {
    scriptProps = {};
    const res = restoreMayersLocationSnapshot();
    eq('no snapshots at all -> nothing to roll back, no throw', res.weeks, 0);
  })();

  seedPostApply();
  (function () {
    // A corrupt snapshot must STOP, never be treated as absent: absent means
    // "safe first run" and this is the opposite of that.
    scriptProps[MAYERS_REPAIR_SNAPSHOT_PREFIX_ + WEEK] = '{not json';
    const res = restoreMayersLocationSnapshot(WEEK);
    eq('a corrupt snapshot refuses', res.results[0].refused, 'corrupt-snapshot');
    eq('...and changes nothing', supplierLocation('3437634'), 'Leible North');
  })();

  seedPostApply();
  (function () {
    global.__forceLockTimeout = true;
    const res = restoreMayersLocationSnapshot();
    eq('a lock timeout refuses instead of silently no-opping', res.refused, 'locked');
    eq('...having changed nothing', supplierLocation('3437634'), 'Leible North');
    global.__forceLockTimeout = false;
  })();

  /* ---- write-once snapshots ------------------------------------------- */
  seedPostApply();
  (function () {
    const original = scriptProps[MAYERS_REPAIR_SNAPSHOT_PREFIX_ + WEEK];
    const res = mayersRepairSaveSnapshot_(WEEK, { week: WEEK, rows: [] });
    eq('saving over an existing week refuses', res.reason, 'already-exists');
    eq('...leaving the real artifact intact',
      scriptProps[MAYERS_REPAIR_SNAPSHOT_PREFIX_ + WEEK], original);
    eq('a different week writes its own key',
      mayersRepairSaveSnapshot_('2026-07-20', { week: '2026-07-20', rows: [] }).written, true);
    eq('...and both are enumerated, oldest first',
      mayersRepairSnapshotWeeks_(), ['2026-07-06', '2026-07-20']);
  })();

  /* ---- the full-key-tuple matcher ------------------------------------- */
  seedPostApply();
  (function () {
    const summData = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    // Bennetts and a blank-location Mayers row differ ONLY by supplier/dept.
    // (week, location) would match both; the full tuple matches one.
    const bennetts = mayersFindSummaryRows_(summData,
      mayersSummaryKeyRow_(WEEK, 'Roastery', 'spend', 'Bennetts', ''));
    eq('the full tuple finds exactly the Bennetts row', bennetts.length, 1);
    const mayersBlank = mayersFindSummaryRows_(summData,
      mayersSummaryKeyRow_(WEEK, 'Cafe', 'spend', 'Mayers', ''));
    eq('...and does NOT confuse it with a blank-location Mayers key', mayersBlank.length, 0);
    eq('mayersNorm_ matches rowKey_ normalization', mayersNorm_('  MaYeRs  '), 'mayers');
  })();

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// summary_audit.gs — READ-ONLY drift audit.
//
// Summary is written once per week and never revisited, so anything landing in
// Suppliers afterwards never reaches reports. Week 2026-06-15 was found short
// $3,176.95 BY ACCIDENT during the Mayers repair; this function looks for the
// rest on purpose. archiveAndPurge_ moves source rows out of Suppliers after
// 183 days, so there is a clock on how long each gap stays fixable.
console.log('summary_audit.gs — Summary vs Suppliers drift audit');
(function testSummaryDriftAudit() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-24T13:00:00+10:00';

  // 'now' is fixed so "is this week complete?" is deterministic.
  const NOW = '2026-08-24T02:00:00Z';   // Mon 24 Aug 2026, 12:00 Sydney

  function seed(supplierRows, summaryRows, opts) {
    opts = opts || {};
    currentSS = makeSpreadsheet();
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    (opts.archiveRows || []).forEach((r) => arch.appendRow(r));
    (opts.revenueRows || []).forEach((r) => currentSS.getSheetByName(REVENUE_TAB).appendRow(r));
  }
  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];
  const sum = (wk, supplier, loc, total, dept, kind) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, dept || 'Cafe', kind || 'spend'];

  /* ---- a clean week reports nothing ------------------------------------ */
  seed([sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100)]);
  withMockNow(NOW, function () {
    const writes = currentSS._writeLog.length;
    const r = auditSummaryDrift();
    eq('the audit writes NOTHING', currentSS._writeLog.length, writes);
    eq('a matching week is clean', r.weeksDrifted, 0);
    eq('...and counted as audited', r.weeksAudited, 1);
    eq('...with no money reported', r.netUnderreported, 0);
  });

  /* ---- a row in Suppliers but NOT in Summary --------------------------- */
  // This is the 2026-06-15 shape: the row reads $0 in every report.
  seed([sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York'),
        sup('2026-07-09', 'Fresh and Chill', 250.50, 'F1', 'Leible North')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100)]);
  withMockNow(NOW, function () {
    const r = auditSummaryDrift();
    eq('a missing row is found', r.missingRows, 1);
    eq('...the week is flagged', r.weeksDrifted, 1);
    eq('...and the money is quantified', r.netUnderreported, 250.50);
    eq('...naming supplier and shop',
      r.weeks[0].detail.missing[0].supplier + '@' + r.weeks[0].detail.missing[0].location,
      'Fresh and Chill@Leible North');
  });

  /* ---- a stale amount -------------------------------------------------- */
  seed([sup('2026-07-08', 'Kent Paper', 175.25, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100)]);
  withMockNow(NOW, function () {
    const r = auditSummaryDrift();
    eq('a stale amount is found', r.staleRows, 1);
    eq('...reporting only the shortfall, not the whole row', r.netUnderreported, 75.25);
    eq('...with both figures', [r.weeks[0].detail.stale[0].live, r.weeks[0].detail.stale[0].actual],
      [100, 175.25]);
  });

  /* ---- float noise is not drift ---------------------------------------- */
  // aggregateSupplierRows_ rounds its OWN output, so the recomputed side is
  // always clean — the unrounded value can only come off the Summary sheet,
  // which is read raw. This fixture puts it there, which is the only way the
  // cents guard is actually exercised: comparing 0.1+0.2 against a rounded 0.3
  // passes even with a strict === and proves nothing.
  seed([sup('2026-07-08', 'A', 0.1, 'K1', 'X'), sup('2026-07-09', 'A', 0.2, 'K2', 'X')],
       [sum('2026-07-06', 'A', 'X', 0.1 + 0.2)]);
  withMockNow(NOW, function () {
    check('the fixture really does hold an unrounded float',
      currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()[1][4] !== 0.3);
    eq('a Summary cell of 0.30000000000000004 is NOT reported as drift',
      auditSummaryDrift().weeksDrifted, 0);
  });

  /* ---- the ARCHIVE is part of the source ------------------------------- */
  // Once archiveAndPurge_ runs, Suppliers is empty for that week. Auditing
  // against Suppliers alone would report every archived week as an orphan —
  // the exact opposite of the problem being looked for.
  seed([], [sum('2026-01-05', 'Kent Paper', 'Leible York', 100)],
       { archiveRows: [sup('2026-01-07', 'Kent Paper', 100, 'K1', 'Leible York')] });
  withMockNow(NOW, function () {
    const r = auditSummaryDrift();
    eq('an archived week that matches is CLEAN, not an orphan', r.weeksDrifted, 0);
  });

  seed([], [sum('2026-01-05', 'Kent Paper', 'Leible York', 100)],
       { archiveRows: [sup('2026-01-07', 'Kent Paper', 180, 'K1', 'Leible York')] });
  withMockNow(NOW, function () {
    const r = auditSummaryDrift();
    eq('...but a genuinely stale archived week IS reported', r.staleRows, 1);
    check('...flagged as past the purge line', r.weeks[0].pastPurgeLine === true);
    check('...and as no longer present in Suppliers', r.weeks[0].sourceRowsStillPresent === false);
  });

  /* ---- pull-owned rows are expected, not orphans ----------------------- */
  seed([sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100),
        sum('2026-07-06', 'Labour', 'york', 4000),
        sum('2026-07-06', 'Bennetts', '', 14219, 'Roastery'),
        sum('2026-07-06', 'shopify_orderapp', 'online', 900, 'Roastery', 'revenue')]);
  withMockNow(NOW, function () {
    const r = auditSummaryDrift();
    eq('Labour / Bennetts / shopify_orderapp are NOT flagged as orphans', r.weeksDrifted, 0);
  });

  seed([sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100),
        sum('2026-07-06', 'Ghost Supplier', 'Leible Pitt', 55)]);
  withMockNow(NOW, function () {
    const r = auditSummaryDrift();
    eq('a NON-pull-owned Summary-only row IS flagged', r.weeks[0].summaryOnly, 1);
    // An orphan may be double-counted money, not missing money — netting it
    // into the shortfall would misstate the problem in the wrong direction.
    eq('...but is NOT netted into the under-reported figure', r.netUnderreported, 0);
  });

  /* ---- the incomplete current week is skipped, not flagged ------------- */
  seed([sup('2026-08-25', 'Kent Paper', 100, 'K1', 'Leible York')], []);
  withMockNow(NOW, function () {
    const r = auditSummaryDrift();
    eq('the in-flight week is skipped', r.skipped.length, 1);
    eq('...and not counted as drift', r.weeksDrifted, 0);
    check('...with the reason recorded',
      r.skipped[0].reason.indexOf('incomplete') !== -1);
  });

  /* ---- revenue rows are audited too ------------------------------------ */
  seed([], [], { revenueRows: [
    ['2026-07-08', 'Roastery', 'wholesale', 'Acme Cafe', 500, 'O1', 'src', TS],
  ] });
  withMockNow(NOW, function () {
    const r = auditSummaryDrift();
    eq('a missing REVENUE row is found too', r.missingRows, 1);
    eq('...and quantified', r.netUnderreported, 500);
  });

  /* ---- the report survives the editor log ------------------------------ */
  seed([sup('2026-07-08', 'A', 10, 'K1', 'X'), sup('2026-07-09', 'B', 20, 'K2', 'Y')],
       [sum('2026-07-06', 'A', 'X', 10)]);
  withMockNow(NOW, function () {
    clearLoggedMessages();
    auditSummaryDriftDetail();
    const log = lastLoggedMessages();
    check('logs line by line, not as one blob', log.length > 8);
    check('no line risks truncation', log.every((l) => String(l).length < 300));
    const joined = log.join('\n');
    check('the headline number is present', joined.indexOf('NET UNDER-REPORTED: $20') !== -1);
    check('the purge line is stated', joined.indexOf('purge line') !== -1);
    check('detail names the missing row', joined.indexOf('MISSING  B @ Y') !== -1);
  });

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// Code.gs — computeHealPlan_(weeks, ctx): the single source of truth for what
// a Summary heal WOULD do. Both the read-only preview (previewSummaryHeal, below)
// and the eventual write path call this — they must never diverge, because the
// preview is the only look Jake gets before real money moves. Pure: `ctx` is
// pre-built by the caller (archiveWeeks Set, summaryRows, supplierRows,
// revenueRows), so this function touches no Sheet.
console.log('Code.gs — computeHealPlan_ (single source of truth for what a heal would do)');
(function testComputeHealPlan() {
  const savedSS = currentSS;
  const TS = '2026-08-24T13:00:00+10:00';

  function seed(supplierRows, summaryRows, opts) {
    opts = opts || {};
    currentSS = makeSpreadsheet();
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    const rev = ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    (opts.revenueRows || []).forEach((r) => rev.appendRow(r));
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    (opts.archiveRows || []).forEach((r) => arch.appendRow(r));
  }
  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];
  const sum = (wk, supplier, loc, total, dept, kind) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, dept || 'Cafe', kind || 'spend'];

  // Mirrors the guarded build documented for `ctx.archiveWeeks` — this is TEST
  // scaffolding standing in for whatever caller builds ctx (previewSummaryHeal
  // builds it for real, and is tested separately below); computeHealPlan_ itself
  // never touches a Sheet, so its unit tests supply ctx directly.
  function buildCtx() {
    const suppSheet = currentSS.getSheetByName(SUPPLIERS_TAB);
    const archSheet = currentSS.getSheetByName(ARCHIVE_TAB);
    const summSheet = currentSS.getSheetByName(SUMMARY_TAB);
    const revSheet = currentSS.getSheetByName(REVENUE_TAB);
    const archRows = archSheet ? archSheet.getDataRange().getValues().slice(1) : [];
    const archiveWeeks = {};
    archRows.forEach((r) => {
      const d = coerceDateStr_(r[0]);
      if (DATE_ARG_RE.test(d)) archiveWeeks[weekStartForDate_(d)] = true;
    });
    return {
      archiveWeeks: archiveWeeks,
      summaryRows: summSheet.getDataRange().getValues(),
      supplierRows: suppSheet ? suppSheet.getDataRange().getValues().slice(1) : [],
      revenueRows: revSheet ? revSheet.getDataRange().getValues().slice(1) : []
    };
  }

  /* ---- a stale week heals with the correct delta ------------------------ */
  seed([sup('2026-07-08', 'Kent Paper', 175.25, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100)]);
  {
    const plan = computeHealPlan_(['2026-07-06'], buildCtx());
    eq('one plan entry per requested week', plan.length, 1);
    const wk = plan[0];
    eq('...for the requested week', wk.week, '2026-07-06');
    eq('action is heal', wk.action, 'heal');
    eq('exactly one row to write', wk.rows.length, 1);
    eq('...with live/computed named', [wk.rows[0].live, wk.rows[0].computed], [100, 175.25]);
    eq('...and the delta correctly quantified (not the whole row)', wk.rows[0].delta, 75.25);
    check('...not flagged as a new row (it already exists in Summary)', wk.rows[0].isNew === false);
    const expectedKey = rowKey_(
      mayersSummaryKeyRow_('2026-07-06', 'Cafe', 'spend', 'Kent Paper', 'Leible York'),
      SUMMARY_KEY_COLS);
    eq('...keyed exactly as rowKey_(SUMMARY_KEY_COLS) would key it', wk.rows[0].key, expectedKey);
    eq('an updated row costs 2 setValue calls (upsertRows_ pays amountCol + stampCol)',
      wk.projectedSetValues, 2);
  }

  /* ---- a week with an _archive row is skipped, not healed --------------- */
  seed([sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100)],
       { archiveRows: [sup('2026-07-09', 'Fresh and Chill', 50, 'F1', 'Leible North')] });
  {
    const plan = computeHealPlan_(['2026-07-06'], buildCtx());
    eq('a week with an _archive row is skip-split', plan[0].action, 'skip-split');
    check('...with NO rows to write', !plan[0].rows || plan[0].rows.length === 0);
    eq('...and zero projected setValue calls', plan[0].projectedSetValues, 0);
    check('...with a reason recorded', typeof plan[0].reason === 'string' && plan[0].reason.length > 0);
  }

  /* ---- duplicate keys in the live Summary refuse the week ---------------- */
  // Case/whitespace variant, not an exact string duplicate — duplicate
  // detection must mirror rowKey_'s trim().toLowerCase() normalization exactly.
  seed([sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100),
        sum('2026-07-06', '  KENT PAPER  ', 'leible york', 999)]);
  {
    const plan = computeHealPlan_(['2026-07-06'], buildCtx());
    eq('duplicate live keys (case/whitespace-insensitive) refuse the week',
      plan[0].action, 'refuse-duplicate-keys');
    check('...with NO rows to write', !plan[0].rows || plan[0].rows.length === 0);
    eq('...and zero projected setValue calls', plan[0].projectedSetValues, 0);
    check('...with a reason recorded', typeof plan[0].reason === 'string' && plan[0].reason.length > 0);
  }

  /* ---- Bennetts / location='' IS included — no pull-owned filtering ----- */
  // The inverse of a defect caught in review: greenbean/Bennetts does NOT
  // write Summary, it ingests Suppliers rows, so its vendor-named row is the
  // DERIVED OUTPUT of aggregateSupplierRows_ and must be healed like any other.
  seed([sup('2026-07-08', 'Bennetts', 14219, 'B1', '')], []);
  {
    const plan = computeHealPlan_(['2026-07-06'], buildCtx());
    eq('action is heal', plan[0].action, 'heal');
    eq('the Bennetts location="" row IS included, proving no pull-owned filtering',
      plan[0].rows.length, 1);
    eq('...as a brand-new row for the full computed amount',
      [plan[0].rows[0].isNew, plan[0].rows[0].computed], [true, 14219]);
    eq('a brand-new row costs 0 setValue calls — it is appended, not updated',
      plan[0].projectedSetValues, 0);
  }

  /* ---- shopify_orderapp's online revenue row is structurally untouched -- */
  // aggregateSupplierRows_ drops channel='online' entirely (Code.gs:1710-1714)
  // because shopifyWeeklyPull writes that Summary row directly — so it can
  // never appear in the computed batch, and a heal must leave it alone rather
  // than treating it as missing/stale/orphaned.
  seed([], [sum('2026-07-06', 'shopify_orderapp', 'online', 900, 'Roastery', 'revenue')],
       { revenueRows: [['2026-07-08', 'Roastery', 'online', 'N/A', 900, 'O1', 'shopify_orderapp', TS]] });
  {
    const plan = computeHealPlan_(['2026-07-06'], buildCtx());
    eq('action is heal (nothing computed collides with the live row)', plan[0].action, 'heal');
    eq('the live shopify_orderapp online row produces NO write — it is untouched',
      plan[0].rows.length, 0);
  }

  /* ---- computeHealPlan_ performs ZERO writes ----------------------------- */
  seed([sup('2026-07-08', 'Kent Paper', 175.25, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100)]);
  {
    const writes = currentSS._writeLog.length;
    const rangeCallsBefore = currentSS.getSheetByName(SUMMARY_TAB).getRangeCalls().length;
    computeHealPlan_(['2026-07-06'], buildCtx());
    eq('zero appendRow/setValues calls', currentSS._writeLog.length, writes);
    eq('...and zero getRange (setValue) calls against Summary either',
      currentSS.getSheetByName(SUMMARY_TAB).getRangeCalls().length, rangeCallsBefore);
  }

  currentSS = savedSS;
})();

/* ------------------------------------------------------------------ */

// summary_audit.gs — previewSummaryHeal(): zero-arg editor entry point.
// Builds ctx (including the guarded `_archive` week Set) and calls
// computeHealPlan_ for the last 4 completed weeks. Read-only.
console.log('summary_audit.gs — previewSummaryHeal() (zero-arg editor entry point)');
(function testPreviewSummaryHeal() {
  const savedSS = currentSS;
  const TS = '2026-08-24T13:00:00+10:00';
  const NOW = '2026-08-24T02:00:00Z';   // Mon 24 Aug 2026 Sydney — wk-1 = 2026-08-17

  function seed(supplierRows, summaryRows, opts) {
    opts = opts || {};
    currentSS = makeSpreadsheet();
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    const rev = ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    (opts.revenueRows || []).forEach((r) => rev.appendRow(r));
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    (opts.archiveRows || []).forEach((r) => arch.appendRow(r));
  }
  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];
  const sum = (wk, supplier, loc, total) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, 'Cafe', 'spend'];

  /* ---- a Date-typed _archive date cell for wk-1 still triggers skip-split */
  seed([], [], { archiveRows: [sup('2026-08-19', 'Fresh and Chill', 50, 'F1', 'Leible North')] });
  withMockNow(NOW, function () {
    check('the fixture really does store the archive date cell as a Date object',
      currentSS.getSheetByName(ARCHIVE_TAB).getDataRange().getValues()[1][0] instanceof Date);
    const report = previewSummaryHeal();
    const wk1 = report.weeks.filter((w) => w.week === '2026-08-17')[0];
    eq('a Date-typed _archive row for wk-1 still triggers skip-split', wk1.action, 'skip-split');
  });

  /* ---- a blank _archive date does not seed a '' key and does not throw -- */
  seed([], [], { archiveRows: [['', 'X', 0, '', '', 'src', TS, 'Cafe']] });
  withMockNow(NOW, function () {
    let threw = false;
    let report = null;
    try { report = previewSummaryHeal(); } catch (e) { threw = true; }
    check('previewSummaryHeal does not throw on a blank archive date', !threw);
    check('...and no week is mis-flagged skip-split by a blank-date key collision',
      report !== null && report.weeks.every((w) => w.action !== 'skip-split'));
  });

  /* ---- the report names both projected-cost figures --------------------- */
  seed(
    [sup('2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York')],   // wk-1, stale by 75.25
    [sum('2026-08-17', 'Kent Paper', 'Leible York', 100)],
    { archiveRows: [
        sup('2025-01-06', 'Old Supplier', 10, 'O1', 'X'),
        sup('2025-01-07', 'Old Supplier', 20, 'O2', 'X'),
        sup('2025-01-08', 'Old Supplier', 30, 'O3', 'X')
      ] });
  withMockNow(NOW, function () {
    const writes = currentSS._writeLog.length;
    const report = previewSummaryHeal();
    eq('previewSummaryHeal writes NOTHING', currentSS._writeLog.length, writes);

    // step9 FIX2: the window is sized off summaryHealWindowSize_ (1 with the
    // kill switch off, the default here — no SUMMARY_HEAL_ENABLED set), not a
    // literal 4 — this used to hardcode the pre-fix (divergent) behavior.
    eq('reports exactly the heal window (1 week — kill switch off by default)',
      report.weeks.map((w) => w.week).sort(),
      ['2026-08-17']);

    const wk1 = report.weeks.filter((w) => w.week === '2026-08-17')[0];
    eq('wk-1 is a heal with the one stale row', wk1.action, 'heal');
    eq('...delta correctly quantified', wk1.rows[0].delta, 75.25);

    eq('projectedSetValues sums the whole window (2 per updated row, upsertRows_-style)',
      report.projectedSetValues, 2);

    eq('projectedOverrideCost is the _archive + Summary read size a single override call pays',
      report.projectedOverrideCost, 3 + 1);
  });

  /* ---- FIX 4b (review fix 2026-08-26, MINOR) — previewSummaryHeal is
   * documented "READ-ONLY … Writes nothing" but calls ensureSheet() for
   * Summary/_archive/Revenue, which INSERTS a sheet and writes a header row
   * when the tab is absent (Code.gs ensureSheet). The "writes NOTHING" test
   * above never catches this because its seed() pre-creates every tab
   * first. This constructs a spreadsheet where they genuinely do not exist
   * yet — previewSummaryHeal must use getSheetByName with null-guards
   * (the pattern summaryOrphanSweep_ already uses), not ensureSheet. */
  currentSS = makeSpreadsheet();   // only Suppliers/Sales exist by default
  withMockNow(NOW, function () {
    previewSummaryHeal();
    check('FIX4: previewSummaryHeal does not create the Summary tab',
      currentSS.getSheetByName(SUMMARY_TAB) === null);
    check('FIX4: previewSummaryHeal does not create the _archive tab',
      currentSS.getSheetByName(ARCHIVE_TAB) === null);
    check('FIX4: previewSummaryHeal does not create the Revenue tab',
      currentSS.getSheetByName(REVENUE_TAB) === null);
  });

  currentSS = savedSS;
})();

/* ------------------------------------------------------------------ */

// summary_audit.gs — auditSummaryDrift_(detail, minWeek): optional window.
// null/absent must audit every week exactly as today (14 existing tests +
// the manual auditSummaryDrift() entry point depend on the default).
console.log('summary_audit.gs — auditSummaryDrift_ minWeek window (opt-in)');
(function testAuditSummaryDriftWindow() {
  const savedSS = currentSS;
  const TS = '2026-08-24T13:00:00+10:00';
  const NOW = '2026-08-24T02:00:00Z';

  function seed(supplierRows, summaryRows) {
    currentSS = makeSpreadsheet();
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
  }
  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];

  /* ---- null is byte-identical to omitting the argument ------------------ */
  seed(
    [sup('2026-02-25', 'Kent Paper', 200, 'K1', 'X'),
     sup('2026-07-08', 'Kent Paper', 300, 'K2', 'Y')],
    []);
  withMockNow(NOW, function () {
    const unwindowed = auditSummaryDrift_(false);
    const explicitNull = auditSummaryDrift_(false, null);
    eq('a null minWeek is byte-identical to omitting it entirely',
      JSON.stringify(explicitNull), JSON.stringify(unwindowed));
  });

  /* ---- a supplied minWeek excludes earlier weeks ------------------------- */
  seed(
    [sup('2026-02-25', 'Kent Paper', 200, 'K1', 'X'),
     sup('2026-07-08', 'Kent Paper', 300, 'K2', 'Y')],
    []);
  withMockNow(NOW, function () {
    const windowed = auditSummaryDrift_(false, '2026-03-01');
    eq('the week before minWeek is excluded', windowed.weeks.map((w) => w.week), ['2026-07-06']);
    eq('...and weeksAudited only counts the included week', windowed.weeksAudited, 1);
  });

  /* ---- the boundary week itself is INCLUDED (on/after, not strictly after) */
  seed([sup('2026-03-03', 'Kent Paper', 200, 'K1', 'X')], []);
  withMockNow(NOW, function () {
    const boundary = weekStartForDate_('2026-03-03');
    const windowed = auditSummaryDrift_(false, boundary);
    eq('the boundary week itself is included', windowed.weeks.map((w) => w.week), [boundary]);
  });

  currentSS = savedSS;
})();

/* ------------------------------------------------------------------ */

// summary_drift_repair.gs — TEMPORARY, goes when the file does.
//
// Closes the Summary drift for the weeks a re-summarize can still rebuild.
// The assertion that carries this whole file is the SPLIT-WEEK guard:
// weeklySummarize recomputes from Suppliers ONLY and Summary now UPSERTS, so
// re-summarizing a week whose rows straddle the archive cutoff overwrites the
// live Summary row with a partial total — turning missing money into
// UNDERSTATED money, which hides better than the gap it replaced.
console.log('summary_drift_repair.gs — safe re-summarize of drifted weeks');
(function testSummaryDriftRepair() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const savedWeekly = globalThis.weeklySummarize;
  const savedBudget = SUMMARY_REPAIR_TIME_BUDGET_MS_;

  const TS = '2026-08-24T13:00:00+10:00';
  const NOW = '2026-08-24T02:00:00Z';   // Mon 24 Aug 2026, 12:00 Sydney

  function seed(supplierRows, summaryRows, archiveRows) {
    currentSS = makeSpreadsheet();
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    (archiveRows || []).forEach((r) => arch.appendRow(r));
  }
  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];
  const sum = (wk, supplier, loc, total) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, 'Cafe', 'spend'];

  /* ---- all four classifications in one sheet --------------------------- */
  //  2026-08-10  rebuildable — source entirely in Suppliers, Summary has none
  //  2026-08-03  archived    — source entirely in _archive
  //  2026-07-27  SPLIT       — source in BOTH, and the Summary row is stale
  //  2026-07-20  orphan-only — a Summary row with no source at all
  function seedFourBuckets() {
    seed(
      [sup('2026-08-12', 'Kent Paper', 100, 'K1', 'Leible York'),
       sup('2026-07-29', 'Butterboy', 200, 'B1', 'Leible York')],        // split: live half
      [sum('2026-07-27', 'Butterboy', 'Leible York', 250),               // stale — real is 500
       sum('2026-07-20', 'Ghost Supplier', 'Leible York', 999)],         // orphan
      [sup('2026-08-05', 'Fresh and Chill', 300, 'F1', 'Leible North'),  // fully archived week
       sup('2026-07-30', 'Butterboy', 300, 'B2', 'Leible York')]         // split: archived half
    );
  }

  seedFourBuckets();
  withMockNow(NOW, function () {
    const writes = currentSS._writeLog.length;
    const plan = summaryDriftRepairPlan_();
    eq('planning writes NOTHING', currentSS._writeLog.length, writes);

    eq('exactly one week is rebuildable', plan.repair.length, 1);
    eq('...and it is the Suppliers-only week', plan.repair[0].week, '2026-08-10');
    eq('...its money is claimed', plan.repairMoney, 100);
    eq('the other three are skipped', plan.skipped.length, 3);

    const by = {};
    plan.skipped.forEach((s) => { by[s.week] = s; });

    // THE GUARD. This week has 200 in Suppliers and 300 in _archive; the live
    // Summary row says 250. A re-summarize would recompute 200 from Suppliers
    // alone and upsert it, dragging a row that was merely stale DOWN below what
    // it already reported. Missing money is visible; understated money is not.
    check('a SPLIT week is refused', by['2026-07-27'] !== undefined);
    check('...naming the split as the reason',
      by['2026-07-27'].reason.indexOf('SPLIT') !== -1);
    check('...and it is NOT in the repair list',
      plan.repair.every((r) => r.week !== '2026-07-27'));
    check('...the audit alone would have called it fixable',
      by['2026-07-27'].inSuppliers === true && by['2026-07-27'].inArchive === true);

    check('a fully-archived week is skipped for the purge line',
      by['2026-08-03'].reason.indexOf('purge line') !== -1);
    check('an orphan-only week is skipped — a recompute has no delete path',
      by['2026-07-20'].reason.indexOf('orphan-only') !== -1);
  });

  /* ---- the split week is the destructive case, not merely a no-op ------- */
  // Proves the fixture really is dangerous: recomputing from Suppliers alone
  // yields LESS than the figure already sitting in Summary.
  seedFourBuckets();
  withMockNow(NOW, function () {
    const suppOnly = currentSS.getSheetByName(SUPPLIERS_TAB).getDataRange().getValues().slice(1);
    const recomputed = aggregateSupplierRows_(suppOnly, '2026-07-27', '2026-08-02', 'spend');
    eq('a Suppliers-only recompute of the split week yields the partial total',
      recomputed[0].total, 200);
    check('...which is LOWER than what Summary already reports (250)',
      recomputed[0].total < 250);
  });

  /* ---- the approved window bounds the repair --------------------------- */
  // Without this, runSummaryDriftRepair() would write every rebuildable week —
  // after the 2026-08-25 backfill that is 136 weeks / $237k, not the 17-week
  // block that was actually approved.
  eq('the window opens at the approved week', SUMMARY_REPAIR_MIN_WEEK_, '2026-02-23');

  seed([sup('2026-02-25', 'Kent Paper', 100, 'K1', 'X'),   // inside, just
        sup('2026-02-18', 'Kent Paper', 200, 'K2', 'X'),   // outside, just
        sup('2024-06-05', 'Kent Paper', 900, 'K3', 'X')],  // long outside
       [], []);
  withMockNow(NOW, function () {
    const plan = summaryDriftRepairPlan_();
    eq('only the in-window week is repaired', plan.repair.map((r) => r.week), ['2026-02-23']);
    eq('...and only its money is claimed', plan.repairMoney, 100);
    const by = {};
    plan.skipped.forEach((s) => { by[s.week] = s; });
    check('the week one before the boundary is out of scope',
      by['2026-02-16'].reason.indexOf('outside the approved window') === 0);
    check('...as is the 2024 history',
      by['2024-06-03'].reason.indexOf('outside the approved window') === 0);
    eq('...and their money is NOT claimed', plan.skippedMoney, 1100);
  });

  // The boundary week itself must be INSIDE. Off-by-one here silently drops
  // 2026-02-23 — the week the audit named as next to fall past the purge line.
  seed([sup('2026-02-23', 'Kent Paper', 50, 'K1', 'X')], [], []);
  withMockNow(NOW, function () {
    eq('the boundary week is inside the window',
      summaryDriftRepairPlan_().repair.map((r) => r.week), ['2026-02-23']);
  });

  // A SPLIT week outside the window must still read as SPLIT, not as merely
  // out of scope — the hazard label has to survive wherever the week falls.
  seed([sup('2025-06-11', 'Butterboy', 200, 'B1', 'X')],
       [sum('2025-06-09', 'Butterboy', 'X', 250)],
       [sup('2025-06-12', 'Butterboy', 300, 'B2', 'X')]);
  withMockNow(NOW, function () {
    const plan = summaryDriftRepairPlan_();
    eq('nothing is repaired', plan.repair.length, 0);
    check('an out-of-window SPLIT week is still labelled SPLIT',
      plan.skipped[0].reason.indexOf('SPLIT') !== -1);
  });

  /* ---- repairable weeks are attempted oldest-first --------------------- */
  function seedThreeRepairable() {
    seed([sup('2026-08-12', 'Kent Paper', 100, 'K1', 'X'),
          sup('2026-08-05', 'Kent Paper', 200, 'K2', 'X'),
          sup('2026-07-29', 'Kent Paper', 300, 'K3', 'X')], [], []);
  }

  seedThreeRepairable();
  withMockNow(NOW, function () {
    const plan = summaryDriftRepairPlan_();
    eq('all three are rebuildable', plan.repair.length, 3);
    eq('...oldest first', plan.repair.map((r) => r.week),
      ['2026-07-27', '2026-08-03', '2026-08-10']);
    eq('...with the money summed', plan.repairMoney, 600);
  });

  /* ---- the dry run is genuinely read-only ------------------------------ */
  seedThreeRepairable();
  withMockNow(NOW, function () {
    const called = [];
    globalThis.weeklySummarize = function (w) { called.push(w); return { weekStart: w }; };
    const writes = currentSS._writeLog.length;
    runSummaryDriftRepairDryRun();
    eq('the dry run never calls weeklySummarize', called.length, 0);
    eq('...and writes nothing', currentSS._writeLog.length, writes);
    globalThis.weeklySummarize = savedWeekly;
  });

  /* ---- applying calls ONLY the repairable weeks ------------------------ */
  seedFourBuckets();
  withMockNow(NOW, function () {
    const called = [];
    globalThis.weeklySummarize = function (week) {
      called.push(week);
      return { weekStart: week, weekEnd: 'x', summariesAdded: 1, summariesUpdated: 0 };
    };
    const res = runSummaryDriftRepair();
    eq('only the rebuildable week is summarized', called, ['2026-08-10']);
    eq('...reported ok', res.ok, 1);
    eq('...none failed', res.failed, 0);
    globalThis.weeklySummarize = savedWeekly;
  });

  /* ---- "no error" is NOT success -------------------------------------- */
  seedThreeRepairable();
  withMockNow(NOW, function () {
    // Lock contention (Code.gs) returns this, carrying NEITHER count field.
    globalThis.weeklySummarize = function () { return { refused: 'locked' }; };
    let res = runSummaryDriftRepair();
    eq('a locked refusal fails every week', res.failed, 3);
    eq('...and none are counted ok', res.ok, 0);
    eq('...with the reason surfaced', res.results[0].refused, 'locked');

    // Incomplete week returns summariesAdded:0 and NO summariesUpdated — so
    // `added + updated` is NaN, which is why the shape is asserted, not counts.
    globalThis.weeklySummarize = function (week) {
      return { weekStart: week, weekEnd: 'x', refused: 'incomplete-week', summariesAdded: 0 };
    };
    res = runSummaryDriftRepair();
    eq('an incomplete-week refusal fails despite carrying weekStart', res.failed, 3);

    // The subtle one: it summarized a DIFFERENT week than asked. That is
    // exactly what the bare no-arg form does — it silently does last week.
    globalThis.weeklySummarize = function () {
      return { weekStart: '2026-08-10', weekEnd: 'x', summariesAdded: 3, summariesUpdated: 0 };
    };
    res = runSummaryDriftRepair();
    eq('a week that summarized the WRONG week is not ok', res.ok, 1);
    check('...only the one that genuinely matches',
      res.results.filter((r) => r.ok)[0].week === '2026-08-10');

    // upsertRows_ counts an unchanged amount as duplicatesSkipped, so a CORRECT
    // idempotent second run returns 0 added / 0 updated. Counts would misread it.
    globalThis.weeklySummarize = function (week) {
      return { weekStart: week, weekEnd: 'x', summariesAdded: 0, summariesUpdated: 0 };
    };
    res = runSummaryDriftRepair();
    eq('a 0/0 idempotent re-run is SUCCESS, not failure', res.ok, 3);

    globalThis.weeklySummarize = function () { return null; };
    res = runSummaryDriftRepair();
    eq('a null return fails rather than throwing', res.failed, 3);

    globalThis.weeklySummarize = savedWeekly;
  });

  /* ---- the time budget stops cleanly and says what is left ------------- */
  seedThreeRepairable();
  withMockNow(NOW, function () {
    const called = [];
    globalThis.weeklySummarize = function (w) { called.push(w); return { weekStart: w }; };
    SUMMARY_REPAIR_TIME_BUDGET_MS_ = -1;          // budget already blown
    const res = runSummaryDriftRepair();
    eq('nothing is attempted once the budget is gone', called.length, 0);
    check('...the run says it stopped early', res.stoppedEarly === true);
    eq('...and reports every week as still outstanding', res.remaining, 3);
    SUMMARY_REPAIR_TIME_BUDGET_MS_ = savedBudget;
    globalThis.weeklySummarize = savedWeekly;
  });

  /* ---- a clean sheet plans nothing ------------------------------------- */
  seed([sup('2026-08-12', 'Kent Paper', 100, 'K1', 'X')],
       [sum('2026-08-10', 'Kent Paper', 'X', 100)], []);
  withMockNow(NOW, function () {
    const plan = summaryDriftRepairPlan_();
    eq('no drift, nothing to repair', plan.repair.length, 0);
    eq('...and nothing skipped either', plan.skipped.length, 0);
  });

  /* ---- the plan log is readable in the editor -------------------------- */
  seedFourBuckets();
  withMockNow(NOW, function () {
    clearLoggedMessages();
    runSummaryDriftRepairDryRun();
    const log = lastLoggedMessages();
    check('logs line by line, not as one truncatable blob', log.length > 6);
    check('no line risks truncation', log.every((l) => String(l).length < 300));
    const joined = log.join('\n');
    check('the repair list is stated', joined.indexOf('REPAIR 2026-08-10') !== -1);
    check('every skip is stated with its week', joined.indexOf('SKIP   2026-07-27') !== -1);
    check('and it says plainly that nothing was written',
      joined.indexOf('DRY RUN — nothing was written') !== -1);
  });

  globalThis.weeklySummarize = savedWeekly;
  SUMMARY_REPAIR_TIME_BUDGET_MS_ = savedBudget;
  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// _archive awareness — the defect that made 24 weeks SPLIT.
//
// archiveAndPurge_ moves rows OUT of Suppliers, but upsertRows_ only ever sees
// the tab it writes to. So a re-ingest of an archived invoice reads as brand
// new and gets appended again: the same invoice_ref in both tabs, counted twice
// by every reader that reconstructs history from Suppliers + _archive.
console.log('_archive dedup — ingest awareness, audit dedup, duplicate census');
(function testArchiveDedup() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-25T09:00:00+10:00';
  const NOW = '2026-08-25T02:00:00Z';

  // normalizeSupplierRow's input shape, so the ingest path is exercised whole.
  const raw = (date, supplier, total, ref, loc) => ({
    date: date, supplier: supplier, total: total, invoice_ref: ref, location: loc,
  });

  function fresh(archiveRows) {
    currentSS = makeSpreadsheet();
    ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    (archiveRows || []).forEach((r) => arch.appendRow(r));
    return currentSS.getSheetByName(SUPPLIERS_TAB);
  }

  /* ---- an already-archived invoice is NOT re-appended ------------------ */
  (function () {
    const supp = fresh([
      ['2026-01-07', 'Butterboy', 300, 'INV-1', 'Leible York', 'ordermentum', TS, 'Cafe'],
    ]);
    const res = ingestSupplierRows('ordermentum',
      [raw('2026-01-07', 'Butterboy', 300, 'INV-1', 'Leible York')], TS, supp);

    eq('the archived invoice is not added to Suppliers', res.rowsAdded, 0);
    eq('...it is counted, not silently dropped', res.archivedSkipped, 1);
    eq('...and Suppliers stays empty',
      supp.getDataRange().getValues().length, 1);   // header only
  })();

  /* ---- a genuinely new invoice still lands ----------------------------- */
  (function () {
    const supp = fresh([
      ['2026-01-07', 'Butterboy', 300, 'INV-1', 'Leible York', 'ordermentum', TS, 'Cafe'],
    ]);
    const res = ingestSupplierRows('ordermentum', [
      raw('2026-01-07', 'Butterboy', 300, 'INV-1', 'Leible York'),   // archived
      raw('2026-08-24', 'Butterboy', 150, 'INV-9', 'Leible York'),   // new
    ], TS, supp);

    eq('the new invoice is added', res.rowsAdded, 1);
    eq('...and only the archived one is skipped', res.archivedSkipped, 1);
    eq('...Suppliers holds exactly the new row',
      supp.getDataRange().getValues()[1][3], 'INV-9');
  })();

  /* ---- the archive check is keyed on source+ref, like every other dedup - */
  (function () {
    const supp = fresh([
      ['2026-01-07', 'Butterboy', 300, 'INV-1', 'Leible York', 'ordermentum', TS, 'Cafe'],
    ]);
    // Same invoice_ref, DIFFERENT source — a different invoice, must land.
    const res = ingestSupplierRows('fresh_and_chill',
      [raw('2026-01-07', 'Fresh and Chill', 80, 'INV-1', 'Leible York')], TS, supp);
    eq('same ref under a different source is not an archive hit', res.rowsAdded, 1);
    eq('...nothing skipped', res.archivedSkipped, 0);
  })();

  /* ---- no _archive tab at all must not throw --------------------------- */
  (function () {
    currentSS = makeSpreadsheet();
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    const res = ingestSupplierRows('ordermentum',
      [raw('2026-08-24', 'Butterboy', 150, 'INV-9', 'Leible York')], TS, supp);
    eq('ingest works with no _archive tab', res.rowsAdded, 1);
    eq('...and reports zero archived skips', res.archivedSkipped, 0);
  })();

  /* ---- the audit no longer double-counts a split invoice --------------- */
  // THE MEASUREMENT BUG. Before this, an invoice in both tabs was summed twice,
  // inflating the reported drift on exactly the weeks that were hardest to fix.
  (function () {
    currentSS = makeSpreadsheet();
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);

    const row = ['2026-01-07', 'Butterboy', 300, 'INV-1', 'Leible York', 'ordermentum', TS, 'Cafe'];
    supp.appendRow(row);
    arch.appendRow(row);            // the SAME invoice, in both tabs

    withMockNow(NOW, function () {
      const r = auditSummaryDrift();
      eq('the duplicated invoice is counted ONCE, not twice', r.netUnderreported, 300);
    });
  })();

  (function () {
    // An archived invoice that is NOT in Suppliers must still be counted.
    currentSS = makeSpreadsheet();
    ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    arch.appendRow(['2026-01-07', 'Butterboy', 300, 'INV-1', 'Leible York', 'ordermentum', TS, 'Cafe']);
    withMockNow(NOW, function () {
      eq('an archive-only invoice is still counted', auditSummaryDrift().netUnderreported, 300);
    });
  })();

  (function () {
    // _archive holds REPEATED copies of the same invoice, and an invoice that
    // never returned to Suppliers appears N times in archRows alone. The first
    // version of the dedup only marked keys seen while walking Suppliers, so
    // every archive-only copy survived — the audit still over-reported by
    // $32,747.64 on production, and those weeks' drift never moved.
    currentSS = makeSpreadsheet();
    ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    const r = ['2026-01-07', 'Butterboy', 300, 'INV-1', 'Leible York', 'ordermentum', TS, 'Cafe'];
    for (let i = 0; i < 6; i++) arch.appendRow(r);   // six copies, none in Suppliers
    withMockNow(NOW, function () {
      eq('six ARCHIVE-ONLY copies count as one invoice, not six',
        auditSummaryDrift().netUnderreported, 300);
    });
  })();

  (function () {
    // The direct unit check on the helper, both duplication shapes at once.
    const row = (ref, amt) =>
      ['2026-01-07', 'B', amt, ref, 'X', 'ordermentum', TS, 'Cafe'];
    const out = auditDedupeSourceRows_(
      [row('A', 10)],                                  // Suppliers
      [row('A', 10), row('B', 20), row('B', 20), row('B', 20)]);
    eq('one row per distinct invoice, across BOTH tabs', out.length, 2);
  })();

  (function () {
    // Blank-key rows must NEVER collapse onto each other — they would all
    // share the key '||' and silently delete real money from the recompute.
    const blankA = ['2026-01-07', 'A', 100, '', 'X', '', TS, 'Cafe'];
    const blankB = ['2026-01-08', 'B', 250, '', 'Y', '', TS, 'Cafe'];
    const out = auditDedupeSourceRows_([blankA], [blankB]);
    eq('two empty-key rows both survive dedup', out.length, 2);
  })();

  /* ---- the duplicate census prices EVERY copy -------------------------- */
  // The first version counted one row per Suppliers invoice with an archived
  // twin. That under-reported the real over-count by 4.5x on production
  // ($4,520.34 vs $20,624.23) because _archive can hold the SAME invoice many
  // times over — archiveAndPurge_ appends without deduping.
  (function () {
    currentSS = makeSpreadsheet();
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);

    const dup1 = ['2026-01-07', 'Butterboy', 300, 'INV-1', 'Leible York', 'ordermentum', TS, 'Cafe'];
    const onlySupp = ['2026-08-24', 'Butterboy', 999, 'INV-9', 'Leible York', 'ordermentum', TS, 'Cafe'];
    const onlyArch = ['2025-01-06', 'Butterboy', 777, 'INV-0', 'Leible York', 'ordermentum', TS, 'Cafe'];

    supp.appendRow(dup1);
    supp.appendRow(onlySupp);
    // SIX archive copies — the production shape for the 2025 weeks.
    for (let i = 0; i < 6; i++) arch.appendRow(dup1);
    arch.appendRow(onlyArch);

    const out = auditArchiveDuplicates();
    eq('one invoice is stored more than once', out.duplicateInvoices, 1);
    eq('...with six redundant copies (7 total, minus the one real)', out.excessRows, 6);
    eq('...and the deepest stack is reported', out.maxCopies, 7);
    eq('...the over-count prices EVERY extra copy, not just one', out.overCount, 1800);
    eq('...grouped by week', out.weeksAffected, 1);
  })();

  (function () {
    // Duplicates living ONLY in _archive still over-count a naive reader.
    currentSS = makeSpreadsheet();
    ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    const r = ['2025-01-06', 'Butterboy', 250, 'INV-5', 'Leible York', 'ordermentum', TS, 'Cafe'];
    arch.appendRow(r); arch.appendRow(r);
    const out = auditArchiveDuplicates();
    eq('an archive-only duplicate is caught', out.duplicateInvoices, 1);
    eq('...priced once', out.overCount, 250);
  })();

  (function () {
    currentSS = makeSpreadsheet();
    ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    const writes = currentSS._writeLog.length;
    const out = auditArchiveDuplicates();
    eq('a clean sheet reports no duplicates', out.duplicateInvoices, 0);
    eq('...no over-count', out.overCount, 0);
    eq('...and the census writes NOTHING', currentSS._writeLog.length, writes);
  })();

  /* ---- archiveAndPurge_ never stores a second copy --------------------- */
  // This is the step that MULTIPLIES the duplication: every re-ingest-then-
  // purge cycle used to add another archive copy, forever.
  (function () {
    currentSS = makeSpreadsheet();
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    const row = ['2025-01-06', 'Butterboy', 250, 'INV-5', 'Leible York', 'ordermentum', TS, 'Cafe'];
    arch.appendRow(row);        // already archived once
    supp.appendRow(row);        // and re-ingested since

    const n = archiveAndPurge_(supp, arch, '2026-02-23');
    eq('it is not archived a second time', n, 0);
    eq('..._archive still holds exactly one copy',
      arch.getDataRange().getValues().length, 2);   // header + 1
    eq('...but the Suppliers row is still purged',
      supp.getDataRange().getValues().length, 1);   // header only
  })();

  (function () {
    // A genuinely new old row must still be archived normally.
    currentSS = makeSpreadsheet();
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    supp.appendRow(['2025-01-06', 'Butterboy', 250, 'INV-5', 'Leible York', 'ordermentum', TS, 'Cafe']);
    const n = archiveAndPurge_(supp, arch, '2026-02-23');
    eq('an unarchived old row IS archived', n, 1);
    eq('..._archive holds it', arch.getDataRange().getValues().length, 2);
  })();

  (function () {
    // Two copies of the same invoice inside ONE purge run must not both land.
    currentSS = makeSpreadsheet();
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    const row = ['2025-01-06', 'Butterboy', 250, 'INV-5', 'Leible York', 'ordermentum', TS, 'Cafe'];
    supp.appendRow(row); supp.appendRow(row);
    archiveAndPurge_(supp, arch, '2026-02-23');
    eq('within-run duplicates collapse to one archive row',
      arch.getDataRange().getValues().length, 2);
  })();

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// Code.gs — healWeek_(week, ctx): the guarded per-week write. Every gate
// (SPLIT skip, duplicate-key refusal, snapshot-once backup, correction alert)
// lives here so the scheduled path and every override caller (greenBeanPull_
// included) share exactly one write path — PRD-12.
//
// ctx extends computeHealPlan_'s ctx (step 0: archiveWeeks/summaryRows/
// supplierRows/revenueRows) with the sheet refs and write-side bookkeeping
// healWeek_ needs (summSheet, backupSheet, backedUpWeeks, runId, extractedAt).
// Built ONCE by the caller here, exactly like healWeeks_ must build it once
// per entry point — see testHealWeeksOrchestration below for the multi-week
// version of that same rule.
console.log('Code.gs — healWeek_ (guarded per-week write: backup, SPLIT guard, duplicate refusal, correction alert)');
(function testHealWeekGuardsAndBackup() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-24T13:00:00+10:00';

  function seed(supplierRows, summaryRows, opts) {
    opts = opts || {};
    currentSS = makeSpreadsheet();
    scriptProps = {};
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    const rev = ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    (opts.revenueRows || []).forEach((r) => rev.appendRow(r));
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    (opts.archiveRows || []).forEach((r) => arch.appendRow(r));
    ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  }
  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];
  const sum = (wk, supplier, loc, total, dept, kind) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, dept || 'Cafe', kind || 'spend'];

  function buildCtx(opts) {
    opts = opts || {};
    const suppSheet = currentSS.getSheetByName(SUPPLIERS_TAB);
    const archSheet = currentSS.getSheetByName(ARCHIVE_TAB);
    const summSheet = currentSS.getSheetByName(SUMMARY_TAB);
    const revSheet = currentSS.getSheetByName(REVENUE_TAB);
    const backupSheet = ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
    const archRows = archSheet ? archSheet.getDataRange().getValues().slice(1) : [];
    const archiveWeeks = {};
    archRows.forEach((r) => {
      const d = coerceDateStr_(r[0]);
      if (DATE_ARG_RE.test(d)) archiveWeeks[weekStartForDate_(d)] = true;
    });
    const backupRows = backupSheet.getDataRange().getValues().slice(1);
    const backedUpWeeks = {};
    backupRows.forEach((r) => { backedUpWeeks[coerceDateStr_(r[0])] = true; });
    return {
      archiveWeeks: archiveWeeks,
      summaryRows: summSheet.getDataRange().getValues(),
      supplierRows: suppSheet ? suppSheet.getDataRange().getValues().slice(1) : [],
      revenueRows: revSheet ? revSheet.getDataRange().getValues().slice(1) : [],
      summSheet: summSheet,
      backupSheet: backupSheet,
      backedUpWeeks: backedUpWeeks,
      runId: opts.runId || 'RUN-TEST-1',
      extractedAt: opts.extractedAt || TS
    };
  }

  /* ---- SPLIT guard: skip, write nothing, back up, alert ----------------- */
  seed([sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100)],
       { archiveRows: [sup('2026-07-09', 'Fresh and Chill', 50, 'F1', 'Leible North')] });
  {
    calendarEvents = [];
    const before = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    const res = healWeek_('2026-07-06', buildCtx());
    eq('SPLIT week action is skip-split', res.action, 'skip-split');
    eq('SPLIT week: Summary is byte-identical afterwards',
      JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()),
      JSON.stringify(before));
    check('SPLIT week is still backed up', res.backedUp === true);
    check('SPLIT week raises an alert', calendarEvents.length >= 1);
  }

  /* ---- duplicate-key refusal: refuse, write nothing, alert -------------- */
  seed([sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100),
        sum('2026-07-06', '  KENT PAPER  ', 'leible york', 999)]);
  {
    calendarEvents = [];
    const before = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    const res = healWeek_('2026-07-06', buildCtx());
    eq('duplicate-key week is refused, not half-updated', res.action, 'refuse-duplicate-keys');
    eq('duplicate-key week: Summary is byte-identical afterwards',
      JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()),
      JSON.stringify(before));
    check('duplicate-key week raises an alert', calendarEvents.length >= 1);
  }

  /* ---- Bennetts / location='' IS healed — no pull-owned filtering ------- */
  seed([sup('2026-07-08', 'Bennetts', 14219, 'B1', '')], []);
  {
    const res = healWeek_('2026-07-06', buildCtx());
    eq('Bennetts (blank location) IS summarized', res.action, 'heal');
    eq('...one row added, proving no pull-owned filtering', res.rowsAdded, 1);
  }

  /* ---- shopify_orderapp online revenue row is untouched ----------------- */
  seed([], [sum('2026-07-06', 'shopify_orderapp', 'online', 900, 'Roastery', 'revenue')],
       { revenueRows: [['2026-07-08', 'Roastery', 'online', 'N/A', 900, 'O1', 'shopify_orderapp', TS]] });
  {
    const before = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    const res = healWeek_('2026-07-06', buildCtx());
    eq('action is heal (nothing computed collides)', res.action, 'heal');
    eq('zero rows written — the online row is untouched', res.rowsAdded + res.rowsUpdated, 0);
    eq('Summary is byte-identical',
      JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()),
      JSON.stringify(before));
  }

  /* ---- backup is written before any setValue for that week -------------- */
  seed([sup('2026-07-08', 'Kent Paper', 175.25, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100)]);
  {
    clearWriteOrderLog();
    healWeek_('2026-07-06', buildCtx());
    const order = getWriteOrderLog();
    const backupIdx = order.findIndex((o) => o.sheet === SUMMARY_HEAL_BACKUP_TAB);
    const summarySetIdx = order.findIndex((o) => o.sheet === SUMMARY_TAB && o.type === 'setValue');
    check('a backup write happened', backupIdx !== -1);
    check('a Summary setValue happened (this is the update case)', summarySetIdx !== -1);
    check('the backup was written strictly before the Summary setValue',
      backupIdx !== -1 && summarySetIdx !== -1 && backupIdx < summarySetIdx);
  }

  /* ---- backup idempotency: healing the same week twice keeps the FIRST -- */
  seed([sup('2026-07-08', 'Kent Paper', 175.25, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100)]);
  {
    healWeek_('2026-07-06', buildCtx());   // first heal: 100 -> 175.25, backs up the ORIGINAL 100
    const backupAfterFirst = currentSS.getSheetByName(SUMMARY_HEAL_BACKUP_TAB)
      .getDataRange().getValues().filter((r) => coerceDateStr_(r[0]) === '2026-07-06');
    eq('first heal snapshots exactly one row (the pre-heal 100)', backupAfterFirst.length, 1);
    eq('...carrying the PRE-heal total', backupAfterFirst[0][4], 100);

    // Second heal of the SAME week (e.g. re-run) must NOT append a second
    // snapshot, even though the live total has now moved to 175.25.
    healWeek_('2026-07-06', buildCtx());
    const backupAfterSecond = currentSS.getSheetByName(SUMMARY_HEAL_BACKUP_TAB)
      .getDataRange().getValues().filter((r) => coerceDateStr_(r[0]) === '2026-07-06');
    eq('a second heal of the same week does not add a second snapshot',
      backupAfterSecond.length, 1);
    eq('...the ORIGINAL pre-heal value survives, not the post-heal one',
      backupAfterSecond[0][4], 100);
  }

  /* ---- correction alert: loud when something changed, silent when not --- */
  seed([sup('2026-07-08', 'Kent Paper', 175.25, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100)]);
  {
    calendarEvents = [];
    const res = healWeek_('2026-07-06', buildCtx());
    check('a genuine correction (100 -> 175.25) raises an alert', calendarEvents.length >= 1);
    check('...naming the week',
      calendarEvents[calendarEvents.length - 1]._title.indexOf('2026-07-06') !== -1);
    eq('...and the update is reported', res.updates.length, 1);
  }
  seed([sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100)]);
  {
    calendarEvents = [];
    const res = healWeek_('2026-07-06', buildCtx());
    eq('an idempotent re-heal (nothing changed) reports zero updates', res.updates.length, 0);
    eq('...and raises NO alert', calendarEvents.length, 0);
  }

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// Code.gs — healEarliestBackupRows_: pure. Given Summary_heal_backup rows
// (possibly holding more than one snapshot for a week, which the write-once
// guard above is meant to prevent but a restore must still defend against),
// returns only the EARLIEST snapshot's rows for that week — never a later one.
console.log('Code.gs — healEarliestBackupRows_ (restore resolves to the earliest snapshot)');
(function testHealEarliestBackupRows() {
  const TS = '2026-08-24T13:00:00+10:00';
  const row = (wk, supplier, loc, total, runId) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, 'Cafe', 'spend', runId];

  const rows = [
    row('2026-07-06', 'Kent Paper', 'Leible York', 100, 'RUN-1'),     // earliest — must win
    row('2026-07-06', 'Kent Paper', 'Leible York', 175.25, 'RUN-2'),  // later, corrupted-order artifact
    row('2026-06-29', 'Fresh and Chill', 'Leible North', 50, 'RUN-1'), // a different week entirely
  ];

  const earliest = healEarliestBackupRows_(rows, '2026-07-06');
  eq('exactly one row resolves for the week', earliest.length, 1);
  eq('...the FIRST (earliest) snapshot, not the later one', earliest[0][4], 100);
  eq('...tagged with the earliest run_id', earliest[0][8], 'RUN-1');

  const other = healEarliestBackupRows_(rows, '2026-06-29');
  eq('a different week resolves independently', other.length, 1);
  eq("...unaffected by the other week's duplicate", other[0][4], 50);

  eq('an absent week resolves to nothing', healEarliestBackupRows_(rows, '2026-01-01').length, 0);
})();

/* ------------------------------------------------------------------ */

// Code.gs — healWeeks_(weeks): the entry both the scheduled run and every
// override caller (greenBeanPull_ included) now share. Builds ctx ONCE for
// the whole batch, processes newest-first regardless of input order, and
// treats a refused/skipped NEWEST week as a loud, run-level failure — a
// silently un-summarized current week is worse than a slightly wrong one.
console.log('Code.gs — healWeeks_ (shared entry: ctx-once, newest-first, newest-week failure is loud)');
(function testHealWeeksOrchestration() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-24T13:00:00+10:00';

  function seed(supplierRows, summaryRows, opts) {
    opts = opts || {};
    currentSS = makeSpreadsheet();
    scriptProps = {};
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    (opts.archiveRows || []).forEach((r) => arch.appendRow(r));
    ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  }
  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];
  const sum = (wk, supplier, loc, total) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, 'Cafe', 'spend'];

  /* ---- ctx built ONCE: a 5-week batch reads _archive exactly once ------- */
  seed(
    [sup('2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York'),
     sup('2026-08-12', 'Kent Paper', 200, 'K2', 'Leible York'),
     sup('2026-08-05', 'Kent Paper', 300, 'K3', 'Leible York'),
     sup('2026-07-29', 'Kent Paper', 400, 'K4', 'Leible York'),
     sup('2026-07-22', 'Kent Paper', 500, 'K5', 'Leible York')],
    []);
  {
    const archBefore = currentSS.getSheetByName(ARCHIVE_TAB).getDataRangeCallCount();
    const weeks = ['2026-08-17', '2026-08-10', '2026-08-03', '2026-07-27', '2026-07-20'];
    healWeeks_(weeks);
    eq('a 5-week batch reads _archive exactly once, not five times',
      currentSS.getSheetByName(ARCHIVE_TAB).getDataRangeCallCount() - archBefore, 1);
  }

  /* ---- newest-first processing order, regardless of input order --------- */
  seed(
    [sup('2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York'),
     sup('2026-08-12', 'Fresh and Chill', 200, 'F2', 'Leible North')],
    [sum('2026-08-17', 'Kent Paper', 'Leible York', 100),
     sum('2026-08-10', 'Fresh and Chill', 'Leible North', 100)]);
  {
    // Deliberately passed OLDEST-first — healWeeks_ must reorder, not trust
    // caller order, so a mid-run death always leaves the MOST RECENT weeks
    // done regardless of how the caller happened to build the list.
    const res = healWeeks_(['2026-08-10', '2026-08-17']);
    eq('processed newest-first regardless of input order',
      res.weeks.map((w) => w.week), ['2026-08-17', '2026-08-10']);
  }

  /* ---- a refused/skipped NEWEST week is a loud, run-level failure -------- */
  seed(
    [sup('2026-08-12', 'Fresh and Chill', 300, 'F1', 'Leible North')],
    [sum('2026-08-17', 'Kent Paper', 'Leible York', 100),
     sum('2026-08-10', 'Fresh and Chill', 'Leible North', 250)],
    { archiveRows: [sup('2026-08-18', 'Kent Paper', 50, 'K9', 'Leible York')] }); // makes wk-1 SPLIT
  {
    calendarEvents = [];
    const res = healWeeks_(['2026-08-17', '2026-08-10']);
    const wk1 = res.weeks.filter((w) => w.week === '2026-08-17')[0];
    eq('the newest week is SPLIT', wk1.action, 'skip-split');
    eq('the run reports overall failure', res.success, false);
    check('newestWeekFailed is set', res.newestWeekFailed === true);
    const wk1Events = calendarEvents.filter((e) => e._title.indexOf('2026-08-17') !== -1);
    check('the newest-week alert is HIGH severity (RED)',
      wk1Events.some((e) => e._color === 'RED'));
  }

  /* ---- the SAME failure on an OLDER (non-newest) week is not high-severity */
  seed(
    [sup('2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York')],
    [sum('2026-08-17', 'Kent Paper', 'Leible York', 100),
     sum('2026-08-10', 'Fresh and Chill', 'Leible North', 250)],
    { archiveRows: [sup('2026-08-11', 'Fresh and Chill', 50, 'F9', 'Leible North')] }); // makes wk-2 SPLIT
  {
    calendarEvents = [];
    const res = healWeeks_(['2026-08-17', '2026-08-10']);
    const wk2 = res.weeks.filter((w) => w.week === '2026-08-10')[0];
    eq('the older week is SPLIT', wk2.action, 'skip-split');
    eq('the run still reports success — only the NEWEST week failing is fatal', res.success, true);
    const wk2Events = calendarEvents.filter((e) => e._title.indexOf('2026-08-10') !== -1);
    check("the older week's alert is NORMAL severity, not RED",
      wk2Events.length > 0 && wk2Events.every((e) => e._color !== 'RED'));
  }

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// Code.gs — weeklySummarize(): now routes through healWeeks_/healWeek_ for
// BOTH branches. Branch differences reduce to exactly two: week selection
// (kill switch) and archive/purge (scheduled only) — every safety gate is
// shared, which is what finally brings greenBeanPull_'s override writes
// under the same protection.
console.log('Code.gs — weeklySummarize() wired to the guarded heal path (kill switch, archive/purge, override parity)');
withHealUnfrozen(function testWeeklySummarizeGuardedIntegration() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const savedArchive = globalThis.archiveAndPurge_;
  const TS = '2026-08-24T13:00:00+10:00';
  const NOW = '2026-08-24T02:00:00Z';   // Mon 24 Aug 2026 Sydney — wk-1 = 2026-08-17
  const WK1 = '2026-08-17', WK2 = '2026-08-10', WK3 = '2026-08-03', WK4 = '2026-07-27', WK5 = '2026-07-20';

  function seed(supplierRows, summaryRows, opts) {
    opts = opts || {};
    currentSS = makeSpreadsheet();
    scriptProps = {};
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    (opts.archiveRows || []).forEach((r) => arch.appendRow(r));
    ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  }
  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];
  const sum = (wk, supplier, loc, total) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, 'Cafe', 'spend'];

  eq('SUMMARY_HEAL_WEEKS_ default window is 4', SUMMARY_HEAL_WEEKS_, 4);

  /* ---- kill switch OFF: window = 1 --------------------------------------- */
  seed(
    [sup('2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York'),
     sup('2026-08-12', 'Kent Paper', 200, 'K2', 'Leible York')],
    [sum(WK1, 'Kent Paper', 'Leible York', 100),
     sum(WK2, 'Kent Paper', 'Leible York', 100)]);
  withMockNow(NOW, function () {
    scriptProps = {};   // SUMMARY_HEAL_ENABLED absent — the documented default
    weeklySummarize();
    const summary = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    const wk1Row = summary.filter((r) => r[2] === 'Kent Paper' && coerceDateStr_(r[0]) === WK1)[0];
    const wk2Row = summary.filter((r) => r[2] === 'Kent Paper' && coerceDateStr_(r[0]) === WK2)[0];
    eq('switch OFF: wk-1 is healed', wk1Row[4], 175.25);
    eq('switch OFF: wk-2 is left untouched (window=1)', wk2Row[4], 100);
  });

  /* ---- kill switch OFF, but the gates are still active for wk-1 --------- */
  seed(
    [sup('2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York')],
    [sum(WK1, 'Kent Paper', 'Leible York', 100)],
    { archiveRows: [sup('2026-08-20', 'Fresh and Chill', 50, 'F1', 'Leible North')] });
  withMockNow(NOW, function () {
    scriptProps = {};
    const before = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    weeklySummarize();
    eq('switch OFF: a SPLIT wk-1 is STILL refused, not force-written',
      JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()),
      JSON.stringify(before));
  });

  /* ---- kill switch ON: full window, wk-5 untouched ----------------------- */
  seed(
    [sup('2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York'),
     sup('2026-08-12', 'Kent Paper', 200, 'K2', 'Leible York'),
     sup('2026-08-05', 'Kent Paper', 300, 'K3', 'Leible York'),
     sup('2026-07-29', 'Kent Paper', 400, 'K4', 'Leible York'),
     sup('2026-07-22', 'Kent Paper', 500, 'K5', 'Leible York')],
    [sum(WK1, 'Kent Paper', 'Leible York', 100),
     sum(WK2, 'Kent Paper', 'Leible York', 100),
     sum(WK3, 'Kent Paper', 'Leible York', 100),
     sum(WK4, 'Kent Paper', 'Leible York', 100),
     sum(WK5, 'Kent Paper', 'Leible York', 100)]);
  withMockNow(NOW, function () {
    scriptProps = { SUMMARY_HEAL_ENABLED: 'true' };
    weeklySummarize();
    const summary = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    const totalFor = (wk) => summary.filter((r) => r[2] === 'Kent Paper' && coerceDateStr_(r[0]) === wk)[0][4];
    eq('switch ON: wk-1 healed', totalFor(WK1), 175.25);
    eq('switch ON: wk-2 healed', totalFor(WK2), 200);
    eq('switch ON: wk-3 healed', totalFor(WK3), 300);
    eq('switch ON: wk-4 healed', totalFor(WK4), 400);
    eq('switch ON: wk-5 is OUTSIDE the window — untouched', totalFor(WK5), 100);
  });

  /* ---- archiveAndPurge_ runs exactly once on a scheduled run ------------- */
  seed(
    [sup('2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York')],
    [sum(WK1, 'Kent Paper', 'Leible York', 100)]);
  withMockNow(NOW, function () {
    scriptProps = { SUMMARY_HEAL_ENABLED: 'true' };
    let calls = 0;
    globalThis.archiveAndPurge_ = function () { calls++; return savedArchive.apply(null, arguments); };
    weeklySummarize();
    eq('archiveAndPurge_ runs exactly once for a 4-week scheduled heal, not once per week', calls, 1);
    globalThis.archiveAndPurge_ = savedArchive;
  });

  /* ---- archiveAndPurge_ never runs on an override ------------------------ */
  seed([sup('2025-01-06', 'Kent Paper', 100, 'K1', 'Leible York')], []);
  {
    let calls = 0;
    globalThis.archiveAndPurge_ = function () { calls++; return savedArchive.apply(null, arguments); };
    weeklySummarize('2025-01-06');
    eq('archiveAndPurge_ never runs on an override', calls, 0);
    globalThis.archiveAndPurge_ = savedArchive;
  }

  /* ---- override path gets the SAME gates as the scheduled path ---------- */
  // Make the override week ITSELF the SPLIT week and confirm it is refused
  // exactly like the scheduled path refuses a SPLIT wk-1 above.
  seed(
    [sup('2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York')],
    [sum(WK1, 'Kent Paper', 'Leible York', 100)],
    { archiveRows: [sup('2026-08-20', 'Fresh and Chill', 50, 'F1', 'Leible North')] });
  withMockNow(NOW, function () {
    scriptProps = {};
    calendarEvents = [];
    const before = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    const res = weeklySummarize(WK1);   // override, one-element list
    eq('override path: SPLIT week is refused too', res.refused, 'skip-split');
    eq('override path: Summary is byte-identical afterwards',
      JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()),
      JSON.stringify(before));
    check('override path raises the same alert the scheduled path would',
      calendarEvents.length >= 1);
  });

  /* ---- duplicate-key refusal via override -------------------------------- */
  seed(
    [sup('2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York')],
    [sum(WK1, 'Kent Paper', 'Leible York', 100),
     sum(WK1, '  KENT PAPER  ', 'leible york', 999)]);
  withMockNow(NOW, function () {
    scriptProps = {};
    const before = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    const res = weeklySummarize(WK1);
    eq('override path: duplicate keys refuse too', res.refused, 'refuse-duplicate-keys');
    eq('override path: Summary is byte-identical afterwards',
      JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()),
      JSON.stringify(before));
  });

  /* ---- correction alert: a LABOUR-only change still raises it ----------- */
  seed(
    [sup('2026-08-19', 'Kent Paper', 100, 'K1', 'Leible York')],  // unchanged vs Summary
    [sum(WK1, 'Kent Paper', 'Leible York', 100),
     sum(WK1, 'Labour', 'Leible York', 4000)]);
  scriptProps.LABOUR_SHEET_ID = 'labour-sheet-id';
  const labourSrc = currentSS.insertSheet('LABOUR_COST');
  labourSrc.appendRow(['week_start', 'week_end', 'location', 'total', 'iso_week', 'pulled_at']);
  labourSrc.appendRow([WK1, addDaysStr_(WK1, 6), 'Leible York', 4500.00, '2026-W33', 'x']); // labour CHANGED
  withMockNow(NOW, function () {
    calendarEvents = [];
    weeklySummarize(WK1);
    check('a labour-only correction (no Suppliers change) still raises an alert',
      calendarEvents.length >= 1);
    const summary = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    const labourRow = summary.filter((r) => r[2] === 'Labour' && coerceDateStr_(r[0]) === WK1)[0];
    eq('...and the labour figure actually moved', labourRow[4], 4500);
  });

  /* ---- silent when nothing changed: idempotent override re-run ---------- */
  // Mirrors greenBeanPull_'s own pattern (weeklySummarize(week) called again
  // for a week whose committed spend did not actually change this pull).
  seed([sup('2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York')], []);
  withMockNow(NOW, function () {
    scriptProps = {};
    weeklySummarize(WK1);              // first run: writes the row
    calendarEvents = [];               // only care about the SECOND, idempotent run
    weeklySummarize(WK1);              // greenbean-style re-summarize of an unchanged week
    eq('an idempotent re-summarize of an unchanged week raises NO alert',
      calendarEvents.length, 0);
  });

  currentSS = savedSS;
  scriptProps = savedProps;
  globalThis.archiveAndPurge_ = savedArchive;
});

/* ------------------------------------------------------------------ */

// Code.gs — healWeek_ orphan detection (Step 3, PRD-12): a heal that mints a
// NEW Summary key (a location/supplier/department rename) leaves the OLD
// key's row behind — upsertRows_ has no delete path, so that stale row
// survives and doGet serves the money twice. Detection lives INSIDE the
// guarded heal path so a mid-run death between the write and a separate
// audit can never lose the notice; it must never itself delete (Step 2's
// write path already forbids deletion here — this only ever REPORTS).
console.log('Code.gs — healWeek_ orphan detection (Step 3: automatic, read-only, rides the existing alert)');
(function testHealWeekOrphanDetection() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-25T09:00:00+10:00';

  function seed(supplierRows, summaryRows, opts) {
    opts = opts || {};
    currentSS = makeSpreadsheet();
    scriptProps = {};
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    const rev = ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    (opts.revenueRows || []).forEach((r) => rev.appendRow(r));
    ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  }
  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];
  const sum = (wk, supplier, loc, total, dept, kind) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, dept || 'Cafe', kind || 'spend'];

  function buildCtx(opts) {
    opts = opts || {};
    const suppSheet = currentSS.getSheetByName(SUPPLIERS_TAB);
    const archSheet = currentSS.getSheetByName(ARCHIVE_TAB);
    const summSheet = currentSS.getSheetByName(SUMMARY_TAB);
    const revSheet = currentSS.getSheetByName(REVENUE_TAB);
    const backupSheet = ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
    const archRows = archSheet ? archSheet.getDataRange().getValues().slice(1) : [];
    const archiveWeeks = {};
    archRows.forEach((r) => {
      const d = coerceDateStr_(r[0]);
      if (DATE_ARG_RE.test(d)) archiveWeeks[weekStartForDate_(d)] = true;
    });
    const backupRows = backupSheet.getDataRange().getValues().slice(1);
    const backedUpWeeks = {};
    backupRows.forEach((r) => { backedUpWeeks[coerceDateStr_(r[0])] = true; });
    return {
      archiveWeeks: archiveWeeks,
      summaryRows: summSheet.getDataRange().getValues(),
      supplierRows: suppSheet ? suppSheet.getDataRange().getValues().slice(1) : [],
      revenueRows: revSheet ? revSheet.getDataRange().getValues().slice(1) : [],
      summSheet: summSheet,
      backupSheet: backupSheet,
      backedUpWeeks: backedUpWeeks,
      runId: opts.runId || 'RUN-ORPHAN-TEST-1',
      extractedAt: opts.extractedAt || TS
    };
  }

  /* ---- 1. a location rename orphans the OLD key --------------------------
   * Suppliers now carries the invoice at 'New Shop'; live Summary still
   * holds the pre-rename row keyed on 'Old Shop'. The heal writes the NEW
   * key (an append, not an update) and must report the OLD one as an
   * orphan candidate — naming it, not deleting it. */
  seed([sup('2026-07-08', 'Kent Paper', 100, 'K1', 'New Shop')],
       [sum('2026-07-06', 'Kent Paper', 'Old Shop', 100)]);
  {
    calendarEvents = [];
    const summSheet = currentSS.getSheetByName(SUMMARY_TAB);
    const res = healWeek_('2026-07-06', buildCtx());
    eq('action is heal (a new location key is appended)', res.action, 'heal');
    eq('exactly one row added (the new location)', res.rowsAdded, 1);
    check('res.orphans is an array with exactly the ONE stale key',
      Array.isArray(res.orphans) && res.orphans.length === 1);
    if (Array.isArray(res.orphans) && res.orphans.length === 1) {
      const orphan = res.orphans[0];
      eq('orphan names the correct supplier', orphan.supplier, 'Kent Paper');
      eq('orphan names the OLD location, not the new one', orphan.location, 'Old Shop');
      eq('orphan carries the stale total', orphan.total, 100);
      check('orphan carries a full key encoding the OLD location',
        typeof orphan.key === 'string' && orphan.key.toLowerCase().indexOf('old shop') !== -1);
    }

    /* ---- 2. the automatic path never deletes ----------------------------- */
    eq('zero deleteRow calls on the automatic path', summSheet.getDeleteRowCalls().length, 0);
    check("the OLD Summary row is still there — detection didn't remove it",
      currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()
        .some((r) => r[2] === 'Kent Paper' && r[3] === 'Old Shop'));

    /* ---- 3. the orphan rides the SAME per-week alert as corrections ------ */
    const weekEvents = calendarEvents.filter((e) => e._title.indexOf('2026-07-06') !== -1);
    eq('exactly one alert fires for the week — the orphan is folded into it, not a second event',
      weekEvents.length, 1);
    check('...and its description mentions the orphan',
      weekEvents.length === 1 && weekEvents[0]._description.toLowerCase().indexOf('orphan') !== -1);
  }

  /* ---- 4. shopify_orderapp online revenue is NEVER reported as an orphan -
   * It is written directly to Summary by the order-app pull and has no
   * Revenue-tab backing at all — structurally unreachable from a
   * Suppliers/Revenue recompute, so it would ALWAYS look like an orphan to a
   * naive live-vs-computed sweep. Excluding it is mandatory (Prohibitions). */
  seed([], [sum('2026-07-06', 'shopify_orderapp', 'online', 900, 'Roastery', 'revenue')],
       { revenueRows: [] });
  {
    const res = healWeek_('2026-07-06', buildCtx());
    check('shopify_orderapp online row is excluded from orphan candidates',
      Array.isArray(res.orphans) && res.orphans.length === 0);
  }

  /* ---- 5. a derived Bennetts row (blank location) in the computed batch --
   * is NOT an orphan. Guards specifically against matching by (week,
   * location) alone — a blank location must not cause a false positive; it
   * matches cleanly on the full key because it IS in the computed batch. */
  seed([sup('2026-07-08', 'Bennetts', 14219, 'B1', '')],
       [sum('2026-07-06', 'Bennetts', '', 14219)]);
  {
    const res = healWeek_('2026-07-06', buildCtx());
    eq('action is heal (nothing changed)', res.action, 'heal');
    check('a derived, blank-location row that matches the computed batch is NOT an orphan',
      Array.isArray(res.orphans) && res.orphans.length === 0);
  }

  /* ---- FIX 2 (review fix 2026-08-26, IMPORTANT) — a Labour Summary row is
   * never reported as an orphan. labourWeeklyPull_ writes it from an
   * EXTERNAL spreadsheet (LABOUR_SHEET_ID) — structurally unreachable from
   * an aggregateSupplierRows_ recompute, exactly like shopify_orderapp.
   * Without this exclusion, healWeeks_ (Code.gs:2263) runs healWeek_ BEFORE
   * labourWeeklyPull_ (Code.gs:2277) on every run, so every week would raise
   * a false orphan alert forever. */
  seed([sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
       [sum('2026-07-06', 'Kent Paper', 'Leible York', 100),
        sum('2026-07-06', 'Labour', 'york', 4000)]);
  {
    const res = healWeek_('2026-07-06', buildCtx());
    eq('action is heal (the Kent Paper row matches)', res.action, 'heal');
    check('FIX2: a Labour Summary row is excluded from orphan candidates',
      Array.isArray(res.orphans) && res.orphans.length === 0);
  }

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// summary_audit.gs / Code.gs — runSummaryOrphanSweepDryRun() /
// runSummaryOrphanSweep() (Step 3, PRD-12): the MANUAL, gated removal half of
// orphan handling. Follows the project's established dry-run-then-gated-apply
// shape (cleanupDuplicateSummaryRows, cleanupOnlineRevenueSummaryRows): a
// zero-arg read-only preview, then a zero-arg apply that backs every matched
// row up to a retained tab before its first delete, deletes bottom-up, and
// refuses to proceed if what it finds no longer matches what the dry run
// approved.
console.log('summary_audit.gs — runSummaryOrphanSweepDryRun / runSummaryOrphanSweep (Step 3: gated, backed-up, bottom-up removal)');
withHealUnfrozen(function testSummaryOrphanSweep() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-20T09:00:00+10:00';
  const TODAY = '2026-08-25T00:00:00Z';   // well after every week used below

  function seed(supplierRows, summaryRows, opts) {
    opts = opts || {};
    currentSS = makeSpreadsheet();
    scriptProps = {};
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    (opts.archiveRows || []).forEach((r) => arch.appendRow(r));
    return summ;
  }
  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];
  const sum = (wk, supplier, loc, total, dept, kind) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, dept || 'Cafe', kind || 'spend'];

  // The purge line and the SPLIT guard (FIX 1 below) both run off
  // todayStr_(), which reads the REAL system clock (Code.gs:1618 uses a bare
  // `new Date()` — withMockNow only patches Date.now(), so it cannot reach
  // this call). Built relative to today, matching the pattern already
  // established in testSummaryDriftGuard further down this file.
  const today = todayStr_();
  const cutoff = auditPurgeCutoff_(today);
  const insideDate = addDaysStr_(cutoff, 14);
  const outsideDate = addDaysStr_(cutoff, -14);
  const insideWeek = weekStartForDate_(insideDate);
  const outsideWeek = weekStartForDate_(outsideDate);

  /* ---- 6. dry run: writes nothing, one log line PER candidate ----------- */
  seed(
    [sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
    [sum('2026-07-06', 'Kent Paper', 'Leible York', 100),
     sum('2026-07-06', 'Kent Paper', 'Old Pyrmont', 250),        // orphan A
     sum('2026-07-13', 'Fresh and Chill', 'Old Balmain', 75)]);  // orphan B, different week
  withMockNow(TODAY, function () {
    clearLoggedMessages();
    const before = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    const report = runSummaryOrphanSweepDryRun();
    eq('dry run writes NOTHING to Summary',
      JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()),
      JSON.stringify(before));
    check('dry run finds exactly the 2 orphan candidates',
      report && Array.isArray(report.candidates) && report.candidates.length === 2);
    const linesMentioning = (needle) => lastLoggedMessages().filter((m) => m.indexOf(needle) !== -1);
    check('orphan A gets its own log line', linesMentioning('Old Pyrmont').length >= 1);
    check('orphan B gets its own log line', linesMentioning('Old Balmain').length >= 1);
    check('neither candidate is buried inside one shared blob line (one line per candidate)',
      lastLoggedMessages().every((m) => !(m.indexOf('Old Pyrmont') !== -1 && m.indexOf('Old Balmain') !== -1)));
  });

  /* ---- 7 & 8. apply: backs up before the first delete, deletes bottom-up  */
  withMockNow(TODAY, function () {
    clearWriteOrderLog();
    const summSheet = currentSS.getSheetByName(SUMMARY_TAB);
    const applied = runSummaryOrphanSweep();
    eq('apply matches + deletes exactly the 2 approved candidates',
      applied && applied.deleted, 2);

    const order = getWriteOrderLog();
    const firstBackupIdx = order.findIndex((o) => o.sheet === SUMMARY_ORPHAN_BACKUP_TAB);
    const firstDeleteIdx = order.findIndex((o) => o.sheet === SUMMARY_TAB && o.type === 'deleteRow');
    check('a backup write happened', firstBackupIdx !== -1);
    check('the first Summary delete happened', firstDeleteIdx !== -1);
    check('the backup was written strictly before the first delete',
      firstBackupIdx !== -1 && firstDeleteIdx !== -1 && firstBackupIdx < firstDeleteIdx);

    const backupSheet = currentSS.getSheetByName(SUMMARY_ORPHAN_BACKUP_TAB);
    check('the retained backup tab exists after apply', !!backupSheet);
    if (backupSheet) {
      const backupRows = backupSheet.getDataRange().getValues();
      const matchingBackupRows = backupRows.filter((r) =>
        (r[2] === 'Kent Paper' && r[3] === 'Old Pyrmont') ||
        (r[2] === 'Fresh and Chill' && r[3] === 'Old Balmain'));
      eq('every matched row was backed up (2 orphans -> 2 backup rows), regardless of header shape',
        matchingBackupRows.length, 2);
    }

    const deleteRowNums = summSheet.getDeleteRowCalls();
    check('at least 2 deleteRow calls were made against Summary', deleteRowNums.length >= 2);
    let descending = deleteRowNums.length > 0;
    for (let i = 1; i < deleteRowNums.length; i++) {
      if (deleteRowNums[i] >= deleteRowNums[i - 1]) descending = false;
    }
    check('deleteRow calls happen bottom-up (strictly descending row indices)', descending);

    const remaining = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues().slice(1);
    check('the healthy Kent Paper / Leible York row survives the apply',
      remaining.some((r) => r[2] === 'Kent Paper' && r[3] === 'Leible York'));
    check('both orphans are gone from Summary',
      !remaining.some((r) => r[3] === 'Old Pyrmont') && !remaining.some((r) => r[3] === 'Old Balmain'));
  });

  /* ---- 9. a count mismatch between dry run and apply aborts, deletes nothing */
  const summSheet2 = seed(
    [sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
    [sum('2026-07-06', 'Kent Paper', 'Leible York', 100),
     sum('2026-07-06', 'Kent Paper', 'Old Pyrmont', 250)]);   // exactly 1 orphan approved
  withMockNow(TODAY, function () {
    runSummaryOrphanSweepDryRun();   // approves count = 1

    // Sheet state drifts AFTER the dry run was reviewed but BEFORE apply is
    // clicked — a second orphan lands (e.g. another rename healed in
    // between). The approved count (1) no longer matches reality (2).
    summSheet2.appendRow(sum('2026-07-06', 'Kent Paper', 'Even Older Shop', 60));

    clearWriteOrderLog();
    const before = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    const result = runSummaryOrphanSweep();

    eq('a count mismatch deletes nothing', result && result.deleted, 0);
    eq('Summary is byte-identical after an aborted apply',
      JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()),
      JSON.stringify(before));
    eq('zero deleteRow calls were made on an aborted apply',
      currentSS.getSheetByName(SUMMARY_TAB).getDeleteRowCalls().length, 0);
    check('the abort is reported, not silently swallowed as success',
      !!result && (result.aborted === true || result.mode === 'aborted'));
  });

  /* ---- 10. matching is case-normalized identically to rowKey_ ----------- */
  seed(
    [sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
    [sum('2026-07-06', '  KENT PAPER  ', '  Leible York  ', 100)]);
  withMockNow(TODAY, function () {
    const report = runSummaryOrphanSweepDryRun();
    check('a differently-cased/whitespace twin of a real computed key is NOT an orphan',
      report && Array.isArray(report.candidates) && report.candidates.length === 0);
  });

  /* ------------------------------------------------------------------ *
   * REVIEW FIXES 2026-08-26 — the phase-end gate found these AFTER every
   * per-step review had already approved this step. summaryOrphanSweep_
   * recomputed from Suppliers+Revenue only, with no _archive merge and no
   * purge-line window, while archiveAndPurge_ DELETES Suppliers rows past
   * ARCHIVE_RETENTION_DAYS (183). For every purged week the recompute was
   * empty, so every non-pull-owned row read as an orphan and the gated
   * sweep would have deleted it — ~143 of 169 weeks live. See step3.md
   * "REVIEW FIXES 2026-08-26" for the full writeup.
   * ------------------------------------------------------------------ */

  /* ---- FIX 1a (CRITICAL) — the sweep must MERGE _archive with Suppliers,
   * not read Suppliers alone. A week whose invoices have already been
   * archived (but the week itself is still well inside the repair window)
   * has ZERO Suppliers rows; a Suppliers-only recompute reads its matching
   * Summary row as an orphan candidate. Mirrors auditSummaryDrift_'s own fix
   * via auditDedupeSourceRows_. */
  seed(
    [],
    [sum(insideWeek, 'Kent Paper', 'Leible York', 100)],
    { archiveRows: [sup(insideDate, 'Kent Paper', 100, 'K1', 'Leible York')] });
  withMockNow(TODAY, function () {
    const report = runSummaryOrphanSweepDryRun();
    check('FIX1: a week whose Suppliers rows exist only in _archive is NOT an orphan candidate — the sweep must merge _archive',
      report && Array.isArray(report.candidates) && report.candidates.length === 0);
  });

  /* ---- FIX 1b (CRITICAL) — a week past auditPurgeCutoff_ is skipped
   * entirely, even though its recompute (no Suppliers, no _archive rows
   * survive that far back either) is empty. Without this, every
   * non-pull-owned Summary row for every one of the ~143 purged weeks reads
   * as an orphan candidate — the dry-run/approve gate does not catch this
   * because it only checks that two computations agree with each other, not
   * that the candidate count is sane. */
  seed(
    [],
    [sum(outsideWeek, 'Kent Paper', 'Leible York', 500)]);
  withMockNow(TODAY, function () {
    const report = runSummaryOrphanSweepDryRun();
    check('FIX1: a week past the purge line yields ZERO candidates, not "every row is an orphan"',
      report && Array.isArray(report.candidates) && report.candidates.length === 0);
  });

  /* ---- FIX 1c (CRITICAL) — a SPLIT week (rows in BOTH Suppliers and
   * _archive) is skipped entirely, matching the SPLIT guard computeHealPlan_
   * and summaryDriftCheck_ already use. Deliberately does NOT set up a case
   * the merge alone would save: the live Summary row's key ('Kent Paper' @
   * 'Some Shop', $999) matches neither the Suppliers row nor the _archive
   * row for this week, so if the SPLIT guard were missing this would still
   * read as a genuine orphan candidate even under a merged recompute — this
   * isolates the SPLIT guard specifically, not the merge. */
  seed(
    [sup(insideDate, 'Kent Paper', 500, 'K2', 'New Shop')],
    [sum(insideWeek, 'Kent Paper', 'Some Shop', 999)],
    { archiveRows: [sup(insideDate, 'Fresh and Chill', 10, 'F9', 'Somewhere')] });
  withMockNow(TODAY, function () {
    const report = runSummaryOrphanSweepDryRun();
    check('FIX1: a SPLIT week (rows in both Suppliers and _archive) yields ZERO candidates',
      report && Array.isArray(report.candidates) && report.candidates.length === 0);
  });

  /* ---- FIX 2 (IMPORTANT) — a Labour Summary row is never an orphan
   * candidate. labourWeeklyPull_ writes it from an EXTERNAL spreadsheet
   * (LABOUR_SHEET_ID) — structurally unreachable from an
   * aggregateSupplierRows_ recompute, exactly like shopify_orderapp. Without
   * this, healWeeks_ (Code.gs:2263) runs healWeek_ BEFORE labourWeeklyPull_
   * (Code.gs:2277) on every run, so every week raises a false orphan alert
   * forever, and Labour rows become deletion candidates. */
  seed(
    [sup(insideDate, 'Kent Paper', 100, 'K1', 'Leible York')],
    [sum(insideWeek, 'Kent Paper', 'Leible York', 100),
     sum(insideWeek, 'Labour', 'york', 4000)]);
  withMockNow(TODAY, function () {
    const report = runSummaryOrphanSweepDryRun();
    check('FIX2: a Labour Summary row is excluded from orphan candidates',
      report && Array.isArray(report.candidates) &&
      !report.candidates.some((c) => c.supplier === 'Labour'));
  });

  /* ---- FIX 4c (MINOR) — the approval a dry run records has no timestamp,
   * so a stale dry run from hours ago still authorizes today's apply
   * whenever the candidate set happens to still match. An apply must refuse
   * an approval older than ~1 hour, not silently honor it. */
  seed(
    [sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
    [sum('2026-07-06', 'Kent Paper', 'Leible York', 100),
     sum('2026-07-06', 'Kent Paper', 'Old Pyrmont', 250)]);
  withMockNow(TODAY, function () {
    runSummaryOrphanSweepDryRun();   // approves the 1 orphan candidate
  });
  withMockNow('2026-08-25T01:05:00Z', function () {   // 65 minutes after TODAY — same candidate, stale approval
    clearWriteOrderLog();
    const before = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    const result = runSummaryOrphanSweep();
    eq('FIX4: an approval older than ~1 hour is refused, not silently honored', result && result.deleted, 0);
    eq('Summary is untouched by a stale-approval refusal',
      JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()),
      JSON.stringify(before));
    check('the refusal is reported as aborted, not silently treated as success',
      !!result && (result.aborted === true || result.mode === 'aborted'));
  });

  currentSS = savedSS;
  scriptProps = savedProps;
});

/* ------------------------------------------------------------------ *
 * Step 4 — drift-guard-and-calendar-helper (PRD-13)
 *
 * checkSummaryDrift() / summaryDriftCheck_(nowMs) [summary_audit.gs]: a
 * zero-arg trigger handler that runs a WINDOWED auditSummaryDrift_ (only
 * weeks still inside the ARCHIVE_RETENTION_DAYS purge horizon) and raises AT
 * MOST one calendar alert naming any genuinely alertable drifted week.
 *
 * summaryDriftCheck_ contract (this step's own design — not pre-existing):
 *   { weeksAudited:number,
 *     drifted: Array<{week:string, ...auditSummaryDrift_ week fields}>,
 *     splitSuppressed: Array<{week:string, reason:string}>,
 *     eventsCreated:number }
 * A SPLIT week (has at least one _archive row, same test the heal itself
 * uses — computeHealPlan_/Code.gs) is un-actionable — the heal skips it and
 * the sanctioned repair understates it — so it is moved into
 * splitSuppressed instead of drifted, never alerted daily.
 *
 * raiseCalendarAlert_(title, bodyLines, color, nowMs) [staleness.gs] is the
 * one calendar-writing helper both this guard and the refactored
 * stalenessRaiseAlerts_ now share — staleness.gs stays the ONLY file that
 * touches CalendarApp.
 * ------------------------------------------------------------------ */
console.log('summary_audit.gs / staleness.gs — checkSummaryDrift() drift guard (Step 4, PRD-13)');
(function testSummaryDriftGuard() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const savedTriggers = scriptTriggers;
  const TS = '2026-08-24T13:00:00+10:00';

  function reset() {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    calendarEvents = [];
    calendarFailMode = null;
  }

  function seed(supplierRows, summaryRows, opts) {
    opts = opts || {};
    reset();
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    (opts.archiveRows || []).forEach((r) => arch.appendRow(r));
  }
  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];
  const sum = (wk, supplier, loc, total) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, 'Cafe', 'spend'];

  // The purge line runs off todayStr_(), which reads the REAL system clock
  // (Code.gs:1618 uses a bare `new Date()` — withMockNow only patches
  // Date.now(), so it cannot reach this call). Fixtures are built RELATIVE
  // to today, not to a fixed calendar date, or this suite goes stale the
  // day it stops matching a hand-picked literal.
  const today = todayStr_();
  const cutoff = auditPurgeCutoff_(today);
  const insideDate = addDaysStr_(cutoff, 14);    // well inside the window, long-completed
  const insideDate2 = addDaysStr_(cutoff, 28);   // a second, distinct in-window week
  const outsideDate = addDaysStr_(cutoff, -14);  // past the purge line
  const insideWeek = weekStartForDate_(insideDate);
  const insideWeek2 = weekStartForDate_(insideDate2);
  const outsideWeek = weekStartForDate_(outsideDate);
  const NOW_MS = new Date(today + 'T01:00:00+10:00').getTime();

  /* ---- 3. regression guard: zero-arg auditSummaryDrift() still audits
   *         every week, window or not — does not need any new symbol ------ */
  seed([sup(outsideDate, 'Kent Paper', 100, 'K1', 'X')], []);
  const unwindowed = auditSummaryDrift();
  check('auditSummaryDrift() with no args still audits a week past the purge line',
    unwindowed.weeks.some((w) => w.week === outsideWeek));

  const hasFn = typeof checkSummaryDrift === 'function' &&
    typeof summaryDriftCheck_ === 'function' &&
    typeof raiseCalendarAlert_ === 'function' &&
    typeof installSummaryDriftTrigger === 'function';
  check('checkSummaryDrift / summaryDriftCheck_ / raiseCalendarAlert_ / installSummaryDriftTrigger are all defined', hasFn);

  if (!hasFn) {
    console.log('  (skipping Step 4 drift-guard cases — not yet implemented)');
    currentSS = savedSS;
    scriptProps = savedProps;
    scriptTriggers = savedTriggers;
    return;
  }

  /* ---- 1. checkSummaryDrift() tolerates a trigger event object ---------- */
  eq('checkSummaryDrift takes no declared parameters (zero-arg contract)',
    checkSummaryDrift.length, 0);
  seed([], []);
  let threw = false;
  try { checkSummaryDrift({ triggerUid: 'abc', 'day-of-week': 'MONDAY' }); }
  catch (e) { threw = true; }
  check('checkSummaryDrift(eventObject) does not throw', !threw);

  /* ---- 2. windowed audit excludes past-purge-line weeks, includes inside */
  seed(
    [sup(insideDate, 'Kent Paper', 100, 'K1', 'Leible York'),
     sup(outsideDate, 'Fresh and Chill', 200, 'F1', 'Leible North')],
    []);
  let report = summaryDriftCheck_(NOW_MS);
  check('the in-window drifted week is reported',
    report.drifted.some((w) => w.week === insideWeek));
  check('the past-purge-line week is excluded entirely, not merely unalerted',
    !report.drifted.some((w) => w.week === outsideWeek) &&
    !report.splitSuppressed.some((w) => w.week === outsideWeek));

  /* ---- 9. read-only: zero writes anywhere -------------------------------- */
  seed([sup(insideDate, 'Kent Paper', 100, 'K1', 'Leible York')], []);
  clearWriteOrderLog();
  const writesBefore = currentSS._writeLog.length;
  checkSummaryDrift();
  eq('checkSummaryDrift() writes nothing (spreadsheet write log)',
    currentSS._writeLog.length, writesBefore);
  eq('checkSummaryDrift() writes nothing (cross-sheet write-order log — no setValue/appendRow/deleteRow)',
    getWriteOrderLog().length, 0);

  /* ---- 4. a drifted week inside the window raises exactly one alert ----- */
  seed([sup(insideDate, 'Kent Paper', 100, 'K1', 'Leible York')], []);
  report = summaryDriftCheck_(NOW_MS);
  eq('exactly one calendar alert is raised', calendarEvents.length, 1);
  eq('...and the report agrees', report.eventsCreated, 1);

  /* ---- 5. no drifted week inside the window raises zero alerts ---------- */
  seed(
    [sup(insideDate, 'Kent Paper', 100, 'K1', 'Leible York')],
    [sum(insideWeek, 'Kent Paper', 'Leible York', 100)]);
  report = summaryDriftCheck_(NOW_MS);
  eq('a clean window raises no alert', calendarEvents.length, 0);
  eq('...and the report agrees', report.eventsCreated, 0);
  eq('...nothing drifted', report.drifted.length, 0);

  /* ---- 6. idempotent within a day: a second run creates no 2nd event ---- */
  seed([sup(insideDate, 'Kent Paper', 100, 'K1', 'Leible York')], []);
  summaryDriftCheck_(NOW_MS);
  const countAfterFirst = calendarEvents.length;
  const second = summaryDriftCheck_(NOW_MS);
  eq('a same-day re-run creates no new event', second.eventsCreated, 0);
  eq('event count is unchanged', calendarEvents.length, countAfterFirst);

  /* ---- 7. a SPLIT week inside the window is suppressed, raises no alert - */
  // Same shape as the SPLIT fixtures elsewhere in this file: the week has at
  // least one _archive row, so computeHealPlan_/healWeek_ would skip it — an
  // un-actionable recurring alert, not a real finding worth chasing daily.
  seed(
    [sup(insideDate, 'Butterboy', 200, 'B1', 'Leible York')],
    [sum(insideWeek, 'Butterboy', 'Leible York', 250)],
    { archiveRows: [sup(addDaysStr_(insideWeek, 1), 'Butterboy', 300, 'B2', 'Leible York')] });
  report = summaryDriftCheck_(NOW_MS);
  eq('the SPLIT-only week raises no alert', calendarEvents.length, 0);
  check('...it is recorded as suppressed, not silently dropped',
    report.splitSuppressed.some((w) => w.week === insideWeek));
  check('...for an explicit reason naming SPLIT',
    report.splitSuppressed.some((w) => w.week === insideWeek && /SPLIT/i.test(w.reason)));
  check('...and it is NOT double-counted as an alertable drift too',
    !report.drifted.some((w) => w.week === insideWeek));

  /* ---- 8. bodyLines is an array (not a hand-built blob), and a mixed run
   *         (one alertable week + one SPLIT week) still names remediation -- */
  calendarEvents = [];
  raiseCalendarAlert_('Test alert title', ['line one', 'line two', 'line three'], 'ORANGE', NOW_MS);
  eq('raiseCalendarAlert_ joins bodyLines (array) with newlines, not a hand-built blob',
    calendarEvents[0] && calendarEvents[0]._description,
    'line one\nline two\nline three');

  seed(
    [sup(insideDate, 'Butterboy', 200, 'B1', 'Leible York'),          // SPLIT week
     sup(insideDate2, 'Kent Paper', 150, 'K9', 'Leible York')],       // plain drifted week
    [sum(insideWeek, 'Butterboy', 'Leible York', 250)],
    { archiveRows: [sup(addDaysStr_(insideWeek, 1), 'Butterboy', 300, 'B2', 'Leible York')] });
  report = summaryDriftCheck_(NOW_MS);
  eq('the mixed run still alerts once, for the plain week', calendarEvents.length, 1);
  eq('...the plain week is the one reported as drifted',
    report.drifted.map((w) => w.week), [insideWeek2]);
  eq('...the SPLIT week is suppressed, not alerted',
    report.splitSuppressed.map((w) => w.week), [insideWeek]);
  check('...and the alert body still names the SPLIT week + a remediation line',
    calendarEvents.length === 1 &&
    /SPLIT/.test(calendarEvents[0]._description) &&
    calendarEvents[0]._description.indexOf(insideWeek) !== -1);

  /* ---- 10. a broken/unavailable calendar does not throw ----------------- */
  calendarFailMode = 'all';
  threw = false;
  let created = null;
  try { created = raiseCalendarAlert_('Another title', ['body'], 'ORANGE', NOW_MS); }
  catch (e) { threw = true; }
  check('raiseCalendarAlert_ does not throw when the calendar is unavailable', !threw);
  check('...and reports that nothing was created', !created);
  calendarFailMode = null;

  /* ---- 12. installSummaryDriftTrigger only ever touches its own handler - */
  scriptTriggers = [];
  ScriptApp.newTrigger('shopSpendWatchdog')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(14)
    .inTimezone('Australia/Sydney').create();
  ScriptApp.newTrigger('checkIngestStaleness')
    .timeBased().atHour(11).everyDays(1).inTimezone('Australia/Sydney').create();

  installSummaryDriftTrigger();
  installSummaryDriftTrigger();

  const driftTriggers = ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'checkSummaryDrift');
  const watchdogTriggers = ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'shopSpendWatchdog');
  const stalenessTriggers = ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'checkIngestStaleness');

  eq('installing twice leaves exactly one checkSummaryDrift trigger', driftTriggers.length, 1);
  check('unrelated shopSpendWatchdog trigger is untouched', watchdogTriggers.length === 1);
  check('unrelated checkIngestStaleness trigger is untouched', stalenessTriggers.length === 1);
  if (driftTriggers.length === 1) {
    const cfg = driftTriggers[0]._cfg;
    eq('trigger is MONDAY', cfg.weekDay, ScriptApp.WeekDay.MONDAY);
    eq('trigger is hour 7 (after weeklySummarize 04:00, clear of staleness 11:00)', cfg.hour, 7);
    eq('trigger is Australia/Sydney', cfg.timezone, 'Australia/Sydney');
  }
  scriptTriggers = [];

  /* ---- 11. stalenessRaiseAlerts_'s existing behaviour is unchanged ------ */
  reset();
  let res = stalenessRun_(NOW_MS);
  eq('every source is stale on a cold start (unchanged post-refactor)',
    res.stale.length, STALENESS_SOURCES.length);
  eq('one orange event per stale source (unchanged post-refactor)',
    res.eventsCreated, STALENESS_SOURCES.length);
  check('events are still ORANGE', calendarEvents.every((e) => e._color === 'ORANGE'));
  check('events still carry a description', calendarEvents.every((e) => e._description.length > 0));
  const countAfterStaleness = calendarEvents.length;
  res = stalenessRun_(NOW_MS);
  eq('re-run still creates no duplicate events (idempotency unchanged)', res.eventsCreated, 0);
  eq('event count still unchanged', calendarEvents.length, countAfterStaleness);

  /* ---- FIX 4a (review fix 2026-08-26, MINOR) — summaryDriftCheck_ does not
   * check auditSummaryDrift_'s error return ({error:...}, no .weeks). With
   * no Summary tab, report.weeks is undefined and `report.weeks.length`
   * throws a TypeError inside the scheduled trigger handler, turning a
   * clean "cannot audit" signal into an opaque trigger-failure email
   * instead of a graceful no-op. */
  currentSS = makeSpreadsheet();   // no Summary tab at all
  let threwFix4a = false;
  try { summaryDriftCheck_(NOW_MS); } catch (e) { threwFix4a = true; }
  check('FIX4: summaryDriftCheck_ does not throw when auditSummaryDrift_ returns an error (no Summary tab)',
    !threwFix4a);

  currentSS = savedSS;
  scriptProps = savedProps;
  scriptTriggers = savedTriggers;
})();

/* ------------------------------------------------------------------ *
 * REVIEW FIXES 2026-08-26, round 2 (Step 6: phase-review-fixes)
 *
 * The phase-end gate REVISEd this step twice. Round 1's CRITICAL is closed;
 * this closes round 2's 2 IMPORTANT + 3 MINOR findings:
 *   FIX1 (IMPORTANT) — healRaiseAlert_ must route through raiseCalendarAlert_
 *     (staleness.gs): no direct CalendarApp reference, idempotent within a
 *     day, bodyLines passed as an array (not a hand-built blob).
 *   FIX2 (IMPORTANT) — aggregateSupplierRows_ must group on the SAME
 *     .trim().toLowerCase() normalization rowKey_ uses, so a case/whitespace
 *     twin SUMS instead of splitting into two groups that collapse to one
 *     Summary key and silently lose money via upsertRows_'s duplicatesSkipped
 *     branch, and so the heal actually CONVERGES on re-run instead of
 *     perpetually re-splitting.
 *   FIX3 (MINOR) — healRaiseAlert_/the heal path had zero test coverage;
 *     covered here alongside FIX1/FIX2.
 *   FIX4 (MINOR) — the orphan-sweep approval-staleness gate
 *     (summary_audit.gs:666) must fail CLOSED on a malformed/missing
 *     approvedAt, not silently proceed.
 *   FIX5 (MINOR) — healEarliestBackupRows_ has no production caller; either
 *     wire it in or remove it.
 * ------------------------------------------------------------------ */

// Code.gs / summary_audit.gs — FIX2: aggregateSupplierRows_ groups on the
// SAME normalization rowKey_ uses. A case/whitespace-only twin must SUM into
// one group (not split into two that later collapse to one Summary key and
// lose money), the heal must actually converge on re-run, a non-zero
// duplicatesSkipped on the heal path must be reported (not silent), and
// auditSummaryDrift_ must not see a phantom stale entry once converged.
console.log('Code.gs / summary_audit.gs — FIX2: aggregateSupplierRows_ normalization (case/whitespace collisions SUM, converge, and are reported)');
(function testAggregationNormalizationFix2() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-26T09:00:00+10:00';

  /* ---- Test 1: two source rows differing only by case/trailing space SUM
   *      into ONE group at the FULL total ($350), not split ($100) -------- */
  const caseVariantRows = [
    ['2026-07-08', 'Mayers', 100, 'M1', 'Leible North', 'mayers', TS, 'Cafe'],
    ['2026-07-09', 'mayers ', 250, 'M2', 'leible north', 'mayers', TS, 'Cafe'],
  ];
  const aggResult = aggregateSupplierRows_(caseVariantRows, '2026-07-06', '2026-07-12', 'spend');
  eq('FIX2 test1: a case/whitespace-variant pair collapses to ONE group, not two',
    aggResult.length, 1);
  eq('FIX2 test1: ...summed to the FULL total ($350), not split ($100 + $250 discarded)',
    aggResult.length === 1 ? aggResult[0].total : null, 350);
  eq('FIX2 test1: displayed supplier keeps the FIRST-seen raw casing ("Mayers", not "mayers ")',
    aggResult.length === 1 ? aggResult[0].supplier : null, 'Mayers');
  eq('FIX2 test1: displayed location keeps the FIRST-seen raw casing ("Leible North")',
    aggResult.length === 1 ? aggResult[0].location : null, 'Leible North');

  /* ---- Tests 2 & 3: healWeek_ convergence + reportable duplicatesSkipped - */
  function seed(supplierRows, summaryRows) {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  }
  function buildCtx(opts) {
    opts = opts || {};
    const suppSheet = currentSS.getSheetByName(SUPPLIERS_TAB);
    const archSheet = currentSS.getSheetByName(ARCHIVE_TAB);
    const summSheet = currentSS.getSheetByName(SUMMARY_TAB);
    const revSheet = currentSS.getSheetByName(REVENUE_TAB);
    const backupSheet = ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
    const archRows = archSheet ? archSheet.getDataRange().getValues().slice(1) : [];
    const archiveWeeks = {};
    archRows.forEach((r) => {
      const d = coerceDateStr_(r[0]);
      if (DATE_ARG_RE.test(d)) archiveWeeks[weekStartForDate_(d)] = true;
    });
    const backupRows = backupSheet.getDataRange().getValues().slice(1);
    const backedUpWeeks = {};
    backupRows.forEach((r) => { backedUpWeeks[coerceDateStr_(r[0])] = true; });
    return {
      archiveWeeks: archiveWeeks,
      summaryRows: summSheet.getDataRange().getValues(),
      supplierRows: suppSheet ? suppSheet.getDataRange().getValues().slice(1) : [],
      revenueRows: revSheet ? revSheet.getDataRange().getValues().slice(1) : [],
      summSheet: summSheet,
      backupSheet: backupSheet,
      backedUpWeeks: backedUpWeeks,
      runId: opts.runId || 'RUN-FIX2-TEST',
      extractedAt: opts.extractedAt || TS
    };
  }
  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'mayers', TS, 'Cafe'];

  seed(
    [sup('2026-07-08', 'Mayers', 100, 'M1', 'Leible North'),
     sup('2026-07-09', 'mayers ', 250, 'M2', 'leible north')],
    []);

  const res1 = healWeek_('2026-07-06', buildCtx());
  eq('FIX2 test1 (via healWeek_): first heal writes ONE new row (the merged group)',
    res1.rowsAdded, 1);
  const writtenRow = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()[1];
  eq('...and the Summary row itself carries the FULL $350, not $100',
    writtenRow ? writtenRow[SUMMARY_TOTAL_COL] : null, 350);
  eq('FIX3: healWeek_ reports duplicatesSkipped (0 on this first, non-colliding heal)',
    res1.duplicatesSkipped, 0);

  const res2 = healWeek_('2026-07-06', buildCtx());
  eq('FIX2 test2: a second heal of the SAME week reports convergence — zero new/updated rows',
    res2.rowsAdded + res2.rowsUpdated, 0);
  eq('FIX2 test2: ...and duplicatesSkipped settles at 1 (one converged row), not the pre-fix ' +
     'non-convergent 2 (two split groups colliding on the same key forever)',
    res2.duplicatesSkipped, 1);

  clearLoggedMessages();
  const res3 = healWeek_('2026-07-06', buildCtx());
  eq('FIX3: a third (still-converged) heal keeps reporting duplicatesSkipped, not silence',
    res3.duplicatesSkipped, 1);
  check('FIX3 test3: a non-zero duplicatesSkipped on the heal path is logged, not silently discarded',
    lastLoggedMessages().some((m) => /duplicatesskipped/i.test(m) && m.indexOf('2026-07-06') !== -1));

  /* ---- Test 4: auditSummaryDrift_ sees the SAME normalized total — no
   *      phantom stale entry for the case-variant week once converged ----- */
  withMockNow('2026-08-26T02:00:00Z', function () {
    const audit = auditSummaryDrift_(false);
    const driftedWeek = audit.weeks.find((w) => w.week === '2026-07-06');
    check('FIX2 test4: the converged case-variant week is NOT reported as drifted by auditSummaryDrift_',
      !driftedWeek);
  });

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// Code.gs — FIX1: healRaiseAlert_ must route through raiseCalendarAlert_
// (staleness.gs) — no direct CalendarApp reference, idempotent within a day
// (no duplicate event on a re-run of the same week+kind), bodyLines passed
// as an ARRAY (joined by raiseCalendarAlert_, never hand-joined by the
// caller), and a broken/unavailable calendar must not throw out of it.
console.log('Code.gs — FIX1: healRaiseAlert_ routes through raiseCalendarAlert_ (idempotent, array bodyLines, no CalendarApp, no throw)');
(function testHealRaiseAlertFix1() {
  const savedFail = calendarFailMode;
  const NOW = '2026-08-26T09:00:00+10:00';

  /* ---- Test 5: idempotent within a day — a same week+kind re-run creates
   *      no second event ---------------------------------------------------*/
  calendarEvents = [];
  calendarFailMode = null;
  withMockNow(NOW, function () {
    healRaiseAlert_('2026-07-06', 'Summary corrected', ['line one'], false);
    healRaiseAlert_('2026-07-06', 'Summary corrected', ['line one'], false);
  });
  eq('FIX1 test5: a same-day re-run of the same week+kind creates no second event',
    calendarEvents.length, 1);

  /* ---- Test 6: bodyLines passed as an ARRAY, joined by raiseCalendarAlert_,
   *      not a caller-hand-built blob --------------------------------------*/
  calendarEvents = [];
  withMockNow(NOW, function () {
    healRaiseAlert_('2026-08-01', 'orphan candidate(s) found', ['line one', 'line two'], false);
  });
  eq('FIX1 test6: bodyLines is an array — the description is newline-joined by ' +
     'raiseCalendarAlert_, not pre-joined by the caller into one blob',
    calendarEvents[0] ? calendarEvents[0]._description : null, 'line one\nline two');

  /* ---- Test 7: no file other than staleness.gs references CalendarApp --- */
  const codeSrc = fs.readFileSync(path.join(GAS_DIR, 'Code.gs'), 'utf8');
  check('FIX1 test7: Code.gs no longer references CalendarApp directly (routes through raiseCalendarAlert_ instead)',
    codeSrc.indexOf('CalendarApp') === -1);

  /* ---- Test 8: a broken/unavailable calendar cannot throw out of the heal
   *      alert path --------------------------------------------------------*/
  calendarFailMode = 'all';
  let threw = false;
  try {
    withMockNow(NOW, function () {
      healRaiseAlert_('2026-08-08', 'Summary corrected', ['detail'], false);
    });
  } catch (e) { threw = true; }
  check('FIX1 test8: healRaiseAlert_ does not throw when the calendar is unavailable', !threw);

  calendarFailMode = savedFail;
})();

/* ------------------------------------------------------------------ */

// summary_audit.gs — FIX4: the orphan-sweep approval-staleness gate
// (runSummaryOrphanSweep, summary_audit.gs:666) must fail CLOSED on a
// malformed/missing approvedAt — a gate that cannot read its own approval
// must refuse, not silently proceed as if the approval were fresh.
console.log('summary_audit.gs — FIX4: a malformed/missing approvedAt on the orphan-sweep approval fails CLOSED, not open');
withHealUnfrozen(function testOrphanSweepApprovalFailsClosedFix4() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-20T09:00:00+10:00';
  const TODAY = '2026-08-25T00:00:00Z';

  function seed(supplierRows, summaryRows) {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
  }
  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];
  const sum = (wk, supplier, loc, total) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, 'Cafe', 'spend'];

  seed(
    [sup('2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York')],
    [sum('2026-07-06', 'Kent Paper', 'Leible York', 100),
     sum('2026-07-06', 'Kent Paper', 'Old Pyrmont', 250)]);   // exactly 1 real orphan candidate

  withMockNow(TODAY, function () {
    runSummaryOrphanSweepDryRun();   // approves the 1 orphan candidate, WITH a valid approvedAt

    // Hand-corrupt the just-written approval — matches count/keys but carries
    // no usable timestamp, simulating a malformed/hand-edited property.
    const approved = JSON.parse(scriptProps[SUMMARY_ORPHAN_SWEEP_APPROVED_PROP_]);
    delete approved.approvedAt;
    scriptProps[SUMMARY_ORPHAN_SWEEP_APPROVED_PROP_] = JSON.stringify(approved);

    clearWriteOrderLog();
    const before = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
    const result = runSummaryOrphanSweep();

    eq('FIX4 test9: a missing approvedAt refuses the apply (fails CLOSED) — deletes nothing',
      result && result.deleted, 0);
    eq('Summary is byte-identical after a fail-closed refusal',
      JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()),
      JSON.stringify(before));
    check('the refusal is reported as aborted, not silently treated as success',
      !!result && (result.aborted === true || result.mode === 'aborted'));
  });

  currentSS = savedSS;
  scriptProps = savedProps;
});

/* ------------------------------------------------------------------ */

// Code.gs — step7 FIX3: healEarliestBackupRows_'s reachability must be
// anchored to a genuine, documented, EXERCISED entry point — not mere
// textual reference. The round-2 FIX5 guard immediately below counted
// call-SITE syntax in Code.gs alone, which restoreWeekFromHealBackup_
// calling healEarliestBackupRows_ satisfies trivially even though NOTHING
// called restoreWeekFromHealBackup_ itself and it carried zero tests — a
// dead function calling another dead function is exactly the condition this
// was supposed to catch, and it didn't (phase gate round 3, CRITICAL).
console.log('Code.gs — step7 FIX3: healEarliestBackupRows_ is reachable from a documented, exercised restore entry point (not just textually referenced)');
(function testHealEarliestBackupRowsReachableFix3() {
  const todoSrc = fs.readFileSync(path.join(GAS_DIR, '..', '..', 'TODO.md'), 'utf8');
  check('FIX3 test6a: restoreWeekFromHealBackup_ is named BY IDENTIFIER in TODO.md\'s ' +
    'runbook — a documented entry point an operator can actually find, not just described in prose',
    todoSrc.indexOf('restoreWeekFromHealBackup_') !== -1);

  // The OLD (round-2 FIX5) guard, kept as a supplementary sanity check only —
  // it is satisfied by dead code calling dead code and must never be trusted
  // on its own again; test6a above is the real anchor.
  const codeSrc = fs.readFileSync(path.join(GAS_DIR, 'Code.gs'), 'utf8');
  const callSites = (codeSrc.match(/healEarliestBackupRows_\s*\(/g) || []).length;
  const exists = typeof healEarliestBackupRows_ === 'function';
  check('FIX3 test6b: healEarliestBackupRows_ still resolves (either wired in or removed)',
    !exists || callSites > 1);
})();

/* ------------------------------------------------------------------ *
 * REVIEW FIXES 2026-08-26, round 3 (Step 7: restore-path-and-runbook-fixes)
 *
 * Phase gate round 3 returned 1 CRITICAL + 2 IMPORTANT + 3 MINOR. The
 * CRITICAL was introduced by round 2's own FIX5 wiring:
 * restoreWeekFromHealBackup_ deletes ALL live Summary rows for a week BEFORE
 * checking its backup snapshot is non-empty, so a week that was never healed
 * (every one of the ~169 pre-existing weeks) gets its Summary destroyed and
 * returns {restored:0} — indistinguishable from a benign no-op.
 *   FIX1 (CRITICAL) — restoreWeekFromHealBackup_ must be fail-closed: read
 *     and validate the snapshot BEFORE touching any live row; refuse loudly
 *     (never {restored:0}) when there is nothing, or nothing valid, to
 *     restore from.
 *   FIX2 (IMPORTANT) — TODO.md claims SUMMARY_HEAL_ENABLED=false "stops the
 *     self-heal write immediately"; it only shrinks the window to 1 — the
 *     runbook must say so, and name the REAL emergency stop (the trigger).
 *   FIX3 (IMPORTANT, covered above) — the round-2 FIX5 regression test is
 *     satisfied by one dead function calling another; anchored above to a
 *     genuine, documented entry point instead.
 *   FIX4 (MINOR) — the "Labour correction" alert fires on every first-time
 *     labour insert, not just a genuine correction.
 *   FIX5 (MINOR) — healOrphanCandidates_ needs the same auditPurgeCutoff_
 *     guard summaryOrphanSweep_ already applies.
 *   FIX6 (MINOR) — staleness.gs's CalendarApp-exclusivity comment is false:
 *     orderapp.gs also touches CalendarApp directly (pre-existing, out of
 *     scope to refactor here) — the comment and its test must record the
 *     exception instead of asserting a false invariant.
 * ------------------------------------------------------------------ */

// Code.gs — step7 FIX1 (CRITICAL): restoreWeekFromHealBackup_ must be
// fail-closed. It is the ONLY documented data-undo path (TODO.md "Rollback
// facts an operator needs at 3am") and today deletes every live Summary row
// for the week BEFORE it even looks at whether a usable snapshot exists —
// proven with a probe: 2 rows / $350 in, 0 rows / $0 out.
console.log('Code.gs — step7 FIX1 (CRITICAL): restoreWeekFromHealBackup_ reads + validates the snapshot BEFORE touching any live row');
(function testRestoreWeekFromHealBackupFailClosedFix1() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-24T13:00:00+10:00';
  const WK = '2026-07-06';
  const sumRow = (wk, supplier, loc, total) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, 'Cafe', 'spend'];
  const backupRow = (wk, supplier, loc, total, runId) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, 'Cafe', 'spend', runId];

  /* ---- Test 1: NO snapshot for the week — the $350 -> $0 case. Must delete
   *      NOTHING and return a loud refusal, never {restored:0}. Mutation-test:
   *      removing the early return makes this go red. -------------------- */
  currentSS = makeSpreadsheet();
  scriptProps = {};
  const summ1 = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ1.appendRow(sumRow(WK, 'Kent Paper', 'Leible York', 200));
  summ1.appendRow(sumRow(WK, 'Fresh and Chill', 'Leible North', 150));
  ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS); // tab exists, no snapshot for WK
  const before1 = JSON.stringify(summ1.getDataRange().getValues());

  const res1 = restoreWeekFromHealBackup_(WK);

  eq('FIX1 test1: no snapshot -> a loud, distinct refusal (not {restored:0})',
    res1 && res1.refused, 'no-snapshot');
  check('FIX1 test1: the response does NOT carry a "restored" count at all — {restored:0} reads as success',
    !res1 || res1.restored === undefined);
  eq('FIX1 test1: zero deleteRow calls — nothing is touched before the snapshot is validated',
    summ1.getDeleteRowCalls().length, 0);
  eq('FIX1 test1: live Summary rows are byte-identical afterwards ($350 survives, not $0)',
    JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()), before1);

  /* ---- Test 2: no Summary sheet at all — no throw, no write ------------- */
  currentSS = makeSpreadsheet();
  scriptProps = {};
  ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  let threw2 = false;
  let res2;
  try { res2 = restoreWeekFromHealBackup_(WK); } catch (e) { threw2 = true; }
  check('FIX1 test2: a missing Summary sheet does not throw', !threw2);
  check('FIX1 test2: a missing Summary sheet is reported as a refusal', !!res2 && !!res2.refused);
  check('FIX1 test2: no Summary sheet is created as a side effect of the (failed) restore',
    currentSS.getSheetByName(SUMMARY_TAB) === null);

  /* ---- Test 3: a malformed snapshot refuses rather than partially
   *      restoring — total is not a usable number ------------------------- */
  currentSS = makeSpreadsheet();
  scriptProps = {};
  const summ3 = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ3.appendRow(sumRow(WK, 'Kent Paper', 'Leible York', 100));
  const backup3 = ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  backup3.appendRow(backupRow(WK, 'Kent Paper', 'Leible York', 'NOT_A_NUMBER', 'RUN-1'));
  const before3 = JSON.stringify(summ3.getDataRange().getValues());

  const res3 = restoreWeekFromHealBackup_(WK);

  check('FIX1 test3: a malformed snapshot (non-numeric total) is refused, not partially applied',
    !!res3 && !!res3.refused);
  eq('FIX1 test3: zero deleteRow calls on a malformed snapshot',
    summ3.getDeleteRowCalls().length, 0);
  eq('FIX1 test3: live Summary rows are byte-identical after a malformed-snapshot refusal',
    JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()), before3);

  /* ---- Test 4: a VALID snapshot restores exactly the EARLIEST snapshot's
   *      rows — a later (already-corrected) snapshot for the same week must
   *      be ignored, mirroring healEarliestBackupRows_. ------------------- */
  currentSS = makeSpreadsheet();
  scriptProps = {};
  ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS)
    .appendRow(sumRow(WK, 'Kent Paper', 'Leible York', 175.25)); // current (post-heal, wrong) value
  const backup4 = ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  backup4.appendRow(backupRow(WK, 'Kent Paper', 'Leible York', 100, 'RUN-1'));      // earliest — must win
  backup4.appendRow(backupRow(WK, 'Kent Paper', 'Leible York', 175.25, 'RUN-2'));   // later, must be ignored

  const res4 = restoreWeekFromHealBackup_(WK);

  eq('FIX1 test4: restores exactly 1 row (the earliest snapshot)', res4 && res4.restored, 1);
  const after4 = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
  const dataRows4 = after4.slice(1).filter((r) => coerceDateStr_(r[0]) === WK);
  eq('FIX1 test4: exactly one live row for the week after restore', dataRows4.length, 1);
  eq('FIX1 test4: restored to the EARLIEST snapshot value (100), not the later one (175.25)',
    dataRows4[0][4], 100);

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// TODO.md — step7 FIX2: the kill-switch rollback claim must be literally
// true. Code.gs's own comment on summaryHealWindowSize_ is accurate ("off"
// shrinks the scheduled window to 1, every gate in healWeek_ stays active);
// TODO.md's "Rollback facts" section instead claims the switch "stops the
// self-heal write immediately", which the guarded-integration suite
// (test_code.js ~:8231, 100 -> 175.25) proves false — switch OFF still
// writes wk-1 through healWeeks_ -> upsertRows_.
console.log('TODO.md — step7 FIX2: the kill-switch rollback claim matches what the code actually does');
(function testKillSwitchRunbookMatchesCodeFix2() {
  const todoSrc = fs.readFileSync(path.join(GAS_DIR, '..', '..', 'TODO.md'), 'utf8');
  const startIdx = todoSrc.indexOf('Rollback facts an operator needs at 3am:');
  const endIdx = todoSrc.indexOf('Full drift root-cause history', startIdx);
  check('FIX2 setup: the "Rollback facts" section exists', startIdx !== -1 && endIdx > startIdx);
  const rollback = startIdx !== -1 ? todoSrc.slice(startIdx, endIdx === -1 ? undefined : endIdx) : '';

  check('FIX2 test5a: the runbook no longer claims the switch "stops the self-heal write ' +
    'immediately" (false — it only shrinks the window to 1)',
    rollback.indexOf('stops the self-heal write immediately') === -1);
  check('FIX2 test5b: the runbook documents the switch as a WINDOW SIZE control ' +
    '(4 completed weeks -> 1), not a write stop',
    /window/i.test(rollback) && rollback.indexOf('SUMMARY_HEAL_ENABLED') !== -1);
  check('FIX2 test5c: the runbook names the REAL emergency stop — disabling/deleting ' +
    'the weeklySummarize trigger',
    /(disable|delete)[^.]*trigger/i.test(rollback) && rollback.indexOf('weeklySummarize') !== -1);

  // Behavioural half: the corrected claim must be literally true.
  const savedProps = scriptProps;
  scriptProps = {}; // SUMMARY_HEAL_ENABLED absent — the documented default
  eq('FIX2 test5d: switch OFF/default yields window size 1 — the write path stays ACTIVE, not disabled',
    summaryHealWindowSize_(), 1);
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// Code.gs — step7 FIX4: the "Labour correction" alert must fire only on a
// GENUINE correction (summaryUpdated > 0), never on an ordinary first-time
// labour insert (summaryAdded > 0) — weeklySummarize_impl_ currently guards
// on summaryAdded + summaryUpdated > 0, so every fresh week's first labour
// write trips a calendar event labelled "correction" when nothing was
// corrected. 'Labour correction' has 0 references in this suite today.
console.log('Code.gs — step7 FIX4: "Labour correction" alert fires on a genuine update, never on a first-time insert');
(function testLabourCorrectionAlertGenuineOnlyFix4() {
  const savedSS = currentSS;
  const savedProps = scriptProps;

  function seedLabour() {
    currentSS = makeSpreadsheet();
    scriptProps = { LABOUR_SHEET_ID: 'labour-sheet-id' };
    const src = currentSS.insertSheet('LABOUR_COST');
    src.appendRow(['week_start', 'week_end', 'location', 'total', 'iso_week', 'pulled_at']);
    src.appendRow(['2026-06-15', '2026-06-21', 'york', 4830.14, '2026-W25', 'x']);
    return src;
  }

  /* ---- a first-time labour insert raises NO "Labour correction" alert --- */
  const src = seedLabour();
  calendarEvents = [];
  const first = weeklySummarize('2026-06-15');
  eq('FIX4 setup: the first run is a genuine first-time labour insert', first.labourSummaryAdded, 1);
  check('FIX4 test7a: a first-time labour insert raises NO "Labour correction" alert',
    !calendarEvents.some((e) => e._title.indexOf('Labour correction') !== -1));

  /* ---- a genuine labour correction (changed total, same week/location) DOES
   *      raise the alert ---------------------------------------------------- */
  src.getRange(2, 4).setValue(5200.00); // york's total, same week/location
  calendarEvents = [];
  const second = weeklySummarize('2026-06-15');
  eq('FIX4 setup: the re-run adds no NEW labour summary rows (it is an update, not an insert)',
    second.labourSummaryAdded, 0);
  const summaryAfter = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
  const labourRow = summaryAfter.find((r) => r[2] === 'Labour' && coerceDateStr_(r[0]) === '2026-06-15');
  check('FIX4 setup: the Summary row was genuinely corrected to the new total',
    !!labourRow && labourRow[4] === 5200);
  check('FIX4 test7b: a genuine labour correction DOES raise a "Labour correction" alert',
    calendarEvents.some((e) => e._title.indexOf('Labour correction') !== -1));

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// Code.gs — step7 FIX5: healOrphanCandidates_ needs the same
// auditPurgeCutoff_ guard summaryOrphanSweep_ (summary_audit.gs) already
// applies. On a manual weeklySummarize('<old-week>') override past the
// 183-day purge line, neither Suppliers nor _archive holds the source rows,
// the recompute is empty, and every live Summary row misreads as an orphan —
// while summaryOrphanSweep_ will always refuse to act on it (it skips weeks
// past the line entirely). Scheduled runs are unaffected (last 4 weeks only).
console.log('Code.gs — step7 FIX5: healOrphanCandidates_ respects the auditPurgeCutoff_ guard (no false orphans past the purge line)');
(function testHealOrphanCandidatesPurgeLineGuardFix5() {
  const TS = '2026-08-24T13:00:00+10:00';
  const OLD_WEEK = '2025-01-06'; // solidly past the 183-day purge line from "today"
  const sum = (wk, supplier, loc, total) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, 'Cafe', 'spend'];

  const ctx = {
    summaryRows: [SUMMARY_HEADERS, sum(OLD_WEEK, 'Kent Paper', 'Leible York', 100)],
  };
  const orphans = healOrphanCandidates_(OLD_WEEK, ctx, {}); // computedKeys empty — nothing recomputes

  eq('FIX5 test8: a week past auditPurgeCutoff_ reports ZERO orphan candidates, ' +
    "matching summaryOrphanSweep_'s own guard",
    orphans.length, 0);

  // Sanity: the SAME shape, for a RECENT (in-window) week, still reports the
  // orphan — the guard must be windowed, not a blanket suppression.
  const RECENT_WEEK = weekStartForDate_(todayStr_());
  const ctx2 = {
    summaryRows: [SUMMARY_HEADERS, sum(RECENT_WEEK, 'Kent Paper', 'Leible York', 100)],
  };
  const recentOrphans = healOrphanCandidates_(RECENT_WEEK, ctx2, {});
  check('FIX5 sanity: a RECENT week (inside the purge window) still reports the orphan',
    recentOrphans.length === 1);
})();

/* ------------------------------------------------------------------ */

// connectors/gas/*.gs — step7 FIX6: the CalendarApp-exclusivity invariant is
// checked PROJECT-WIDE, with orderapp.gs recorded as the one pre-existing,
// out-of-scope exception. staleness.gs:18/:277 claim it is "THE ONLY SOURCE"
// / "the ONLY functions in the project that touch CalendarApp" — false,
// orderapp.gs:176/:212 call CalendarApp.EventColor.ORANGE directly and
// predate this phase. The round-2 FIX1 test only ever grepped Code.gs, so
// orderapp.gs was never checked.
console.log('connectors/gas/*.gs — step7 FIX6: CalendarApp-exclusivity is checked project-wide, orderapp.gs recorded as the known exception');
(function testCalendarAppInvariantProjectWideFix6() {
  const files = fs.readdirSync(GAS_DIR).filter((f) => f.endsWith('.gs'));
  const ALLOWED = ['staleness.gs', 'orderapp.gs']; // orderapp.gs predates this phase — see TODO.md
  const violations = [];
  files.forEach((f) => {
    if (ALLOWED.indexOf(f) !== -1) return;
    const src = fs.readFileSync(path.join(GAS_DIR, f), 'utf8');
    if (src.indexOf('CalendarApp') !== -1) violations.push(f);
  });
  eq('FIX6 test9a: no .gs file outside the recorded exception (orderapp.gs) references CalendarApp directly',
    violations, []);

  const stalenessSrc = fs.readFileSync(path.join(GAS_DIR, 'staleness.gs'), 'utf8');
  check("FIX6 test9b: staleness.gs's CalendarApp-exclusivity comment records orderapp.gs " +
    'as the known, out-of-scope exception (today it falsely claims sole ownership)',
    stalenessSrc.indexOf('orderapp.gs') !== -1);

  const todoSrc = fs.readFileSync(path.join(GAS_DIR, '..', '..', 'TODO.md'), 'utf8');
  check('FIX6 test9c: TODO.md records the note step 6 was supposed to deliver — that ' +
    'orderapp.gs also touches CalendarApp and is deliberately out of scope here',
    todoSrc.indexOf('orderapp.gs') !== -1 && /CalendarApp/i.test(todoSrc));
})();

/* ------------------------------------------------------------------ *
 * REVIEW FIXES 2026-08-26, round 4 (Step 8: operator-entry-points-and-latents)
 *
 * Phase gate round 4 returned 1 IMPORTANT + 3 MINOR, no CRITICAL:
 *   FIX1 (IMPORTANT) — TODO.md tells the 3am operator to run
 *     restoreWeekFromHealBackup_('YYYY-MM-DD') from the editor; a trailing
 *     underscore hides it from the Run picker/google.script.run AND it takes
 *     a required arg the Run button cannot supply. New zero-arg, no-underscore
 *     wrappers: listSummaryHealBackups() (read-only) and
 *     restoreSummaryWeekFromBackup() (reads the target week from the
 *     SUMMARY_RESTORE_WEEK Script Property, delegates to the existing
 *     restoreWeekFromHealBackup_).
 *   FIX2 (MINOR) — restoreWeekFromHealBackup_ has no withScriptLock_, unlike
 *     every other entry point; documented for 3am use, when the 04:00
 *     weeklySummarize trigger may be running concurrently.
 *   FIX3 (MINOR) — healEarliestBackupRows_ hardcodes row[8] for run_id while
 *     its caller separately derives SUMMARY_HEADERS.length for its slice —
 *     two encodings of the same fact that silently disagree the moment a
 *     column is added. One named constant, SUMMARY_BACKUP_RUNID_COL, closes it.
 *   FIX4 (MINOR) — raiseCalendarAlert_'s getEventsForDay read is now INSIDE
 *     the per-alert primitive, so a multi-alert invocation (stalenessRaiseAlerts_
 *     over several stale sources, or healWeeks_ correcting several weeks) reads
 *     the calendar day once per ALERT instead of once per INVOCATION.
 * ------------------------------------------------------------------ */

// summary_audit.gs / Code.gs — step8 FIX1 test1: listSummaryHealBackups() is
// zero-arg, read-only, and logs exactly one line per snapshotted week (the
// EARLIEST run's row count + total for that week — a later, already-corrected
// snapshot for the same week must not be double-counted or override it).
console.log('Code.gs — step8 FIX1 test1: listSummaryHealBackups() — zero-arg, read-only, one log line per snapshotted week');
(function testListSummaryHealBackupsFix1() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-24T13:00:00+10:00';
  const backupRow = (wk, supplier, loc, total, runId) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, 'Cafe', 'spend', runId];

  const hasFn = typeof listSummaryHealBackups === 'function';
  check('FIX1 test1 setup: listSummaryHealBackups is defined', hasFn);
  if (!hasFn) {
    console.log('  (skipping listSummaryHealBackups cases — not yet implemented)');
    return;
  }

  eq('FIX1 test1a: listSummaryHealBackups is zero-arg (Run-button friendly)',
    listSummaryHealBackups.length, 0);

  currentSS = makeSpreadsheet();
  scriptProps = {};
  const backup = ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  // Week A: earliest snapshot (RUN-1) has 2 rows / $150; a LATER snapshot for
  // the same week (RUN-2) must be ignored, mirroring healEarliestBackupRows_.
  backup.appendRow(backupRow('2026-08-03', 'Kent Paper', 'Leible York', 100, 'RUN-1'));
  backup.appendRow(backupRow('2026-08-03', 'Fresh and Chill', 'Leible North', 50, 'RUN-1'));
  backup.appendRow(backupRow('2026-08-03', 'Kent Paper', 'Leible York', 175.25, 'RUN-2'));
  // Week B: single-row snapshot.
  backup.appendRow(backupRow('2026-07-27', 'Kent Paper', 'Leible York', 300, 'RUN-3'));

  const summSheet = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  const writesBefore = currentSS._writeLog.length;
  const deleteBefore = backup.getDeleteRowCalls().length;
  loggedMessages = [];

  const result = listSummaryHealBackups();

  eq('FIX1 test1b: writes nothing (spreadsheet write log)', currentSS._writeLog.length, writesBefore);
  eq('FIX1 test1c: deletes nothing from the backup sheet', backup.getDeleteRowCalls().length, deleteBefore);
  eq('FIX1 test1d: creates no rows on the live Summary sheet',
    summSheet.getDataRange().getValues().length, 1); // header only

  const linesForA = lastLoggedMessages().filter((m) => m.indexOf('2026-08-03') !== -1);
  const linesForB = lastLoggedMessages().filter((m) => m.indexOf('2026-07-27') !== -1);
  eq('FIX1 test1e: exactly one log line for week A (one line PER WEEK, not per row/snapshot)',
    linesForA.length, 1);
  eq('FIX1 test1f: exactly one log line for week B', linesForB.length, 1);
  check('FIX1 test1g: week A\'s line reports the EARLIEST run_id (RUN-1), never the later RUN-2',
    linesForA[0].indexOf('RUN-1') !== -1 && linesForA[0].indexOf('RUN-2') === -1);
  check('FIX1 test1h: week A\'s line reports row count 2 and total $150 (the earliest snapshot only)',
    /\b2\b/.test(linesForA[0]) && /\b150\b/.test(linesForA[0]));
  check('FIX1 test1i: week B\'s line reports row count 1 and total $300',
    /\b1\b/.test(linesForB[0]) && /\b300\b/.test(linesForB[0]));
  check('FIX1 test1j: a big single JSON.stringify blob is not the whole report (editor truncation) — ' +
    'more than one Logger.log call was made for 2 weeks',
    lastLoggedMessages().length >= 2);
  check('FIX1 test1k: returns something (not undefined) for a caller that wants the data too',
    result !== undefined);

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// Code.gs / summary_audit.gs — step8 FIX1 test2: restoreSummaryWeekFromBackup()
// with SUMMARY_RESTORE_WEEK unset must refuse loudly and touch nothing —
// exactly the "safe when unusable" behaviour the CURRENT unreachable
// restoreWeekFromHealBackup_('YYYY-MM-DD') already has when invoked with no
// arg, now on a Run-button-reachable entry point.
console.log('Code.gs — step8 FIX1 test2: restoreSummaryWeekFromBackup() refuses loudly when SUMMARY_RESTORE_WEEK is unset');
withHealUnfrozen(function testRestoreSummaryWeekFromBackupUnsetPropertyFix1() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-24T13:00:00+10:00';
  const WK = '2026-07-06';

  const hasFn = typeof restoreSummaryWeekFromBackup === 'function';
  check('FIX1 test2 setup: restoreSummaryWeekFromBackup is defined', hasFn);
  if (!hasFn) {
    console.log('  (skipping restoreSummaryWeekFromBackup cases — not yet implemented)');
    return;
  }

  eq('FIX1 test2a: restoreSummaryWeekFromBackup is zero-arg (Run-button friendly)',
    restoreSummaryWeekFromBackup.length, 0);

  currentSS = makeSpreadsheet();
  scriptProps = {}; // SUMMARY_RESTORE_WEEK unset
  const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ.appendRow([WK, addDaysStr_(WK, 6), 'Kent Paper', 'Leible York', 200, TS, 'Cafe', 'spend']);
  ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS)
    .appendRow([WK, addDaysStr_(WK, 6), 'Kent Paper', 'Leible York', 100, TS, 'Cafe', 'spend', 'RUN-1']);
  const before = JSON.stringify(summ.getDataRange().getValues());
  loggedMessages = [];

  const res = restoreSummaryWeekFromBackup();

  check('FIX1 test2b: an unset SUMMARY_RESTORE_WEEK refuses loudly (Logger.log names the property)',
    lastLoggedMessages().some((m) => m.indexOf('SUMMARY_RESTORE_WEEK') !== -1));
  check('FIX1 test2c: the return value carries a refusal, not a restore count',
    !!res && typeof res.refused === 'string' && res.restored === undefined);
  eq('FIX1 test2d: zero deleteRow calls — nothing is touched when the property is unset',
    summ.getDeleteRowCalls().length, 0);
  eq('FIX1 test2e: live Summary rows are byte-identical afterwards',
    JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()), before);

  currentSS = savedSS;
  scriptProps = savedProps;
});

/* ------------------------------------------------------------------ */

// Code.gs / summary_audit.gs — step8 FIX1 test3: an unparseable
// SUMMARY_RESTORE_WEEK (not a real date) must refuse the same way as unset —
// never silently coerced into "no week" (undefined) or a garbage match.
console.log('Code.gs — step8 FIX1 test3: restoreSummaryWeekFromBackup() refuses an unparseable SUMMARY_RESTORE_WEEK');
(function testRestoreSummaryWeekFromBackupUnparseablePropertyFix1() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-24T13:00:00+10:00';
  const WK = '2026-07-06';

  const hasFn = typeof restoreSummaryWeekFromBackup === 'function';
  if (!hasFn) {
    check('FIX1 test3 setup: restoreSummaryWeekFromBackup is defined (unparseable-property case)', false);
    return;
  }

  currentSS = makeSpreadsheet();
  scriptProps = { SUMMARY_RESTORE_WEEK: 'not-a-real-week' };
  const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ.appendRow([WK, addDaysStr_(WK, 6), 'Kent Paper', 'Leible York', 200, TS, 'Cafe', 'spend']);
  ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS)
    .appendRow([WK, addDaysStr_(WK, 6), 'Kent Paper', 'Leible York', 100, TS, 'Cafe', 'spend', 'RUN-1']);
  const before = JSON.stringify(summ.getDataRange().getValues());

  const res = restoreSummaryWeekFromBackup();

  check('FIX1 test3a: an unparseable SUMMARY_RESTORE_WEEK is refused, not treated as a valid week',
    !!res && typeof res.refused === 'string');
  eq('FIX1 test3b: zero deleteRow calls on an unparseable property value',
    summ.getDeleteRowCalls().length, 0);
  eq('FIX1 test3c: live Summary rows are byte-identical after an unparseable-property refusal',
    JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()), before);

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// Code.gs / summary_audit.gs — step8 FIX1 test4: a VALID property, matched to
// a valid snapshot, restores exactly the EARLIEST snapshot's rows — the same
// guarantee restoreWeekFromHealBackup_ already gives, now reachable from the
// Run button.
console.log('Code.gs — step8 FIX1 test4: restoreSummaryWeekFromBackup() with a valid property restores the EARLIEST snapshot');
withHealUnfrozen(function testRestoreSummaryWeekFromBackupValidFix1() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-24T13:00:00+10:00';
  const WK = '2026-07-06';

  const hasFn = typeof restoreSummaryWeekFromBackup === 'function';
  if (!hasFn) {
    check('FIX1 test4 setup: restoreSummaryWeekFromBackup is defined (valid-property restore case)', false);
    return;
  }

  currentSS = makeSpreadsheet();
  scriptProps = { SUMMARY_RESTORE_WEEK: WK };
  ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS)
    .appendRow([WK, addDaysStr_(WK, 6), 'Kent Paper', 'Leible York', 175.25, TS, 'Cafe', 'spend']); // post-heal, wrong
  const backup = ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  backup.appendRow([WK, addDaysStr_(WK, 6), 'Kent Paper', 'Leible York', 100, TS, 'Cafe', 'spend', 'RUN-1']);     // earliest — must win
  backup.appendRow([WK, addDaysStr_(WK, 6), 'Kent Paper', 'Leible York', 175.25, TS, 'Cafe', 'spend', 'RUN-2']); // later, ignored

  const res = restoreSummaryWeekFromBackup();

  eq('FIX1 test4a: restores exactly 1 row (the earliest snapshot)', res && res.restored, 1);
  const after = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues();
  const dataRows = after.slice(1).filter((r) => coerceDateStr_(r[0]) === WK);
  eq('FIX1 test4b: exactly one live row for the week after restore', dataRows.length, 1);
  eq('FIX1 test4c: restored to the EARLIEST snapshot value (100), not the later one (175.25)',
    dataRows[0][4], 100);

  currentSS = savedSS;
  scriptProps = savedProps;
});

/* ------------------------------------------------------------------ */

// Code.gs — step8 FIX1 test5: neither new operator entry point ends in an
// underscore. Apps Script hides an underscore-suffixed function from the Run
// picker and google.script.run — that is the exact defect this whole FIX closes.
console.log('Code.gs — step8 FIX1 test5: neither new operator entry point name ends in an underscore');
(function testNewEntryPointNamesNotUnderscoredFix1() {
  const hasFns = typeof listSummaryHealBackups === 'function' &&
    typeof restoreSummaryWeekFromBackup === 'function';
  check('FIX1 test5 setup: both listSummaryHealBackups and restoreSummaryWeekFromBackup are defined', hasFns);
  if (!hasFns) {
    console.log('  (skipping FIX1 naming checks — new entry points not yet implemented)');
    return;
  }
  check('FIX1 test5a: listSummaryHealBackups does not end with an underscore',
    !/_$/.test(listSummaryHealBackups.name));
  check('FIX1 test5b: restoreSummaryWeekFromBackup does not end with an underscore',
    !/_$/.test(restoreSummaryWeekFromBackup.name));
})();

/* ------------------------------------------------------------------ */

// Code.gs — step8 FIX2 test6: restoreWeekFromHealBackup_ must refuse with a
// lock-flavoured {refused:...} shape (never throw, never proceed) when the
// script lock is already held — the documented 3am-incident use case, when
// the 04:00 weeklySummarize trigger may be mid-run. Today the function has no
// withScriptLock_ at all, so a held lock has zero effect and the restore
// proceeds — this must go red on that gap.
console.log('Code.gs — step8 FIX2 test6: restoreWeekFromHealBackup_ refuses with a lock-timeout shape when the script lock is held');
(function testRestoreLockTimeoutFix2() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-24T13:00:00+10:00';
  const WK = '2026-07-06';

  currentSS = makeSpreadsheet();
  scriptProps = {};
  const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ.appendRow([WK, addDaysStr_(WK, 6), 'Kent Paper', 'Leible York', 175.25, TS, 'Cafe', 'spend']);
  ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS)
    .appendRow([WK, addDaysStr_(WK, 6), 'Kent Paper', 'Leible York', 100, TS, 'Cafe', 'spend', 'RUN-1']);
  const before = JSON.stringify(summ.getDataRange().getValues());

  global.__forceLockTimeout = true;
  let res;
  let threw = false;
  try { res = restoreWeekFromHealBackup_(WK); } catch (e) { threw = true; }
  global.__forceLockTimeout = false;

  check('FIX2 test6a: restoreWeekFromHealBackup_ does not throw when the script lock is held', !threw);
  check('FIX2 test6b: a held lock refuses with a lock-flavoured {refused:...} shape',
    !!res && typeof res.refused === 'string' && /lock/i.test(res.refused));
  eq('FIX2 test6c: zero deleteRow calls when the lock could not be acquired',
    summ.getDeleteRowCalls().length, 0);
  eq('FIX2 test6d: live Summary rows are untouched when the lock could not be acquired',
    JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()), before);

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// Code.gs — step8 FIX3 test7: run_id column resolution must come from ONE
// named constant (SUMMARY_BACKUP_RUNID_COL), used by BOTH
// healEarliestBackupRows_ (today: bare row[8]) and restoreWeekFromHealBackup_'s
// slice (today: a separately-derived SUMMARY_HEADERS.length) — two
// independent encodings of "where run_id lives" that agree only by
// coincidence today and would silently diverge the moment a column is added
// to SUMMARY_HEADERS.
console.log('Code.gs — step8 FIX3 test7: run_id column resolution comes from ONE named constant shared by both call sites');
(function testRunIdColumnSingleConstantFix3() {
  const hasConst = typeof SUMMARY_BACKUP_RUNID_COL === 'number';
  check('FIX3 test7 setup: SUMMARY_BACKUP_RUNID_COL is defined', hasConst);
  if (!hasConst) {
    console.log('  (skipping FIX3 agreement checks — SUMMARY_BACKUP_RUNID_COL not yet defined)');
    return;
  }

  eq('FIX3 test7a: SUMMARY_BACKUP_RUNID_COL equals SUMMARY_HEADERS.length',
    SUMMARY_BACKUP_RUNID_COL, SUMMARY_HEADERS.length);
  eq('FIX3 test7b: the run_id column in SUMMARY_HEAL_BACKUP_HEADERS sits exactly at SUMMARY_BACKUP_RUNID_COL',
    SUMMARY_HEAL_BACKUP_HEADERS[SUMMARY_BACKUP_RUNID_COL], 'run_id');

  // Source-level agreement: both named call sites must reference the SAME
  // constant — not a bare literal 8, not an independently re-derived
  // SUMMARY_HEADERS.length. Extracting each function's own source text (up to
  // the next top-level `function` declaration) so this cannot be satisfied by
  // the constant merely existing somewhere else in the file.
  const codeSrc = fs.readFileSync(path.join(GAS_DIR, 'Code.gs'), 'utf8');
  const fnBody = (name) => {
    const start = codeSrc.indexOf('function ' + name + '(');
    if (start === -1) return '';
    const next = codeSrc.indexOf('\nfunction ', start + 1);
    return codeSrc.slice(start, next === -1 ? codeSrc.length : next);
  };
  const earliestBody = fnBody('healEarliestBackupRows_');
  const restoreBody = fnBody('restoreWeekFromHealBackup_');

  check('FIX3 test7c: healEarliestBackupRows_ resolves run_id via SUMMARY_BACKUP_RUNID_COL, ' +
    'not a bare row[8] literal',
    earliestBody.indexOf('SUMMARY_BACKUP_RUNID_COL') !== -1 && !/row\[8\]/.test(earliestBody));
  check('FIX3 test7d: restoreWeekFromHealBackup_ uses the SAME named constant for its slice',
    restoreBody.indexOf('SUMMARY_BACKUP_RUNID_COL') !== -1);

  // Behavioural sanity: the pure primitive still resolves a real fixture
  // correctly through whatever the constant currently evaluates to.
  const rows = [
    ['2026-07-06', '2026-07-12', 'Kent Paper', 'Leible York', 100, 'TS', 'Cafe', 'spend', 'RUN-1'],
  ];
  const earliest = healEarliestBackupRows_(rows, '2026-07-06');
  eq('FIX3 test7e sanity: healEarliestBackupRows_ still resolves the real fixture correctly',
    earliest.length, 1);
})();

/* ------------------------------------------------------------------ */

// staleness.gs / Code.gs — step8 FIX4 test8: the day's calendar events must
// be read ONCE per invocation (per stalenessRaiseAlerts_ batch, per healWeeks_
// run), regardless of how many individual alerts are raised within it — and
// idempotency (an already-present title is still skipped) must survive the
// optimization unchanged.
console.log('staleness.gs / Code.gs — step8 FIX4 test8: the day\'s calendar events are read ONCE per invocation, not once per alert');
(function testCalendarReadOncePerInvocationFix4() {
  const savedSS = currentSS;
  const savedProps = scriptProps;

  /* ---- stalenessRaiseAlerts_: one batch, three stale sources ------------- */
  calendarEvents = [];
  resetGetEventsForDayCallCount();
  const staleEntries = [
    { source: 'square', ageHours: 30, thresholdHours: 24 },
    { source: 'mayers', ageHours: 40, thresholdHours: 24 },
    { source: 'kent_paper', ageHours: 50, thresholdHours: 24 },
  ];
  const created = stalenessRaiseAlerts_(staleEntries, Date.parse('2026-08-24T00:00:00Z'));
  eq('FIX4 test8 setup: all three stale sources raised a NEW event', created, 3);
  eq('FIX4 test8a: getEventsForDay is called exactly ONCE for a 3-entry staleness batch, not 3 times',
    getEventsForDayCallCount, 1);

  /* ---- idempotency must survive the optimization ------------------------- */
  calendarEvents = [makeCalEvent(stalenessEventTitle_('square'), new Date())];
  resetGetEventsForDayCallCount();
  const created2 = stalenessRaiseAlerts_(staleEntries, Date.parse('2026-08-24T00:00:00Z'));
  eq('FIX4 test8b: the already-present title is still skipped — only 2 of 3 are newly created',
    created2, 2);
  eq('FIX4 test8c: still exactly ONE getEventsForDay call for the batch',
    getEventsForDayCallCount, 1);

  /* ---- healWeeks_: a batch correcting TWO weeks raises two healRaiseAlert_
   *      calls, but must still read the calendar day ONCE for the run ------ */
  const TS = '2026-08-24T13:00:00+10:00';
  currentSS = makeSpreadsheet();
  scriptProps = {};
  const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
  supp.appendRow(['2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York', 'src', TS, 'Cafe']);
  supp.appendRow(['2026-08-12', 'Fresh and Chill', 200, 'F2', 'Leible North', 'src', TS, 'Cafe']);
  const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ.appendRow(['2026-08-17', addDaysStr_('2026-08-17', 6), 'Kent Paper', 'Leible York', 100, TS, 'Cafe', 'spend']);
  summ.appendRow(['2026-08-10', addDaysStr_('2026-08-10', 6), 'Fresh and Chill', 'Leible North', 100, TS, 'Cafe', 'spend']);
  ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
  ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
  ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);

  calendarEvents = [];
  resetGetEventsForDayCallCount();
  healWeeks_(['2026-08-17', '2026-08-10']);
  const correctionEvents = calendarEvents.filter((e) =>
    e._title.indexOf('2026-08-17') !== -1 || e._title.indexOf('2026-08-10') !== -1);
  check('FIX4 test8 setup: both weeks raised a distinct correction alert in this single healWeeks_ call',
    correctionEvents.length === 2);
  eq('FIX4 test8d: healWeeks_ reads the calendar day ONCE for the whole run, even though ' +
    '2 separate weeks each raised their own alert',
    getEventsForDayCallCount, 1);

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ *
 * Step 9 — bounded-closeout (PRD-12, PRD-13). FINAL STEP — repair-only,
 * no new functions/entry points/Script Properties/tabs. See step9.md.
 *
 *   FIX1 (IMPORTANT) — healBackupWeek_'s snapshot-once guard falsifies the
 *     baseline for a newly-summarized week: a first heal of a week with ZERO
 *     live Summary rows backs up 0 rows and leaves no marker, so
 *     healWeeks_'s ctx.backedUpWeeks (seeded only from rows already present
 *     in Summary_heal_backup) never learns the week was already handled —
 *     the NEXT heal treats it as "first backup" again and snapshots the
 *     already-healed (non-empty) rows as if they were the pre-heal baseline.
 *   FIX2 (IMPORTANT) — previewSummaryHeal hardcodes a 4-week window while the
 *     real run sizes its window from summaryHealWindowSize_ — preview and
 *     apply can diverge on the ONE pre-flight look an operator gets before
 *     real money moves.
 *   FIX3 (IMPORTANT) — runSummaryOrphanSweep deletes by cached row index with
 *     no script lock and no identity re-verification; a concurrent
 *     row-deleting path landing in between (restoreWeekFromHealBackup_,
 *     cleanupDuplicateSummaryRows) can shift indices and delete a live row
 *     with no recovery copy.
 *   FIX4 (MINOR) — the Labour correction alert (weeklySummarize_impl_) calls
 *     healRaiseAlert_ without ctx.calendarEventsCache, so it always re-reads
 *     the calendar day even when the batch already read it once.
 *   FIX5 (MINOR) — listSummaryHealBackups builds its week list from
 *     coerceDateStr_ with no DATE_ARG_RE guard, so a blank/malformed backup
 *     date becomes a '' week entry.
 * ------------------------------------------------------------------ */

// Code.gs — step9 FIX1: the backup baseline must not be falsified for a
// newly-summarized (zero-live-rows) week. Probe-verified in step9.md: week
// 2026-08-17 with 0 live Summary rows → run1 heals to 175.25 and backs up 0
// rows → run2 heals to 999.99 and (today, unfixed) backs up 175.25 as if it
// were the baseline → healEarliestBackupRows_ resolves to 175.25 instead of
// the true empty baseline.
console.log('Code.gs — step9 FIX1: the backup baseline is not falsified for a newly-summarized (zero-live-rows) week');
(function testHealBackupBaselineNotFalsifiedFix1() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS1 = '2026-08-24T13:00:00+10:00';
  const TS2 = '2026-08-24T14:00:00+10:00';
  const WK = '2026-08-17';

  currentSS = makeSpreadsheet();
  scriptProps = {};
  const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
  supp.appendRow([addDaysStr_(WK, 2), 'Kent Paper', 175.25, 'K1', 'Leible York', 'src', TS1, 'Cafe']);
  ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);   // zero live rows for WK
  ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
  ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
  const backup = ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);

  withMockNow(TS1, function () {
    const run1 = healWeeks_([WK]);
    check('run1 setup: the first heal of an empty week genuinely wrote a Summary row',
      run1.weeks[0].action === 'heal' && run1.weeks[0].rowsAdded === 1);
  });

  const backupRowsAfterRun1 = backup.getDataRange().getValues().slice(1);
  const weeksSeenAfterRun1 = backupRowsAfterRun1.filter((r) => coerceDateStr_(r[0]) === WK);
  check('FIX1 test1: the first heal of a zero-live-row week records an explicit ' +
    'marker for that week in Summary_heal_backup, not left absent',
    weeksSeenAfterRun1.length >= 1);

  // A second invoice lands, so a second heal recomputes a DIFFERENT total —
  // mirrors the probe: run1 heals to 175.25, run2 to 999.99.
  supp.appendRow([addDaysStr_(WK, 3), 'Kent Paper', 824.74, 'K2', 'Leible York', 'src', TS2, 'Cafe']);

  withMockNow(TS2, function () {
    const run2 = healWeeks_([WK]);
    check('run2 setup: the second heal genuinely corrected the total (175.25 -> 999.99)',
      run2.weeks[0].action === 'heal' && run2.weeks[0].updates.some((u) => u.to === 999.99));
  });

  const backupRowsAfterRun2 = backup.getDataRange().getValues().slice(1);

  // FIX1 test1 continued: run2 must NOT append a second, falsified "first"
  // snapshot for the same week — still exactly one distinct run_id for WK.
  const runIdsForWeek = new Set(
    backupRowsAfterRun2.filter((r) => coerceDateStr_(r[0]) === WK).map((r) => r[SUMMARY_BACKUP_RUNID_COL]));
  eq('FIX1 test1b: a later heal does not overwrite the recorded baseline with a ' +
    'second (falsified) snapshot — still exactly one run_id for the week',
    runIdsForWeek.size, 1);

  // FIX1 test2: healEarliestBackupRows_ must resolve to the TRUE pre-heal
  // baseline (empty, total 0) — never run1's post-heal 175.25 total.
  const earliest = healEarliestBackupRows_(backupRowsAfterRun2, WK);
  const earliestTotal = earliest.reduce((sum, r) => sum + Number(r[SUMMARY_TOTAL_COL]), 0);
  eq('FIX1 test2: healEarliestBackupRows_ resolves to the EMPTY pre-heal baseline ' +
    '(total 0), never the falsified post-run1 total (175.25)',
    earliestTotal, 0);

  // Restore contract: "restore to nothing" — not refused as no-snapshot, and
  // not restoring the falsified 175.25 total.
  let restoreResult;
  withMockNow(TS2, function () { restoreResult = restoreWeekFromHealBackup_(WK); });
  check('FIX1 test3: restoring a week whose true baseline was empty is NOT ' +
    'refused as "no-snapshot"',
    !(restoreResult && restoreResult.refused === 'no-snapshot'));
  const wkRowsAfterRestore = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()
    .slice(1).filter((r) => coerceDateStr_(r[0]) === WK);
  eq('FIX1 test3b: restoring to the true (empty) baseline leaves ZERO live Summary rows for the week',
    wkRowsAfterRestore.length, 0);

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// summary_audit.gs — step9 FIX2: previewSummaryHeal must agree with the
// scheduled run on the week list, for every window size — today it
// hardcodes 4 weeks while the real run sizes off summaryHealWindowSize_ (1
// when SUMMARY_HEAL_ENABLED is off/default, SUMMARY_HEAL_WEEKS when on).
console.log('summary_audit.gs — step9 FIX2: previewSummaryHeal agrees with the real heal window for every window size (1, 4, 12)');
withHealUnfrozen(function testPreviewMatchesApplyWindowFix2() {
  const savedSS = currentSS;
  const savedProps = scriptProps;

  currentSS = makeSpreadsheet();
  ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
  ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);

  // Real system clock, deliberately NOT mocked — todayStr_() uses a bare
  // `new Date()` (project gotcha: withMockNow only patches Date.now()), and
  // previewSummaryHeal derives its window off todayStr_() same as the real
  // run does, so this must match whatever "today" actually is at test time.
  const today = todayStr_();
  const last = getLastCompletedWeek_(today);
  function expectedWeeks(n) {
    const weeks = [];
    for (let i = 0; i < n; i++) weeks.unshift(addDaysStr_(last.start, -7 * i));
    return weeks.sort();
  }

  scriptProps = {};   // SUMMARY_HEAL_ENABLED off (default) — the scheduled run heals exactly 1 week
  eq('FIX2 setup: summaryHealWindowSize_() is 1 with the kill switch off (default)',
    summaryHealWindowSize_(), 1);
  let report = previewSummaryHeal();
  eq('FIX2 test4: with the heal kill switch OFF (default), preview shows exactly the ' +
    '1 week the scheduled run would actually heal, not a hardcoded 4',
    report.weeks.map((w) => w.week).sort(), expectedWeeks(1));

  [1, 4, 12].forEach((n) => {
    scriptProps = { SUMMARY_HEAL_ENABLED: 'true', SUMMARY_HEAL_WEEKS: String(n) };
    report = previewSummaryHeal();
    eq('FIX2 test3: preview agrees with the real heal window for SUMMARY_HEAL_WEEKS=' + n,
      report.weeks.map((w) => w.week).sort(), expectedWeeks(n));
  });

  currentSS = savedSS;
  scriptProps = savedProps;
});

/* ------------------------------------------------------------------ */

// summary_audit.gs — step9 FIX3 test1: runSummaryOrphanSweep must refuse
// with a lock-flavoured shape (never throw, never delete) when the script
// lock is already held — mirrors restoreWeekFromHealBackup_'s own
// step8-FIX2 lock-timeout test. Today the function has no withScriptLock_ at
// all, so a held lock has zero effect and the apply proceeds.
console.log('summary_audit.gs — step9 FIX3 test1: runSummaryOrphanSweep refuses (no delete) when the script lock is held');
(function testOrphanSweepLockTimeoutFix3() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-20T09:00:00+10:00';
  const TODAY = '2026-08-25T00:00:00Z';

  currentSS = makeSpreadsheet();
  scriptProps = {};
  ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS)
    .appendRow(['2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York', 'src', TS, 'Cafe']);
  const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ.appendRow(['2026-07-06', addDaysStr_('2026-07-06', 6), 'Kent Paper', 'Leible York', 100, TS, 'Cafe', 'spend']);
  summ.appendRow(['2026-07-06', addDaysStr_('2026-07-06', 6), 'Kent Paper', 'Old Pyrmont', 250, TS, 'Cafe', 'spend']); // orphan
  ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
  ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);

  withMockNow(TODAY, function () {
    runSummaryOrphanSweepDryRun(); // approves the 1 orphan candidate, lock not held yet
  });

  const before = JSON.stringify(summ.getDataRange().getValues());
  global.__forceLockTimeout = true;
  let res;
  let threw = false;
  withMockNow(TODAY, function () {
    try { res = runSummaryOrphanSweep(); } catch (e) { threw = true; }
  });
  global.__forceLockTimeout = false;

  check('FIX3 test1a: runSummaryOrphanSweep does not throw when the script lock is held', !threw);
  eq('FIX3 test1b: zero deleteRow calls when the lock could not be acquired',
    summ.getDeleteRowCalls().length, 0);
  eq('FIX3 test1c: live Summary rows are untouched when the lock could not be acquired',
    JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()), before);
  check('FIX3 test1d: the refusal is reported, not silently treated as success',
    !!res && (res.aborted === true || res.mode === 'aborted' || typeof res.refused === 'string'));

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// summary_audit.gs — step9 FIX3 test2: a Summary row whose key no longer
// matches its cached index must abort the WHOLE sweep, deleting nothing —
// simulates a concurrent row-deleting path (restoreWeekFromHealBackup_,
// cleanupDuplicateSummaryRows) landing between the sweep's own fresh
// recompute (its first getDataRange() read, used for the approval-match
// gate) and a from-scratch identity re-verification pass a lock-safe
// implementation must perform (mirroring restoreWeekFromHealBackup_'s own
// fresh in-lock re-read, Code.gs:1970) by landing a brand-new live row at
// one candidate's cached position on the SECOND getDataRange() read.
console.log('summary_audit.gs — step9 FIX3 test2: a stale cached row index aborts the whole sweep, deletes nothing');
withHealUnfrozen(function testOrphanSweepStaleIndexAbortsFix3() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-20T09:00:00+10:00';
  const TODAY = '2026-08-25T00:00:00Z';

  currentSS = makeSpreadsheet();
  scriptProps = {};
  ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS)
    .appendRow(['2026-07-08', 'Kent Paper', 100, 'K1', 'Leible York', 'src', TS, 'Cafe']);
  const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ.appendRow(['2026-07-06', addDaysStr_('2026-07-06', 6), 'Kent Paper', 'Leible York', 100, TS, 'Cafe', 'spend']);      // healthy
  summ.appendRow(['2026-07-06', addDaysStr_('2026-07-06', 6), 'Kent Paper', 'Old Pyrmont', 250, TS, 'Cafe', 'spend']);     // orphan B
  summ.appendRow(['2026-07-13', addDaysStr_('2026-07-13', 6), 'Fresh and Chill', 'Old Balmain', 75, TS, 'Cafe', 'spend']); // orphan C
  ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
  ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);

  withMockNow(TODAY, function () {
    runSummaryOrphanSweepDryRun(); // approves the 2 orphan candidates (B, C)
  });

  let dataRangeCalls = 0;
  const origGetDataRange = summ.getDataRange;
  summ.getDataRange = function () {
    dataRangeCalls++;
    if (dataRangeCalls === 2) {
      summ._rows.splice(2, 0,
        ['2026-07-06', addDaysStr_('2026-07-06', 6), 'Brand New Live Row', 'Somewhere', 42, TS, 'Cafe', 'spend']);
    }
    return origGetDataRange();
  };

  clearWriteOrderLog();
  let result;
  let threw = false;
  withMockNow(TODAY, function () {
    try { result = runSummaryOrphanSweep(); } catch (e) { threw = true; }
  });
  summ.getDataRange = origGetDataRange;

  check('FIX3 test2a: runSummaryOrphanSweep does not throw when a cached row index goes stale mid-sweep', !threw);
  eq('FIX3 test2b: a stale-index mismatch aborts the WHOLE sweep — zero deleteRow calls',
    summ.getDeleteRowCalls().length, 0);

  const afterRows = summ._rows.map((r) => r.slice());
  check('FIX3 test2c: the live row that landed mid-sweep survives untouched',
    afterRows.some((r) => r[2] === 'Brand New Live Row'));
  check('FIX3 test2d: both original orphan rows still exist — nothing was deleted at all',
    afterRows.some((r) => r[3] === 'Old Pyrmont') && afterRows.some((r) => r[3] === 'Old Balmain'));
  check('FIX3 test2e: the healthy Kent Paper / Leible York row still exists',
    afterRows.some((r) => r[3] === 'Leible York' && r[2] === 'Kent Paper'));
  check('FIX3 test2f: the abort is reported, not silently treated as success',
    !!result && (result.aborted === true || result.mode === 'aborted'));

  currentSS = savedSS;
  scriptProps = savedProps;
});

/* ------------------------------------------------------------------ */

// Code.gs — step9 FIX4: the Labour correction alert must share the batch
// calendar-events cache — weeklySummarize_impl_ calls healRaiseAlert_ for a
// genuine Labour correction WITHOUT ctx.calendarEventsCache, so it always
// re-reads the calendar day even when healWeeks_'s own correction alert (in
// the SAME weeklySummarize call) already read it once.
console.log('Code.gs — step9 FIX4: the Labour correction alert shares the batch calendar-events cache (no extra getEventsForDay read)');
(function testLabourAlertSharesCalendarCacheFix4() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-24T13:00:00+10:00';
  const WEEK = '2026-06-15';
  const WEEK_END = addDaysStr_(WEEK, 6);

  currentSS = makeSpreadsheet();
  scriptProps = { LABOUR_SHEET_ID: 'labour-sheet-id' };

  ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS)
    .appendRow([WEEK, 'Kent Paper', 500, 'K1', 'Leible York', 'src', TS, 'Cafe']);
  const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ.appendRow([WEEK, WEEK_END, 'Kent Paper', 'Leible York', 100, TS, 'Cafe', 'spend']); // stale -> corrected to 500
  summ.appendRow([WEEK, WEEK_END, 'Labour', 'york', 1000, TS, 'Cafe', 'spend']);           // stale -> corrected below
  ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
  ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
  ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);

  const src = currentSS.insertSheet('LABOUR_COST');
  src.appendRow(['week_start', 'week_end', 'location', 'total', 'iso_week', 'pulled_at']);
  src.appendRow([WEEK, WEEK_END, 'york', 4830.14, '2026-W25', 'x']);

  calendarEvents = [];
  resetGetEventsForDayCallCount();
  weeklySummarize(WEEK);

  check('FIX4 setup: the Suppliers-side heal genuinely corrected Kent Paper (100 -> 500)',
    calendarEvents.some((e) => e._title.indexOf('Summary corrected') !== -1));
  check('FIX4 setup: the Labour pull genuinely corrected the stale total (1000 -> 4830.14)',
    calendarEvents.some((e) => e._title.indexOf('Labour correction') !== -1));
  eq('FIX4 test7: both the Summary correction alert and the Labour correction ' +
    'alert share ONE getEventsForDay read for the whole weeklySummarize call, not two',
    getEventsForDayCallCount, 1);

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

// summary_audit.gs — step9 FIX5: listSummaryHealBackups must validate dates
// (DATE_ARG_RE) before building its week list — today a blank/malformed
// backup date cell becomes a '' week entry, matching the guard
// auditSummaryDrift_/computeHealPlan_ already apply.
console.log('summary_audit.gs — step9 FIX5: listSummaryHealBackups validates dates before building the week list');
(function testListSummaryHealBackupsValidatesDatesFix5() {
  const savedSS = currentSS;

  currentSS = makeSpreadsheet();
  const backup = ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  backup.appendRow(['', '', '', '', 0, '', '', '', 'RUN-BLANK']);   // malformed/blank date row
  backup.appendRow(['2026-07-06', '2026-07-12', 'Kent Paper', 'Leible York', 100, 'TS', 'Cafe', 'spend', 'RUN-1']);

  const result = listSummaryHealBackups();
  check("FIX5 test8: a blank/malformed backup date does not produce a '' week entry",
    !result.weeks.some((w) => w.week === ''));
  check('FIX5 test8b: the genuine week is still reported',
    result.weeks.some((w) => w.week === '2026-07-06'));

  currentSS = savedSS;
})();

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * STEP 10 (2026-08-26) — close the open CRITICAL, then ship the safe subset.
 *
 * FIX1 (CRITICAL) — restoreWeekFromHealBackup_ deleted every live Summary row
 *   for a week using (week) ALONE as the predicate, then re-appended only the
 *   baseline frozen at that week's FIRST heal. Rows written AFTER that
 *   baseline that no heal can produce — shopify_orderapp's directly written
 *   online revenue (PRD-10) and Labour (an external LABOUR_SHEET_ID pull) —
 *   are in neither the snapshot nor any recompute, so they were destroyed
 *   with no recovery path while the restore reported success. Probe: a
 *   $4,321.55 shopify_orderapp row went 1 -> 0 rows under {restored:1}.
 * FIX2 (IMPORTANT) — step9's empty-baseline marker made listSummaryHealBackups
 *   report rows=1/total=$0 for a week whose true baseline was ZERO rows,
 *   reintroducing the "$0 reads as a real restorable snapshot" ambiguity
 *   step7's CRITICAL fix removed.
 * FIX3 (ship gate) — the phase froze after 6 gate rounds without approval, so
 *   every WRITE-side entry point it added must hard-refuse: deploy.sh pushes
 *   the WHOLE project, so the refusals ARE the deploy scope.
 * ------------------------------------------------------------------ */

// Code.gs — step10 FIX1 (CRITICAL): the restore's delete predicate must be
// scoped to what the snapshot OWNS — the full SUMMARY_KEY_COLS tuple, never
// (week) alone.
console.log('Code.gs — step10 FIX1 (CRITICAL): restoreWeekFromHealBackup_ never deletes a row its snapshot does not own');
withHealUnfrozen(function testRestoreDeletePredicateIsSnapshotScopedStep10() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-24T13:00:00+10:00';
  const WK = '2026-07-06';
  const sumRow = (supplier, loc, total) =>
    [WK, addDaysStr_(WK, 6), supplier, loc, total, TS, 'Cafe', 'spend'];
  const bakRow = (supplier, loc, total, runId) =>
    [WK, addDaysStr_(WK, 6), supplier, loc, total, TS, 'Cafe', 'spend', runId];

  /* ---- Case 1: the probe. A baseline of ONE Kent Paper row; AFTER it froze,
   *      the order-app pull wrote its online-revenue row and labourWeeklyPull_
   *      wrote a Labour row. A restore must undo the Kent Paper row and touch
   *      NEITHER of the other two. Mutation test: reverting the predicate to
   *      `coerceDateStr_(row[0]) === week` makes 1c/1d/1e go red. ---------- */
  currentSS = makeSpreadsheet();
  scriptProps = {};
  const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ.appendRow(sumRow('Kent Paper', 'Leible York', 175.25));          // heal-corrupted, IS in the snapshot
  summ.appendRow(sumRow('shopify_orderapp', 'Leible York', 4321.55));   // written after the baseline
  summ.appendRow(sumRow('Labour', 'Leible North', 2870.4));             // written after the baseline
  ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS)
    .appendRow(bakRow('Kent Paper', 'Leible York', 100, 'RUN-1'));

  const res = restoreWeekFromHealBackup_(WK);

  const live = () => currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()
    .slice(1).filter((r) => coerceDateStr_(r[0]) === WK);
  const totalFor = (supplier) => live()
    .filter((r) => String(r[2]) === supplier)
    .reduce((sum, r) => sum + Number(r[4]), 0);

  eq('FIX1 test1a: the snapshot-owned row is restored to its baseline value (100, not 175.25)',
    totalFor('Kent Paper'), 100);
  eq('FIX1 test1b: exactly one Kent Paper row survives (delete + re-append, never a duplicate)',
    live().filter((r) => String(r[2]) === 'Kent Paper').length, 1);
  eq('FIX1 test1c: the shopify_orderapp row written AFTER the baseline SURVIVES ' +
    '($4,321.55 — the probe case that went 1 -> 0 rows)', totalFor('shopify_orderapp'), 4321.55);
  eq('FIX1 test1d: the Labour row written AFTER the baseline SURVIVES',
    totalFor('Labour'), 2870.4);
  eq('FIX1 test1e: exactly ONE deleteRow call — only the snapshot-owned row',
    summ.getDeleteRowCalls().length, 1);
  eq('FIX1 test1f: the response reports what it PRESERVED, so {restored:N} cannot be ' +
    'read as "the whole week is back to baseline"', res && res.preserved, 2);
  eq('FIX1 test1g: the response still reports the restored count', res && res.restored, 1);
  check('FIX1 test1h: a successful restore carries no refusal', !res.refused);

  /* ---- Case 2: a heal-MINTED key (a supplier/location rename leaves the old
   *      key behind; upsertRows_ has no delete path). It is not in the
   *      snapshot but a heal COULD have written it, so the undo must remove
   *      it — the predicate must not degrade into "preserve everything
   *      unfamiliar". --------------------------------------------------- */
  currentSS = makeSpreadsheet();
  scriptProps = {};
  const summ2 = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ2.appendRow(sumRow('Kent Paper', 'Leible York', 100));            // in the snapshot
  summ2.appendRow(sumRow('Kent Paper', 'Leible York North', 55));       // minted by the bad heal
  summ2.appendRow(sumRow('shopify_orderapp', 'Leible York', 4321.55));  // heal-foreign, must survive
  ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS)
    .appendRow(bakRow('Kent Paper', 'Leible York', 100, 'RUN-1'));

  const res2 = restoreWeekFromHealBackup_(WK);
  const live2 = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()
    .slice(1).filter((r) => coerceDateStr_(r[0]) === WK);

  check('FIX1 test2a: a key MINTED by the bad heal is removed by the undo',
    !live2.some((r) => String(r[3]) === 'Leible York North'));
  check('FIX1 test2b: the heal-foreign row still survives alongside that removal',
    live2.some((r) => String(r[2]) === 'shopify_orderapp' && Number(r[4]) === 4321.55));
  eq('FIX1 test2c: exactly 1 row preserved (the heal-foreign one)', res2 && res2.preserved, 1);

  /* ---- Case 3: the empty-baseline marker — "restore to nothing" still
   *      removes the heal's own output, but a heal-foreign row written after
   *      the baseline is NOT nothing and must survive. ------------------- */
  currentSS = makeSpreadsheet();
  scriptProps = {};
  const summ3 = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ3.appendRow(sumRow('Kent Paper', 'Leible York', 175.25));         // healed into existence
  summ3.appendRow(sumRow('shopify_orderapp', 'Leible York', 4321.55));  // heal-foreign
  ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS)
    .appendRow([WK, addDaysStr_(WK, 6), '', '', 0, TS, '', SUMMARY_HEAL_EMPTY_MARKER_KIND_, 'RUN-1']);

  const res3 = restoreWeekFromHealBackup_(WK);
  const live3 = currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()
    .slice(1).filter((r) => coerceDateStr_(r[0]) === WK);

  check('FIX1 test3a: an empty baseline is not refused as "no-snapshot"',
    !(res3 && res3.refused === 'no-snapshot'));
  check('FIX1 test3b: restoring to an empty baseline removes the heal-created row',
    !live3.some((r) => String(r[2]) === 'Kent Paper'));
  eq('FIX1 test3c: the heal-foreign row survives a "restore to nothing" — it was never ' +
    'part of the heal and has no other copy', live3.length, 1);
  eq('FIX1 test3d: and it still carries its full amount', Number(live3[0][4]), 4321.55);
  eq('FIX1 test3e: the marker itself is never re-inserted as a live row', res3 && res3.restored, 0);

  /* ---- Case 4: the exclusion list is the NARROW one. SUMMARY_AUDIT_PULL_OWNED_
   *      is an audit-NOISE list that also names greenbean/bennetts, whose rows
   *      ARE derived from Suppliers and therefore ARE rebuildable by a heal —
   *      using it as a write filter would wrongly exempt rows a heal owns. -- */
  eq('FIX1 test4a: SUMMARY_HEAL_FOREIGN_SUPPLIERS_ is exactly the two structurally ' +
    'un-recomputable sources', SUMMARY_HEAL_FOREIGN_SUPPLIERS_.slice().sort(),
    ['labour', 'shopify_orderapp']);
  check('FIX1 test4b: it is NOT summary_audit.gs\'s SUMMARY_AUDIT_PULL_OWNED_ — that list ' +
    'also names the DERIVED, rebuildable greenbean/bennetts rows',
    SUMMARY_HEAL_FOREIGN_SUPPLIERS_.indexOf('greenbean') === -1 &&
    SUMMARY_HEAL_FOREIGN_SUPPLIERS_.indexOf('bennetts') === -1 &&
    SUMMARY_AUDIT_PULL_OWNED_.indexOf('greenbean') !== -1);
  // Both consumers must route through summaryRowIsHealForeign_ — a second
  // hardcoded copy of the supplier names inside either body is exactly how the
  // two predicates drift apart the next time the list changes. (Scoped to these
  // two bodies: cleanupOnlineRevenueSummaryRows has its own, unrelated
  // pre-existing shopify_orderapp literal.)
  const step10CodeSrc = fs.readFileSync(path.join(GAS_DIR, 'Code.gs'), 'utf8');
  const step10FnBody = (name) => {
    const parts = step10CodeSrc.split(/^function /m);
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].indexOf(name + '(') === 0) return parts[i];
    }
    return '';
  };
  ['healOrphanCandidates_', 'restoreWeekFromHealBackup_'].forEach((fn) => {
    const body = step10FnBody(fn);
    check('FIX1 test4c: ' + fn + ' routes through summaryRowIsHealForeign_, with no ' +
      'hardcoded copy of the supplier names',
      body.indexOf('summaryRowIsHealForeign_') !== -1 &&
      body.indexOf("'shopify_orderapp'") === -1 && body.indexOf("'labour'") === -1);
  });

  currentSS = savedSS;
  scriptProps = savedProps;
});

/* ------------------------------------------------------------------ */

// summary_audit.gs — step10 FIX2 (IMPORTANT): listSummaryHealBackups must not
// count step9's empty-baseline MARKER as a restorable row.
console.log('summary_audit.gs — step10 FIX2: listSummaryHealBackups does not count the empty-baseline marker as restorable');
withHealUnfrozen(function testListBackupsIgnoresEmptyMarkerStep10() {
  const savedSS = currentSS;
  const TS = '2026-08-24T13:00:00+10:00';
  const MARKED = '2026-07-06';
  const REAL = '2026-07-13';

  currentSS = makeSpreadsheet();
  const backup = ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  backup.appendRow([MARKED, addDaysStr_(MARKED, 6), '', '', 0, TS, '', SUMMARY_HEAL_EMPTY_MARKER_KIND_, 'RUN-1']);
  backup.appendRow([REAL, addDaysStr_(REAL, 6), 'Kent Paper', 'Leible York', 100, TS, 'Cafe', 'spend', 'RUN-1']);

  const result = listSummaryHealBackups();
  const marked = result.weeks.filter((w) => w.week === MARKED)[0];
  const real = result.weeks.filter((w) => w.week === REAL)[0];

  eq('FIX2 test1a: a marker-only week reports 0 restorable rows, not 1', marked && marked.rows, 0);
  eq('FIX2 test1b: and $0, with no phantom row behind it', marked && marked.total, 0);
  check('FIX2 test1c: the week is LABELLED as an empty baseline, so 0/$0 is not read as ' +
    '"nothing was ever backed up"', marked && marked.emptyBaseline === true);
  eq('FIX2 test2a: a genuine snapshot still reports its true row count', real && real.rows, 1);
  eq('FIX2 test2b: and its true total', real && real.total, 100);
  check('FIX2 test2c: a genuine snapshot is not flagged as an empty baseline',
    real && real.emptyBaseline === false);

  currentSS = savedSS;
});

/* ------------------------------------------------------------------ */

// step10 FIX3 (ship gate): the phase froze after 6 gate rounds without
// approval. scripts/deploy.sh pushes the WHOLE project — there is no partial
// deploy — so every WRITE-side entry point the phase added must hard-refuse.
// These tests deliberately do NOT use withHealUnfrozen: they assert the
// SHIPPED state.
console.log('step10 FIX3 (ship gate): every frozen WRITE entry point hard-refuses; the read-only half stays live');
(function testPhaseFreezeRefusalsStep10() {
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-24T13:00:00+10:00';
  const WK = '2026-07-06';

  check('FIX3 test0: the committed source ships with the freeze ON — read from the FILE, ' +
    'so a stray runtime toggle in an earlier test cannot fake this',
    /^var SUMMARY_HEAL_FROZEN_ = true;$/m.test(
      fs.readFileSync(path.join(GAS_DIR, 'Code.gs'), 'utf8')));
  check('FIX3 test0b: and the loaded value agrees (no test left it flipped)',
    globalThis.SUMMARY_HEAL_FROZEN_ === true);

  /* ---- restoreSummaryWeekFromBackup: refuses even fully armed ---------- */
  currentSS = makeSpreadsheet();
  scriptProps = { SUMMARY_RESTORE_WEEK: WK };   // deliberately VALID and pointing at a real snapshot
  const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ.appendRow([WK, addDaysStr_(WK, 6), 'Kent Paper', 'Leible York', 175.25, TS, 'Cafe', 'spend']);
  ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS)
    .appendRow([WK, addDaysStr_(WK, 6), 'Kent Paper', 'Leible York', 100, TS, 'Cafe', 'spend', 'RUN-1']);
  const beforeRestore = JSON.stringify(summ.getDataRange().getValues());

  const restoreRes = restoreSummaryWeekFromBackup();

  check('FIX3 test1a: restoreSummaryWeekFromBackup refuses while frozen, even with a valid ' +
    'SUMMARY_RESTORE_WEEK pointing at a real snapshot',
    !!restoreRes && typeof restoreRes.refused === 'string' && restoreRes.restored === undefined);
  check('FIX3 test1b: the refusal names the freeze, not a missing property — an operator must ' +
    'not go hunting for a config problem that is not there',
    String(restoreRes && restoreRes.refused || '').indexOf('SUMMARY_HEAL_FROZEN_') !== -1);
  eq('FIX3 test1c: zero deleteRow calls', summ.getDeleteRowCalls().length, 0);
  eq('FIX3 test1d: live Summary rows are byte-identical afterwards',
    JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()), beforeRestore);

  /* ---- runSummaryOrphanSweep: refuses even with a fresh, matching approval  */
  currentSS = makeSpreadsheet();
  const summ2 = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  summ2.appendRow([WK, addDaysStr_(WK, 6), 'Kent Paper', 'Leible York', 200, TS, 'Cafe', 'spend']);
  ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
  ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
  scriptProps = {
    SUMMARY_ORPHAN_SWEEP_APPROVED: JSON.stringify({
      count: 1,
      keys: [rowKey_(summ2.getDataRange().getValues()[1], SUMMARY_KEY_COLS)],
      approvedAt: Date.now()
    })
  };
  const beforeSweep = JSON.stringify(summ2.getDataRange().getValues());

  const sweepRes = runSummaryOrphanSweep();

  check('FIX3 test2a: runSummaryOrphanSweep refuses while frozen, even with a fresh ' +
    'matching approval on record',
    !!sweepRes && typeof sweepRes.refused === 'string');
  eq('FIX3 test2b: it deletes nothing', sweepRes && sweepRes.deleted, 0);
  eq('FIX3 test2c: zero deleteRow calls', summ2.getDeleteRowCalls().length, 0);
  eq('FIX3 test2d: live Summary rows are byte-identical afterwards',
    JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()), beforeSweep);
  check('FIX3 test2e: the approval record is NOT consumed by a refusal — a refused sweep must ' +
    'not silently burn the operator\'s dry-run approval',
    !!scriptProps.SUMMARY_ORPHAN_SWEEP_APPROVED);

  /* ---- the multi-week heal window is clamped, and preview follows ------- */
  scriptProps = { SUMMARY_HEAL_ENABLED: 'true', SUMMARY_HEAL_WEEKS: '12' };
  eq('FIX3 test3a: SUMMARY_HEAL_ENABLED=true cannot widen the window past 1 while frozen',
    summaryHealWindowSize_(), 1);

  currentSS = makeSpreadsheet();
  ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
  ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
  const preview = previewSummaryHeal();
  // Captured HERE: `currentSS` is re-pointed by the dual-shape case below, and
  // "preview writes nothing" is only meaningful against the sheet preview ran on.
  const previewSummaryLen =
    currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues().length;
  eq('FIX3 test3b: previewSummaryHeal shows the CLAMPED window — the freeze is applied in ' +
    'summaryHealWindowSize_, so preview can never diverge from what the run would heal',
    preview.weeks.length, 1);

  /* ---- the DUAL return shape is unreachable while frozen ---------------- */
  // weeklySummarize returns TWO incompatible shapes, switched on window size.
  // The multi-week one omits `refused`, and greenBeanPull_'s completion test
  // (orderapp.gs: `if (sumRes && !sumRes.refused)`) reads an all-refused
  // multi-week run as SUCCESS and drains the queue, losing the backlog.
  // Clamping the window to 1 makes weeks.length === 1 on every path, so only
  // the flat shape — which does carry `refused` — can be produced at all.
  // Week derived from todayStr_(), never a hardcoded date: this must not start
  // failing next Monday.
  const WK10 = getLastCompletedWeek_(todayStr_()).start;
  currentSS = makeSpreadsheet();
  ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS)
    .appendRow([addDaysStr_(WK10, 2), 'Kent Paper', 175.25, 'K1', 'Leible York', 'src', TS, 'Cafe']);
  ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS)
    .appendRow([WK10, addDaysStr_(WK10, 6), 'Kent Paper', 'Leible York', 100, TS, 'Cafe', 'spend']);
  ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
  // An _archive row inside the same week makes it SPLIT, so the guarded write
  // REFUSES — the case whose refusal greenBeanPull_ has to be able to see.
  ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS)
    .appendRow([addDaysStr_(WK10, 3), 'Fresh and Chill', 50, 'F1', 'Leible North', 'src', TS, 'Cafe']);
  ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  scriptProps = { SUMMARY_HEAL_ENABLED: 'true', SUMMARY_HEAL_WEEKS: '4' };

  const sumRes10 = weeklySummarize();

  check('FIX3 test5a: while frozen, weeklySummarize never returns the MULTI-week shape ' +
    '(no `weeks` array at the top level)',
    !!sumRes10 && sumRes10.weeks === undefined);
  check('FIX3 test5b: a refused run carries `refused` at the top level — the field ' +
    "greenBeanPull_'s completion test reads; the multi-week shape omits it, so an " +
    'all-refused run would read as success and drain the queue',
    typeof (sumRes10 || {}).refused === 'string');

  /* ---- the read-only half is deliberately NOT frozen -------------------- */
  check('FIX3 test4a: previewSummaryHeal still returns a plan while frozen (read-only, shipped)',
    !!preview && Array.isArray(preview.weeks));
  eq('FIX3 test4b: and writes nothing — the header row and nothing else',
    previewSummaryLen, 1);
  check('FIX3 test4c: the drift guard is still installed as a live entry point',
    typeof checkSummaryDrift === 'function');
  check('FIX3 test4d: the read-only backup listing is still a live entry point',
    typeof listSummaryHealBackups === 'function');
  check('FIX3 test4e: the read-only orphan DRY RUN is still a live entry point',
    typeof runSummaryOrphanSweepDryRun === 'function');

  currentSS = savedSS;
  scriptProps = savedProps;
})();

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * UNFREEZE step 1 — weeklySummarize's TWO return shapes are incompatible.
 *
 * weeklySummarize_impl_ returns a flat shape for a single week
 * (weekStart/weekEnd/refused/summariesAdded/summariesUpdated/labourTabAdded/
 * labourSummaryAdded) and a completely different nested shape for a
 * multi-week heal ({weeks, success, newestWeekFailed, weekStart, weekEnd}) —
 * with NO `refused` key and NO counters at all.
 *
 * The freeze hides this by clamping summaryHealWindowSize_ to 1, so the
 * multi-week shape is currently unreachable in production. Lifting the
 * freeze re-exposes it, and every caller that asks "did this complete?" by
 * testing `!res.refused` (greenBeanPull_, orderapp.gs) then reads an
 * all-refused multi-week run as SUCCESS and drops the week from the resum
 * queue — Summary stays stale forever with no alert.
 *
 * The fix: the multi-week shape becomes a strict SUPERSET of the single-week
 * one. `refused` is present exactly when ZERO weeks healed (a PARTIAL heal is
 * not a refusal), and carries the newest week's action so it means the same
 * thing it means today. greenBeanPull_'s completion test becomes POSITIVE —
 * the returned weekStart must be the week it asked for.
 * ------------------------------------------------------------------ */
withHealUnfrozen(function testWeeklySummarizeReturnShapeUnfreeze() {
  console.log('\nunfreeze step1 (Code.gs): the multi-week return is a superset of the single-week shape:');
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const TS = '2026-08-24T13:00:00+10:00';
  const NOW = '2026-08-24T02:00:00Z';   // Mon 24 Aug 2026 Sydney — wk-1 = 2026-08-17
  const WK1 = '2026-08-17', WK2 = '2026-08-10', WK3 = '2026-08-03', WK4 = '2026-07-27';

  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];
  const sum = (wk, supplier, loc, total) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, 'Cafe', 'spend'];

  function seed(supplierRows, summaryRows, archiveRows) {
    currentSS = makeSpreadsheet();
    scriptProps = {};
    const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    supplierRows.forEach((r) => supp.appendRow(r));
    const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
    summaryRows.forEach((r) => summ.appendRow(r));
    ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
    const arch = ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
    (archiveRows || []).forEach((r) => arch.appendRow(r));
    ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);
  }

  const FOUR_SUPPLIERS = [
    sup('2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York'),
    sup('2026-08-12', 'Kent Paper', 200, 'K2', 'Leible York'),
    sup('2026-08-05', 'Kent Paper', 300, 'K3', 'Leible York'),
    sup('2026-07-29', 'Kent Paper', 400, 'K4', 'Leible York')];
  const FOUR_SUMMARY = [
    sum(WK1, 'Kent Paper', 'Leible York', 100),
    sum(WK2, 'Kent Paper', 'Leible York', 100),
    sum(WK3, 'Kent Paper', 'Leible York', 100),
    sum(WK4, 'Kent Paper', 'Leible York', 100)];

  /* ---- test1: a 4-week heal reports the SAME counters a 1-week heal does -- */
  seed(FOUR_SUPPLIERS, FOUR_SUMMARY);
  withMockNow(NOW, function () {
    scriptProps = { SUMMARY_HEAL_ENABLED: 'true' };
    calendarEvents = [];
    const res = weeklySummarize();
    eq('unfreeze test1a: the multi-week detail is still reported', res.weeks.length, 4);
    check('unfreeze test1b: summariesAdded is a number, not undefined (callers do arithmetic on it)',
      typeof res.summariesAdded === 'number');
    check('unfreeze test1c: summariesUpdated is a number, not undefined',
      typeof res.summariesUpdated === 'number');
    check('unfreeze test1d: labourTabAdded is a number, not undefined',
      typeof res.labourTabAdded === 'number');
    check('unfreeze test1e: labourSummaryAdded is a number, not undefined',
      typeof res.labourSummaryAdded === 'number');
    eq('unfreeze test1f: summariesUpdated is the SUM across the whole window, not one week',
      res.summariesUpdated,
      res.weeks.reduce((n, w) => n + (w.rowsUpdated || 0), 0));
    eq('unfreeze test1g: summariesAdded is the SUM across the whole window',
      res.summariesAdded,
      res.weeks.reduce((n, w) => n + (w.rowsAdded || 0), 0));
    check('unfreeze test1h: a fully successful heal reports NO refusal', !res.refused);
  });

  /* ---- test2: every week refused -> the run says so at the TOP level ----- */
  // Suppliers rows AND _archive rows in all four weeks => every week SPLIT =>
  // healWeek_ writes nothing for any of them. Today the caller cannot tell.
  seed(FOUR_SUPPLIERS, FOUR_SUMMARY, [
    sup('2026-08-20', 'Fresh and Chill', 50, 'F1', 'Leible North'),
    sup('2026-08-13', 'Fresh and Chill', 50, 'F2', 'Leible North'),
    sup('2026-08-06', 'Fresh and Chill', 50, 'F3', 'Leible North'),
    sup('2026-07-30', 'Fresh and Chill', 50, 'F4', 'Leible North')]);
  withMockNow(NOW, function () {
    scriptProps = { SUMMARY_HEAL_ENABLED: 'true' };
    calendarEvents = [];
    const before = JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues());
    const res = weeklySummarize();
    eq('unfreeze test2a setup: all four weeks really were refused',
      res.weeks.filter((w) => w.action === 'heal').length, 0);
    eq('unfreeze test2b setup: Summary is byte-identical — nothing was written',
      JSON.stringify(currentSS.getSheetByName(SUMMARY_TAB).getDataRange().getValues()), before);
    eq('unfreeze test2c: a run that healed NOTHING reports refused at the top level, ' +
      'carrying the newest week action exactly as the single-week shape does',
      res.refused, 'skip-split');
    eq('unfreeze test2d: and reports zero counters, never undefined', res.summariesUpdated, 0);
  });

  /* ---- test3: a PARTIAL heal is not a refusal --------------------------- */
  // Newest week healable, the three older ones SPLIT. Real work happened, so
  // `refused` must stay absent or a caller would discard a completed week.
  seed(FOUR_SUPPLIERS, FOUR_SUMMARY, [
    sup('2026-08-13', 'Fresh and Chill', 50, 'F2', 'Leible North'),
    sup('2026-08-06', 'Fresh and Chill', 50, 'F3', 'Leible North'),
    sup('2026-07-30', 'Fresh and Chill', 50, 'F4', 'Leible North')]);
  withMockNow(NOW, function () {
    scriptProps = { SUMMARY_HEAL_ENABLED: 'true' };
    calendarEvents = [];
    const res = weeklySummarize();
    eq('unfreeze test3a setup: exactly one week healed',
      res.weeks.filter((w) => w.action === 'heal').length, 1);
    check('unfreeze test3b: a PARTIAL heal is NOT reported as a refusal', !res.refused);
    check('unfreeze test3c: and its counters reflect the week that did heal',
      res.summariesUpdated > 0 || res.summariesAdded > 0);
  });

  currentSS = savedSS;
  scriptProps = savedProps;
});

/* ------------------------------------------------------------------ *
 * UNFREEZE step 1 (orderapp.gs) — greenBeanPull_'s completion test must be
 * POSITIVE. `!sumRes.refused` is a negative test: it passes for any return
 * shape that simply lacks the key, including the multi-week shape and any
 * future one. The queue is the SOLE record of pending weeks, so a false
 * "completed" silently drops the week and Summary stays stale forever.
 * ------------------------------------------------------------------ */
(function testGreenBeanCompletionTestUnfreeze() {
  console.log('\nunfreeze step1 (orderapp.gs): greenBeanPull_ requires a POSITIVE completion signal:');
  const REAL_URL_FETCH = global.UrlFetchApp;
  const REAL_WEEKLY_SUMMARIZE = global.weeklySummarize;
  const savedSS = currentSS;
  const savedProps = scriptProps;

  const weeks = lastCompletedWeeks_(todayStr_(), 4);
  currentSS = makeSpreadsheet();
  scriptProps = { ORDER_APP_COST_TOKEN: 'gb-token' };
  clearLoggedMessages();

  const rows = [{ rowNumber: 1, dateLocal: weeks[0].start, supplierRaw: 'Z1', supplierKey: 'z1',
    invoiceNum: 'Z-1', totalCostIncGst: 10, status: 'RECEIVED' }];
  global.UrlFetchApp = {
    fetch: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true,
        meta: { paging: { truncated: false, rowsIncluded: true, returned: rows.length } }, rows: rows })
    }),
  };

  // The multi-week shape EXACTLY as weeklySummarize_impl_ returns it once the
  // freeze is lifted: no `refused` key at all, every week refused, and a
  // weekStart that is not the week greenBeanPull_ asked for.
  global.weeklySummarize = function () {
    return {
      weeks: [{ week: '2020-01-06', action: 'skip-split' }],
      success: false, newestWeekFailed: true,
      weekStart: '2020-01-06', weekEnd: '2020-01-12'
    };
  };

  const res = greenBeanPull_impl_();
  const raw = scriptProps[GREENBEAN_RESUM_QUEUE_PROP];
  const queue = raw ? JSON.parse(raw) : [];

  check('unfreeze test4a: a return that healed a DIFFERENT week leaves the requested week QUEUED',
    queue.indexOf(weeks[0].start) !== -1);
  eq('unfreeze test4b: and is not counted as resummarized', res.weeksResummarized, 0);
  check('unfreeze test4c: the non-completion is logged, not silently swallowed',
    lastLoggedMessages().some((m) => m.indexOf('did not complete for ' + weeks[0].start) !== -1));

  global.UrlFetchApp = REAL_URL_FETCH;
  global.weeklySummarize = REAL_WEEKLY_SUMMARIZE;
  currentSS = savedSS;
  scriptProps = savedProps;
})();


/* ------------------------------------------------------------------ *
 * UNFREEZE step 2 — the three MINORs left open by the phase gate.
 * ------------------------------------------------------------------ */

/* MINOR 1 (staleness.gs) — raiseCalendarAlert_ creates the event, THEN
 * decorates it, all inside one try. If setColor/setDescription throws the
 * catch reports 0 ("nothing raised") and never marks the dedup cache — but
 * the event is already on the calendar. Two consequences, both bad: the same
 * batch creates a DUPLICATE event for the same title, and tomorrow's
 * stalenessLoadExistingTitles_ sees the phantom and suppresses the real
 * alert. Creation is the success point; decoration is best-effort.
 * ------------------------------------------------------------------ */
(function testRaiseCalendarAlertPartialEventMinor1() {
  console.log('\nunfreeze MINOR1 (staleness.gs): a decoration throw must not leave an uncounted phantom event:');
  const REAL_CAL = global.CalendarApp._cal;

  // A calendar whose createAllDayEvent SUCCEEDS but whose returned event
  // throws on setDescription — the real-world Calendar API partial failure.
  global.CalendarApp._cal = (id) => ({
    _id: id,
    getEventsForDay: () => calendarEvents.slice(),
    createAllDayEvent: (title, date) => {
      const ev = makeCalEvent(title, date);
      calendarEvents.push(ev);
      ev.setDescription = () => { throw new Error('simulated Calendar API failure'); };
      return ev;
    },
  });

  calendarEvents = [];
  calendarFailMode = null;
  clearLoggedMessages();

  const cache = stalenessNewEventsCache_();
  const n1 = raiseCalendarAlert_('LEIBLE partial-event probe', ['line one'], 'ORANGE', Date.now(), cache);

  eq('MINOR1 test1a setup: the event really WAS created on the calendar', calendarEvents.length, 1);
  eq('MINOR1 test1b: a created-but-undecorated event is REPORTED as raised, not 0',
    n1, 1);

  const n2 = raiseCalendarAlert_('LEIBLE partial-event probe', ['line one'], 'ORANGE', Date.now(), cache);
  eq('MINOR1 test1c: a second call for the same title creates NO duplicate event',
    calendarEvents.length, 1);
  eq('MINOR1 test1d: ...and reports 0, because the alert already exists', n2, 0);
  check('MINOR1 test1e: the decoration failure is logged in its own right',
    lastLoggedMessages().some((m) => m.indexOf('decorate') !== -1));

  global.CalendarApp._cal = REAL_CAL;
  calendarEvents = [];
})();

/* MINOR 2 (Code.gs) — healWeeks_ seeds `backedUpWeeks` straight from the
 * backup tab with no DATE_ARG_RE guard, three lines after seeding
 * `archiveWeeks` WITH one. `backedUpWeeks` gates whether a destructive heal
 * takes its backup first (healWeek_: `if (ctx.backedUpWeeks[week]) return
 * true`), so junk keys have no business being in it. Asserted on the ctx the
 * driver actually hands healWeek_.
 * ------------------------------------------------------------------ */
withHealUnfrozen(function testHealWeeksBackedUpWeeksGuardMinor2() {
  console.log('\nunfreeze MINOR2 (Code.gs): only real week keys may enter healWeeks_ backedUpWeeks:');
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const savedHealWeek = globalThis.healWeek_;

  currentSS = makeSpreadsheet();
  scriptProps = {};
  ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
  ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
  ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
  const backup = ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);

  const pad = (first) => {
    const r = new Array(SUMMARY_HEAL_BACKUP_HEADERS.length).fill('');
    r[0] = first;
    return r;
  };
  backup.appendRow(pad('2026-08-10'));   // the one genuine week
  backup.appendRow(pad(''));             // a blank row
  backup.appendRow(pad('not a date'));   // a note somebody typed in
  backup.appendRow(pad('2026-8-3'));     // unpadded — NOT the canonical form

  // Stubbed so the assertion is on the ctx the DRIVER builds, with no write
  // of any kind — this is about what healWeeks_ puts in the map, nothing else.
  let seenCtx = null;
  globalThis.healWeek_ = function (week, ctx) {
    seenCtx = ctx;
    return { week: week, action: 'skip-split', reason: 'stubbed', rowsAdded: 0,
      rowsUpdated: 0, duplicatesSkipped: 0, updates: [], orphans: [], backedUp: true };
  };

  healWeeks_(['2026-08-17']);

  const keys = Object.keys(seenCtx.backedUpWeeks);
  check('MINOR2 test2a setup: the driver really did hand healWeek_ a ctx', !!seenCtx);
  eq('MINOR2 test2b: every backedUpWeeks key is a canonical YYYY-MM-DD week',
    keys.filter((k) => !DATE_ARG_RE.test(k)), []);
  check('MINOR2 test2c: the one genuine backup week is still recognised',
    seenCtx.backedUpWeeks['2026-08-10'] === true);

  globalThis.healWeek_ = savedHealWeek;
  currentSS = savedSS;
  scriptProps = savedProps;
});

/* MINOR 3 (Code.gs) — the Labour correction alert builds its calendar TITLE
 * from the joined healed-week list. Calendar alerts dedup on exact title, so
 * the title must be stable and bounded: a joined list grows with the heal
 * window (invisible while the window is clamped to 1, which is exactly why
 * this is unfreeze work) and a different week set re-alerts for the same
 * condition. The week list belongs in the description.
 * ------------------------------------------------------------------ */
withHealUnfrozen(function testLabourAlertTitleMinor3() {
  console.log('\nunfreeze MINOR3 (Code.gs): the Labour correction alert title is bounded and stable:');
  const savedSS = currentSS;
  const savedProps = scriptProps;
  const savedLabour = globalThis.labourWeeklyPull_;
  const TS = '2026-08-24T13:00:00+10:00';
  const NOW = '2026-08-24T02:00:00Z';
  const WK1 = '2026-08-17', WK2 = '2026-08-10', WK3 = '2026-08-03', WK4 = '2026-07-27';

  const sup = (date, supplier, total, ref, loc) =>
    [date, supplier, total, ref, loc, 'src', TS, 'Cafe'];
  const sum = (wk, supplier, loc, total) =>
    [wk, addDaysStr_(wk, 6), supplier, loc, total, TS, 'Cafe', 'spend'];

  currentSS = makeSpreadsheet();
  scriptProps = {};
  const supp = ensureSheet(currentSS, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
  [sup('2026-08-19', 'Kent Paper', 175.25, 'K1', 'Leible York'),
   sup('2026-08-12', 'Kent Paper', 200, 'K2', 'Leible York'),
   sup('2026-08-05', 'Kent Paper', 300, 'K3', 'Leible York'),
   sup('2026-07-29', 'Kent Paper', 400, 'K4', 'Leible York')].forEach((r) => supp.appendRow(r));
  const summ = ensureSheet(currentSS, SUMMARY_TAB, SUMMARY_HEADERS);
  [sum(WK1, 'Kent Paper', 'Leible York', 100),
   sum(WK2, 'Kent Paper', 'Leible York', 100),
   sum(WK3, 'Kent Paper', 'Leible York', 100),
   sum(WK4, 'Kent Paper', 'Leible York', 100)].forEach((r) => summ.appendRow(r));
  ensureSheet(currentSS, REVENUE_TAB, REVENUE_HEADERS);
  ensureSheet(currentSS, ARCHIVE_TAB, SUPPLIERS_HEADERS);
  ensureSheet(currentSS, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);

  // A genuine correction across the whole batch — summaryUpdated > 0 is what
  // arms the alert (step7 FIX4: never on a first-time insert).
  globalThis.labourWeeklyPull_ = function () {
    return { labourAdded: 1, summaryAdded: 0, summaryUpdated: 2 };
  };

  calendarEvents = [];
  withMockNow(NOW, function () {
    scriptProps = { SUMMARY_HEAL_ENABLED: 'true' };
    weeklySummarize();
  });

  const labourEv = calendarEvents.filter((e) => e.getTitle().indexOf('Labour correction') !== -1)[0];
  check('MINOR3 test3a setup: a Labour correction alert was raised at all', !!labourEv);
  if (labourEv) {
    const title = labourEv.getTitle();
    check('MINOR3 test3b: the TITLE does not embed the joined week list',
      title.indexOf(WK2) === -1 && title.indexOf(WK3) === -1 && title.indexOf(WK4) === -1);
    check('MINOR3 test3c: it anchors on the NEWEST healed week, like every other heal alert',
      title.indexOf(WK1) !== -1);
    check('MINOR3 test3d: and states how many weeks it covers',
      title.indexOf('4 week') !== -1);
    check('MINOR3 test3e: every healed week is still recorded, in the DESCRIPTION',
      [WK1, WK2, WK3, WK4].every((w) => labourEv._description.indexOf(w) !== -1));
  }

  globalThis.labourWeeklyPull_ = savedLabour;
  calendarEvents = [];
  currentSS = savedSS;
  scriptProps = savedProps;
});


console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
