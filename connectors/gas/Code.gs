/**
 * Code.gs — LEIBLE Expense Hub core.
 *
 * doPost ingest endpoint + normalization + dedup + Sheet helpers, shared by
 * every connector. Three tabs (see docs/schema.md):
 *   Suppliers : date | supplier | total | invoice_ref | location | source | extracted_at
 *   Sales     : date | location | gross_sales | source | extracted_at
 *   Labour    : week_start | week_end | location | total | iso_week | pulled_at
 *
 * Pure logic (normalizeSupplierRow / ingestSupplierRows / validateIngest_ /
 * appendNewRows_) is exercised by connectors/gas/test_code.js under a Node mock
 * of SpreadsheetApp — keep these functions free of editor-only globals.
 */

var SUPPLIERS_TAB = 'Suppliers';
var SALES_TAB = 'Sales';
var STAGING_TAB = '_staging';
var SUMMARY_TAB = 'Summary';
var ARCHIVE_TAB = '_archive';
var LABOUR_TAB = 'Labour';

var SUMMARY_HEADERS = ['week_start', 'week_end', 'supplier', 'location', 'total_spend', 'summarized_at'];
var LABOUR_HEADERS = ['week_start', 'week_end', 'location', 'total', 'iso_week', 'pulled_at'];

var ARCHIVE_RETENTION_DAYS = 183;

var SUPPLIERS_HEADERS = ['date', 'supplier', 'total', 'invoice_ref', 'location', 'source', 'extracted_at'];
var SALES_HEADERS = ['date', 'location', 'gross_sales', 'source', 'extracted_at'];

// Dedup column indexes into a normalized row array.
var SUPPLIERS_KEY_COLS = [5, 3]; // source + invoice_ref
var SALES_KEY_COLS = [0, 1];     // date + location

// source → canonical supplier name. Ordermentum carries its name per-account in
// the row payload (row.supplier), so it is intentionally absent here.
var SUPPLIER_NAMES = {
  food_dairy_co: 'Food and Dairy Co',
  fresh_and_chill: 'Fresh and Chill',
  kent_paper: 'Kent Paper',
  mayers: 'Mayers'
};

/* ------------------------------------------------------------------ *
 * Web-app entry point
 * ------------------------------------------------------------------ */

/**
 * doPost — receives a supplier ingest payload from a Playwright connector.
 * Body: { source, rows:[{date, total, invoice_ref, location?, supplier?}], extracted_at }
 * Writes new rows to the Suppliers tab (dedup on source+invoice_ref).
 * @returns {ContentService.TextOutput} JSON { result, rowsAdded, duplicatesSkipped }
 */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var check = validateIngest_(body);
    if (!check.ok) return jsonOut_({ result: 'error', message: check.message });

    var ss = getHubSpreadsheet_();
    var sheet = ensureSheet(ss, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
    var res = ingestSupplierRows(body.source, body.rows, body.extracted_at, sheet);

    return jsonOut_({ result: 'ok', rowsAdded: res.rowsAdded, duplicatesSkipped: res.duplicatesSkipped });
  } catch (err) {
    return jsonOut_({ result: 'error', message: String((err && err.message) || err) });
  }
}

/* ------------------------------------------------------------------ *
 * Validation + normalization (pure, unit-tested)
 * ------------------------------------------------------------------ */

/**
 * Validate an ingest payload. Returns { ok:boolean, message?:string }.
 */
function validateIngest_(body) {
  if (!body || typeof body !== 'object') return { ok: false, message: 'body is not an object' };
  if (!body.source || typeof body.source !== 'string') return { ok: false, message: 'missing source' };
  if (!Array.isArray(body.rows)) return { ok: false, message: 'missing rows array' };
  if (!body.extracted_at) return { ok: false, message: 'missing extracted_at' };

  for (var i = 0; i < body.rows.length; i++) {
    var r = body.rows[i];
    if (!r || typeof r !== 'object') return { ok: false, message: 'row ' + i + ' is not an object' };
    if (!r.date) return { ok: false, message: 'row ' + i + ' missing date' };
    if (r.total === undefined || r.total === null || isNaN(Number(r.total))) {
      return { ok: false, message: 'row ' + i + ' missing/invalid total' };
    }
    if (!r.invoice_ref) return { ok: false, message: 'row ' + i + ' missing invoice_ref' };
  }
  return { ok: true };
}

