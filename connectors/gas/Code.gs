/**
 * Code.gs — LEIBLE Expense Hub core.
 *
 * doPost ingest endpoint + normalization + dedup + Sheet helpers, shared by
 * every connector. Two tabs (see docs/schema.md):
 *   Suppliers : date | supplier | total | invoice_ref | location | source | extracted_at
 *   Sales     : date | location | gross_sales | source | extracted_at
 *
 * Pure logic (normalizeSupplierRow / ingestSupplierRows / validateIngest_ /
 * appendNewRows_) is exercised by connectors/gas/test_code.js under a Node mock
 * of SpreadsheetApp — keep these functions free of editor-only globals.
 */

var SUPPLIERS_TAB = 'Suppliers';
var SALES_TAB = 'Sales';
var STAGING_TAB = '_staging';

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
  var summary = 'Tabs ready: ' + SUPPLIERS_TAB + ', ' + SALES_TAB + ', ' + STAGING_TAB;
  Logger.log(summary);
  return summary;
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

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