/**
 * Resolve the canonical supplier name. Per-row `supplier` (Ordermentum) wins;
 * otherwise fall back to the SUPPLIER_NAMES map, then the raw source.
 */
function canonicalSupplier_(source, row) {
  if (row && row.supplier) return String(row.supplier);
  return SUPPLIER_NAMES[source] || source;
}

/**
 * Map a raw supplier row to the Suppliers column order.
 * @returns {Array} [date, supplier, total, invoice_ref, location, source, extracted_at]
 */
function normalizeSupplierRow(row, source, extractedAt) {
  return [
    String(row.date),
    canonicalSupplier_(source, row),
    Number(row.total),
    String(row.invoice_ref),
    row.location ? String(row.location) : '',
    source,
    extractedAt
  ];
}

/* ------------------------------------------------------------------ *
 * Ingest + dedup
 * ------------------------------------------------------------------ */

/**
 * Normalize + dedup + append a batch of supplier rows to a sheet.
 * Dedup is against existing sheet rows AND earlier rows in the same batch.
 * @returns {{rowsAdded:number, duplicatesSkipped:number}}
 */
function ingestSupplierRows(source, rows, extractedAt, sheet) {
  var seen = buildKeySet_(sheet, SUPPLIERS_KEY_COLS);
  var toAppend = [];
  var duplicates = 0;

  for (var i = 0; i < rows.length; i++) {
    var normalized = normalizeSupplierRow(rows[i], source, extractedAt);
    var key = rowKey_(normalized, SUPPLIERS_KEY_COLS);
    if (seen[key]) { duplicates++; continue; }
    seen[key] = true;
    toAppend.push(normalized);
  }

  appendNewRows_(sheet, toAppend);
  return { rowsAdded: toAppend.length, duplicatesSkipped: duplicates };
}

/**
 * Append a single normalized row to a sheet if its dedup key is new.
 * Used by the Square connector (one row per location/day).
 * @returns {boolean} true if appended, false if duplicate
 */
function appendSalesRow_(sheet, normalizedRow) {
  var seen = buildKeySet_(sheet, SALES_KEY_COLS);
  var key = rowKey_(normalizedRow, SALES_KEY_COLS);
  if (seen[key]) return false;
  appendNewRows_(sheet, [normalizedRow]);
  return true;
}

/**
 * Build a lookup of existing dedup keys from a sheet (skips the header row).
 * @returns {Object} { key: true }
 */
function buildKeySet_(sheet, keyCols) {
  var set = {};
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) { // row 0 = header
    set[rowKey_(values[r], keyCols)] = true;
  }
  return set;
}

function rowKey_(rowArray, keyCols) {
  var parts = [];
  for (var i = 0; i < keyCols.length; i++) {
    parts.push(String(rowArray[keyCols[i]]).trim().toLowerCase());
  }
  return parts.join('||');
}

function appendNewRows_(sheet, rows) {
  for (var i = 0; i < rows.length; i++) sheet.appendRow(rows[i]);
}

/* ------------------------------------------------------------------ *
 * One-time / idempotent setup
 * ------------------------------------------------------------------ */

/**
 * setupSheets — materialize the two-tab schema in the hub Sheet.
 * Idempotent: ensureSheet only creates + formats tabs that are missing, so
 * running this repeatedly is safe and never touches existing data.
 * Run once from the Apps Script editor (or `clasp run setupSheets`) to seed
 * headers; doPost/connectors also call ensureSheet lazily on first write.
 *   Suppliers : date | supplier | total | invoice_ref | location | source | extracted_at
 *   Sales     : date | location | gross_sales | source | extracted_at
 *   _staging  : same columns as Suppliers (scratch area, see docs/schema.md)
 * @returns {string} human-readable summary of which tabs exist
 */
function setupSheets() {
  var ss = getHubSpreadsheet_();
  ensureSheet(ss, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
  ensureSheet(ss, SALES_TAB, SALES_HEADERS);
  ensureSheet(ss, STAGING_TAB, SUPPLIERS_HEADERS);
  ensureSheet(ss, LABOUR_TAB, LABOUR_HEADERS);
  var summary = 'Tabs ready: ' + SUPPLIERS_TAB + ', ' + SALES_TAB + ', ' + STAGING_TAB + ', ' + LABOUR_TAB;
  Logger.log(summary);
  return summary;
}

/* ------------------------------------------------------------------ *
 * Labour-cost pull (reads Onboarding app LABOUR_COST sheet)
 * ------------------------------------------------------------------ */

/**
 * Get the Onboarding app spreadsheet that owns LABOUR_COST.
 * Requires script property LABOUR_SHEET_ID (DEV: 1SUg3rE5V46HQ7JtZzqus960KdLjxJd6AdcrYDq8zyGs).
 * Returns null (never throws) so callers can guard cleanly.
 */
function getLabourSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('LABOUR_SHEET_ID');
  if (!id) { Logger.log('labourWeeklyPull_: LABOUR_SHEET_ID not set — skipping'); return null; }
  try { return SpreadsheetApp.openById(id); }
  catch (e) { Logger.log('labourWeeklyPull_: cannot open LABOUR_SHEET_ID — ' + e.message); return null; }
}

/**
 * Pull labour cost for the given week from the Onboarding app LABOUR_COST sheet.
 * Writes to the Labour tab (dedup week_start||location) AND to Summary (supplier='Labour').
 * Safe to call with empty/missing source — logs and returns zeros without writing garbage.
 *
 * @param {{start:string,end:string}} week  ISO date strings (week.start, week.end)
 * @param {Spreadsheet}              ss     Hub spreadsheet
 * @param {Sheet}                    summSheet  Already-open Summary sheet
 * @param {string}                   pulledAt   ISO timestamp string
 * @returns {{labourAdded:number, summaryAdded:number}}
 */
function labourWeeklyPull_(week, ss, summSheet, pulledAt) {
  var labourSheet = ensureSheet(ss, LABOUR_TAB, LABOUR_HEADERS);

  var srcSS = getLabourSpreadsheet_();
  if (!srcSS) return { labourAdded: 0, summaryAdded: 0 };

  var srcSheet = srcSS.getSheetByName('LABOUR_COST');
  if (!srcSheet) {
    Logger.log('labourWeeklyPull_: LABOUR_COST tab not found in source — skipping');
    return { labourAdded: 0, summaryAdded: 0 };
  }

  var srcData = srcSheet.getDataRange().getValues();
  if (srcData.length <= 1) {
    Logger.log('labourWeeklyPull_: LABOUR_COST is empty — skipping');
    return { labourAdded: 0, summaryAdded: 0 };
  }

  // Map source headers → column indexes
  var hdr = srcData[0];
  var col = {};
  for (var h = 0; h < hdr.length; h++) col[String(hdr[h])] = h;

  // Build dedup sets for Labour tab and Summary tab
  var labourKeys = {};
  var labourData = labourSheet.getDataRange().getValues();
  for (var r = 1; r < labourData.length; r++) {
    labourKeys[String(labourData[r][0]) + '||' + String(labourData[r][2])] = true;
  }

  var summData = summSheet.getDataRange().getValues();
  var summKeys = {};
  for (var r = 1; r < summData.length; r++) {
    summKeys[String(summData[r][0]) + '||' + String(summData[r][2]) + '||' + String(summData[r][3])] = true;
  }

  var labourAdded = 0, summaryAdded = 0;

  for (var i = 1; i < srcData.length; i++) {
    var row = srcData[i];
    var ws = coerceDateStr_(row[col['week_start']]);
    if (ws !== week.start) continue;

    var location = String(row[col['location']] || '');
    var total    = Math.round(Number(row[col['total']] || 0) * 100) / 100;
    var isoWeek  = String(row[col['iso_week']] || '');
    var we       = coerceDateStr_(row[col['week_end']]);

    // Write to Labour tab
    var lKey = ws + '||' + location;
    if (!labourKeys[lKey]) {
      labourSheet.appendRow([ws, we, location, total, isoWeek, pulledAt]);
      labourKeys[lKey] = true;
      labourAdded++;
    }

    // Write to Summary as supplier='Labour'
    var sKey = ws + '||Labour||' + location;
    if (!summKeys[sKey]) {
      summSheet.appendRow([ws, we, 'Labour', location, total, pulledAt]);
      summKeys[sKey] = true;
      summaryAdded++;
    }
  }

  Logger.log('labourWeeklyPull_: week=' + week.start + ' labourAdded=' + labourAdded + ' summaryAdded=' + summaryAdded);
  return { labourAdded: labourAdded, summaryAdded: summaryAdded };
}

/* ------------------------------------------------------------------ *
 * Sheet + output helpers
 * ------------------------------------------------------------------ */

/**
 * Get the hub spreadsheet — by HUB_SHEET_ID script property if set, else the
 * bound active spreadsheet.
 */
function getHubSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('HUB_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('No hub spreadsheet: set HUB_SHEET_ID script property or bind the project to a Sheet.');
}

/**
 * Ensure a tab exists with the given headers; create + format if missing.
 * Lifted from LEIBLE_Oder_app/Engine_Utils.js (sage header, frozen row 1).
 */
function ensureSheet(ss, sheetName, headers) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length)
      .setBackground('#a5b89d').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * ONE-SHOT cleanup: fix Ordermentum supplier labels + delete rows from
 * suppliers outside the tuga/allie/butterboy filter.
 * Run once from the Apps Script editor, then delete this function.
 */
function cleanupOrdermentumRows() {
  var RENAME = {
    'Wholesale Cookies PTY LTD': 'Butterboy',
    'Tuga Pastries Australia Pty Ltd': 'Tuga Pastries Australia'
  };
  var KEEP = ['butterboy', 'tuga pastries australia', "allie's foods"];

  var ss = getHubSpreadsheet_();
  var sheet = ss.getSheetByName(SUPPLIERS_TAB);
  if (!sheet) { Logger.log('No Suppliers tab'); return; }

  var data = sheet.getDataRange().getValues();
  var supplierCol = 1; // B
  var sourceCol = 5;   // F

  var renamed = 0, deleted = 0;

  // Pass 1: rename (top-down is fine for in-place edits)
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][sourceCol]).toLowerCase() !== 'ordermentum') continue;
    var old = String(data[r][supplierCol]);
    if (RENAME[old]) {
      sheet.getRange(r + 1, supplierCol + 1).setValue(RENAME[old]);
      data[r][supplierCol] = RENAME[old]; // update local copy for pass 2
      renamed++;
    }
  }

  // Pass 2: delete non-allowed ordermentum rows (bottom-up to avoid row-shift)
  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][sourceCol]).toLowerCase() !== 'ordermentum') continue;
    var name = String(data[r][supplierCol]).toLowerCase();
    var allowed = false;
    for (var k = 0; k < KEEP.length; k++) {
      if (name === KEEP[k]) { allowed = true; break; }
    }
    if (!allowed) {
      sheet.deleteRow(r + 1);
      deleted++;
    }
  }

  var msg = 'Cleanup done: renamed=' + renamed + ', deleted=' + deleted;
  Logger.log(msg);
  return msg;
}

/**
 * One-shot fix for the 2026-06-22 Fresh & Chill North mis-seed: the North session
 * was accidentally a different shop's account, so rows tagged location='Leible North'
 * are actually another shop's orders. Delete them all; a fresh connector run then
 * repopulates correct North orders (and un-blocks the other shop's real rows).
 * Run once from the Apps Script editor, then delete this function.
 */
function cleanupFreshNorthRows() {
  var ss = getHubSpreadsheet_();
  var sheet = ss.getSheetByName(SUPPLIERS_TAB);
  if (!sheet) { Logger.log('No Suppliers tab'); return; }

  var data = sheet.getDataRange().getValues();
  var locationCol = 4; // E
  var sourceCol = 5;   // F

  var deleted = 0;
  for (var r = data.length - 1; r >= 1; r--) { // bottom-up to avoid row-shift
    if (String(data[r][sourceCol]).toLowerCase() !== 'fresh_and_chill') continue;
    if (String(data[r][locationCol]) !== 'Leible North') continue;
    sheet.deleteRow(r + 1);
    deleted++;
  }

  var msg = 'Fresh North cleanup done: deleted=' + deleted;
  Logger.log(msg);
  return msg;
}

/* ------------------------------------------------------------------ *
 * Read API (doGet) — token-gated, serves weekly summaries
 * ------------------------------------------------------------------ */

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var tokenCheck = checkReadToken_(params);
    if (!tokenCheck.ok) return jsonOut_({ result: 'error', message: tokenCheck.message });

    var ss = getHubSpreadsheet_();
    var sheet = ss.getSheetByName(SUMMARY_TAB);
    if (!sheet) return jsonOut_({ result: 'error', message: 'Summary tab not found. Run weeklySummarize() first.' });

    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return jsonOut_({ result: 'ok', count: 0, rows: [] });

    var from = params.from || null;
    var to = params.to || null;

    if (!from && !to) {
      var lastWeek = getLastCompletedWeek_(todayStr_());
      from = lastWeek.start;
      to = lastWeek.end;
    }

    var rows = summaryDataToObjects_(data);
    if (from || to) {
      rows = filterSummaryByDateRange_(rows, from, to);
    }

    return jsonOut_({
      result: 'ok',
      week_start: from || null,
      week_end: to || null,
      count: rows.length,
      rows: rows
    });
  } catch (err) {
    return jsonOut_({ result: 'error', message: String((err && err.message) || err) });
  }
}

function checkReadToken_(params) {
  var stored = PropertiesService.getScriptProperties().getProperty('API_READ_TOKEN');
  if (!stored) return { ok: false, message: 'unauthorized' };
  if (!params.token) return { ok: false, message: 'unauthorized' };
  if (params.token !== stored) return { ok: false, message: 'unauthorized' };
  return { ok: true };
}

function todayStr_() {
  return Utilities.formatDate(new Date(), 'Australia/Sydney', 'yyyy-MM-dd');
}

/* ------------------------------------------------------------------ *
 * Date helpers (pure, unit-tested)
 * ------------------------------------------------------------------ */

/**
 * Coerce a Sheet cell value to a 'YYYY-MM-DD' string. Google auto-converts
 * date-looking text into real Date objects, so reads come back as Dates. Use
 * local date components (NOT toISOString, which shifts AEST midnight to the
 * previous UTC day — an off-by-one). Strings pass through unchanged.
 */
function coerceDateStr_(v) {
  if (v instanceof Date) {
    var y = v.getFullYear();
    var m = v.getMonth() + 1;
    var d = v.getDate();
    return y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
  }
  return String(v);
}

function weekStartForDate_(dateStr) {
  var d = new Date(dateStr + 'T12:00:00Z');
  var day = d.getUTCDay(); // 0=Sun, 1=Mon, …
  var diff = (day === 0) ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function getLastCompletedWeek_(todayStr) {
  var today = new Date(todayStr + 'T12:00:00Z');
  var day = today.getUTCDay();
  var diffToMonday = (day === 0) ? 6 : day - 1;
  var thisMonday = new Date(today);
  thisMonday.setUTCDate(today.getUTCDate() - diffToMonday);
  var lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  var lastSunday = new Date(lastMonday);
  lastSunday.setUTCDate(lastMonday.getUTCDate() + 6);
  return {
    start: lastMonday.toISOString().slice(0, 10),
    end: lastSunday.toISOString().slice(0, 10)
  };
}

/* ------------------------------------------------------------------ *
 * Summary aggregation (pure, unit-tested)
 * ------------------------------------------------------------------ */

function aggregateSupplierRows_(rows, weekStart, weekEnd) {
  var groups = {};
  for (var i = 0; i < rows.length; i++) {
    var date = coerceDateStr_(rows[i][0]);
    if (date < weekStart || date > weekEnd) continue;
    var supplier = String(rows[i][1]);
    var total = Number(rows[i][2]);
    var location = String(rows[i][4]);
    var key = supplier + '||' + location;
    if (!groups[key]) groups[key] = { supplier: supplier, location: location, total: 0 };
    groups[key].total += total;
  }

  var result = [];
  var keys = Object.keys(groups).sort();
  for (var k = 0; k < keys.length; k++) {
    var g = groups[keys[k]];
    result.push({
      supplier: g.supplier,
      location: g.location,
      total_spend: Math.round(g.total * 100) / 100
    });
  }
  return result;
}

function summaryDataToObjects_(values) {
  var headers = values[0];
  var result = [];
  for (var r = 1; r < values.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var val = values[r][c];
      if (val instanceof Date) val = coerceDateStr_(val);
      obj[headers[c]] = val;
    }
    result.push(obj);
  }
  return result;
}

function filterSummaryByDateRange_(rows, from, to) {
  var filtered = [];
  for (var i = 0; i < rows.length; i++) {
    var ws = String(rows[i].week_start);
    if (from && ws < from) continue;
    if (to && ws > to) continue;
    filtered.push(rows[i]);
  }
  return filtered;
}

/* ------------------------------------------------------------------ *
 * Weekly summarize + archive/purge
 * ------------------------------------------------------------------ */

function weeklySummarize() {
  var ss = getHubSpreadsheet_();
  var suppSheet = ss.getSheetByName(SUPPLIERS_TAB);
  if (!suppSheet) { Logger.log('weeklySummarize: no Suppliers tab'); return; }

  var summSheet = ensureSheet(ss, SUMMARY_TAB, SUMMARY_HEADERS);
  var archSheet = ensureSheet(ss, ARCHIVE_TAB, SUPPLIERS_HEADERS);

  var today = todayStr_();
  var week = getLastCompletedWeek_(today);
  var extractedAt = Utilities.formatDate(new Date(), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX");

  var allData = suppSheet.getDataRange().getValues();
  var dataRows = allData.slice(1);

  var summaries = aggregateSupplierRows_(dataRows, week.start, week.end);

  var existingSummary = summSheet.getDataRange().getValues();
  var existingKeys = {};
  for (var i = 1; i < existingSummary.length; i++) {
    existingKeys[String(existingSummary[i][0]) + '||' + String(existingSummary[i][2]) + '||' + String(existingSummary[i][3])] = true;
  }

  var added = 0;
  for (var s = 0; s < summaries.length; s++) {
    var key = week.start + '||' + summaries[s].supplier + '||' + summaries[s].location;
    if (existingKeys[key]) continue;
    summSheet.appendRow([
      week.start, week.end, summaries[s].supplier, summaries[s].location,
      summaries[s].total_spend, extractedAt
    ]);
    added++;
  }

  var labourResult = labourWeeklyPull_(week, ss, summSheet, extractedAt);

  var cutoffDate = new Date(today + 'T12:00:00Z');
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - ARCHIVE_RETENTION_DAYS);
  var cutoffStr = cutoffDate.toISOString().slice(0, 10);

  archiveAndPurge_(suppSheet, archSheet, cutoffStr);

  Logger.log('weeklySummarize: week ' + week.start + ' → ' + week.end +
    ', supplierSummariesAdded=' + added +
    ', labourTabAdded=' + labourResult.labourAdded +
    ', labourSummaryAdded=' + labourResult.summaryAdded +
    ', cutoff=' + cutoffStr);
  return {
    weekStart: week.start, weekEnd: week.end,
    summariesAdded: added,
    labourTabAdded: labourResult.labourAdded,
    labourSummaryAdded: labourResult.summaryAdded
  };
}

function archiveAndPurge_(sourceSheet, archiveSheet, cutoffDateStr) {
  var data = sourceSheet.getDataRange().getValues();
  var archived = 0;

  for (var r = data.length - 1; r >= 1; r--) {
    var rowDate = coerceDateStr_(data[r][0]);
    if (rowDate <= cutoffDateStr) {
      archiveSheet.appendRow(data[r]);
      sourceSheet.deleteRow(r + 1);
      archived++;
    }
  }

  Logger.log('archiveAndPurge_: archived=' + archived + ' rows older than ' + cutoffDateStr);
  return archived;
}

function installWeeklySummarizeTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'weeklySummarize') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('weeklySummarize')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(4)
    .inTimezone('Australia/Sydney')
    .create();
  Logger.log('installWeeklySummarizeTrigger: Monday 4am Australia/Sydney trigger installed');
}

/* ------------------------------------------------------------------ *
 * JSON output helper
 * ------------------------------------------------------------------ */

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
