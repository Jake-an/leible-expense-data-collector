/**
 * Code.gs — LEIBLE Expense Hub core.
 *
 * doPost ingest endpoint + normalization + dedup + Sheet helpers, shared by
 * every connector. Tabs (see docs/schema.md):
 *   Suppliers : date | supplier | total | invoice_ref | location | source | extracted_at | department
 *   Sales     : date | location | gross_sales | source | extracted_at | department
 *   Labour    : week_start | week_end | location | total | iso_week | pulled_at | department
 *   Revenue   : date | department | channel | customer | amount | order_ref | source | extracted_at
 *   Summary   : week_start | week_end | supplier | location | total | summarized_at | department | kind
 *
 * `department` was appended LAST on every pre-existing tab so index-based
 * dedup keys (SUPPLIERS_KEY_COLS etc.) stay valid — see the plan's "why
 * department goes last" note. Existing rows backfill to DEFAULT_DEPARTMENT.
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
var REVENUE_TAB = 'Revenue';

var SUMMARY_HEADERS = ['week_start', 'week_end', 'supplier', 'location', 'total', 'summarized_at', 'department', 'kind'];
var LABOUR_HEADERS = ['week_start', 'week_end', 'location', 'total', 'iso_week', 'pulled_at', 'department'];
var REVENUE_HEADERS = ['date', 'department', 'channel', 'customer', 'amount', 'order_ref', 'source', 'extracted_at'];

var ARCHIVE_RETENTION_DAYS = 183;

var SUPPLIERS_HEADERS = ['date', 'supplier', 'total', 'invoice_ref', 'location', 'source', 'extracted_at', 'department'];
var SALES_HEADERS = ['date', 'location', 'gross_sales', 'source', 'extracted_at', 'department'];

var DEFAULT_DEPARTMENT = 'Cafe';
var DEPARTMENTS = ['Cafe', 'Roastery'];

var SHOPSPEND_TAB = 'ShopSpend';
var SHOPSPEND_PULLS_TAB = 'ShopSpendPulls';
var SHOPSPEND_REPORT_TAB = 'ShopSpend Report';

var SHOPSPEND_HEADERS = ['shop_id', 'week_label', 'week_start', 'week_end', 'order_count',
  'amended_count', 'total_ex_gst', 'gst', 'total_inc_gst', 'gst_treatment', 'environment',
  'fetched_at', 'source', 'presence'];

var SHOPSPEND_PULLS_HEADERS = ['fetched_at', 'environment', 'from_week', 'to_week', 'matched',
  'returned', 'truncated', 'warnings_count', 'warnings', 'unpriced_sku_count', 'unpriced_skus',
  'amended_count', 'possible_duplicate_shop_names', 'empty_range_with_invalid_labels',
  'invalid_week_labels', 'gst_treatment', 'diverges_from_live_pricing', 'matches_live_pricing',
  'total_orders_scanned', 'absent_shop_ids', 'diagnostics_json'];

// Change-detection key into a normalized ShopSpend row array: shop_id + week_label.
// NOT an upsert key — ShopSpend is append-only (see step 3).
var SHOPSPEND_KEY_COLS = [0, 1];

// Dedup column indexes into a normalized row array.
var SUPPLIERS_KEY_COLS = [5, 3]; // source + invoice_ref
var SALES_KEY_COLS = [0, 1];     // date + location
var REVENUE_KEY_COLS = [6, 5];   // source + order_ref

// Summary row shape: [week_start, week_end, supplier, location, total, summarized_at, department, kind]
var SUMMARY_KEY_COLS = [0, 6, 7, 2, 3]; // week_start||department||kind||supplier||location
var SUMMARY_TOTAL_COL = 4;
var SUMMARY_STAMP_COL = 5;

// Snapshot-once backup for the guarded Summary heal path (PRD-12). Same shape
// as SUMMARY_HEADERS plus a run_id tag, so a restore can tell which run wrote
// which snapshot and healEarliestBackupRows_ can resolve ties to the earliest.
var SUMMARY_HEAL_BACKUP_TAB = 'Summary_heal_backup';
var SUMMARY_HEAL_BACKUP_HEADERS = SUMMARY_HEADERS.concat(['run_id']);

// Kill switch (PRD-12): SUMMARY_HEAL_ENABLED (Script Property, default OFF)
// controls only how many weeks a scheduled run heals — off means 1 (today's
// single-week behaviour, now guarded), on means SUMMARY_HEAL_WEEKS_ (or the
// SUMMARY_HEAL_WEEKS Script Property override). The gates themselves
// (backup, SPLIT guard, duplicate refusal, correction alert) are ALWAYS
// active in both states — the switch never bypasses them.
var SUMMARY_HEAL_WEEKS_ = 4;

// source → canonical supplier name. Ordermentum carries its name per-account in
// the row payload (row.supplier), so it is intentionally absent here.
var SUPPLIER_NAMES = {
  food_dairy_co: 'Food and Dairy Co',
  fresh_and_chill: 'Fresh and Chill',
  kent_paper: 'Kent Paper',
  mayers: 'Mayers'
};

/* ------------------------------------------------------------------ *
 * Concurrency — one lock mechanism, wrapped at entry points only
 *
 * LockService did not exist anywhere in this repo before this phase
 * (staleness.gs:73-79 documents a deliberate earlier decision to skip it —
 * that reasoning does not extend to a read-modify-write column rewrite, so
 * this is a considered departure, see docs/ADR.md).
 *
 * Every ingest path is scan-then-write (buildKeyIndex_/buildKeySet_ scan,
 * then append/update). Locking only the write half would let two concurrent
 * doPost executions each finish their scan before either writes, then both
 * append the same row — the code would look protected and not be. So the
 * lock wraps whole ENTRY POINTS (doPost, weeklySummarize,
 * migrateAddDepartment_, squareDailyPull), never the inner write helpers.
 *
 * A module-level depth counter makes accidental nesting harmless: Apps
 * Script's script lock is held per EXECUTION, so a nested tryLock would
 * succeed silently and an inner releaseLock() would drop the outer scope's
 * lock mid-batch with nothing to catch it. Depth>0 means "already held by
 * this execution" — just run the callback, no raw acquire/release.
 * ------------------------------------------------------------------ */

var SCRIPT_LOCK_DEPTH_ = 0;
var SCRIPT_LOCK_TIMEOUT_MS_ = 30000;
var LOCK_TIMEOUT_ = { lockTimeout: true }; // sentinel: withScriptLock_ could not acquire

function withScriptLock_(fn) {
  if (SCRIPT_LOCK_DEPTH_ > 0) {
    SCRIPT_LOCK_DEPTH_++;
    try { return fn(); }
    finally { SCRIPT_LOCK_DEPTH_--; }
  }

  var lock = LockService.getScriptLock();
  var acquired = lock.tryLock(SCRIPT_LOCK_TIMEOUT_MS_);
  if (!acquired) {
    Logger.log('withScriptLock_: could not acquire script lock within ' + SCRIPT_LOCK_TIMEOUT_MS_ + 'ms');
    return LOCK_TIMEOUT_;
  }

  SCRIPT_LOCK_DEPTH_ = 1;
  try {
    return fn();
  } finally {
    SCRIPT_LOCK_DEPTH_ = 0;
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ *
 * Web-app entry point
 * ------------------------------------------------------------------ */

/**
 * doPost — receives an ingest payload from a Playwright connector or the
 * wholesale/Shopify sources (P2+).
 * Body: { kind?, source, rows:[...], extracted_at }
 * `kind` defaults to 'suppliers' (back-compat: existing connectors omit it).
 *   'suppliers' rows → Suppliers tab (dedup+upsert on source+invoice_ref)
 *   'revenue'   rows → Revenue tab   (dedup+upsert on source+order_ref)
 * @returns {ContentService.TextOutput} JSON { result, rowsAdded, rowsUpdated, duplicatesSkipped }
 */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body && body.weeks_verified_empty !== undefined) {
      var auth = checkReadToken_({ token: body.token });
      // code:'UNAUTHORIZED' is machine-readable on purpose: the poster
      // degrades on it (drops weeks_verified_empty and resends) instead of
      // aborting a pull mid-stream when the stored token has diverged.
      if (!auth.ok) return jsonOut_({ result: 'error', code: 'UNAUTHORIZED', message: 'unauthorized' });
    }
    var check = validateIngest_(body);
    if (!check.ok) return jsonOut_({ result: 'error', message: check.message });

    var kind = body.kind || 'suppliers';

    var res = withScriptLock_(function () {
      var ss = getHubSpreadsheet_();
      if (kind === 'shopspend') {
        var tabs = ensureShopSpendTabs_(ss);
        // step2.md:48-51's snippet passes 5 args (no pulls sheet), but writing the
        // pull marker row to ShopSpendPulls requires a reference to that sheet —
        // tabs.pulls is added here for that reason.
        return ingestShopSpendRows(body.source, body.rows, body.extracted_at, tabs.data, tabs.pulls, body.pull,
          body.weeks_complete, body.weeks_verified_empty);
      }
      if (kind === 'revenue') {
        var revSheet = ensureSheet(ss, REVENUE_TAB, REVENUE_HEADERS);
        return ingestRevenueRows(body.source, body.rows, body.extracted_at, revSheet);
      }
      var suppSheet = ensureSheet(ss, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
      return ingestSupplierRows(body.source, body.rows, body.extracted_at, suppSheet);
    });

    // Lock-timeout must be explicit, not silent — a connector POST arriving
    // while weeklySummarize holds the lock past its own timeout must not
    // vanish. The Playwright BaseConnector.post does NOT retry this; the
    // shopSpend poster (connectors/shopspend/ingest.py) retries once after 60s.
    if (res === LOCK_TIMEOUT_) {
      return jsonOut_({ result: 'error', code: 'LOCKED', retryable: true });
    }

    // Watchdog heartbeat: a run that reached here SUCCEEDED, even if dedup meant
    // it wrote nothing. Stamping regardless of rowsAdded is what stops the
    // staleness alert crying wolf on a quiet weekend. Never throws.
    stalenessStampHeartbeat_(body.source);

    var response = {
      result: 'ok',
      rowsAdded: res.rowsAdded,
      rowsUpdated: res.rowsUpdated,
      duplicatesSkipped: res.duplicatesSkipped
    };
    if (kind === 'shopspend') {
      response.tombstonesWritten = res.tombstonesWritten;
      response.tombstonesSkipped = res.tombstonesSkipped;
    }
    return jsonOut_(response);
  } catch (err) {
    return jsonOut_({ result: 'error', message: String((err && err.message) || err) });
  }
}

/* ------------------------------------------------------------------ *
 * Validation + normalization (pure, unit-tested)
 * ------------------------------------------------------------------ */

/**
 * True iff `v` is an array whose every element is a well-formed ISO week
 * label ('YYYY-Www', always 2-digit week). Used to validate weeks_complete /
 * weeks_verified_empty — a JSON string or a nested array must be rejected,
 * not silently coerced.
 */
function isValidWeekLabel_(s) {
  if (typeof s !== 'string' || !/^\d{4}-W\d{2}$/.test(s)) return false;
  // Bound 01-53: no ISO year has a W00 or a W54+. A flat 53 accepts W53 in
  // 52-week years — a cheap sanity bound, not a calendar computation.
  var week = parseInt(s.slice(-2), 10);
  return week >= 1 && week <= 53;
}

function isValidWeekLabelArray_(v) {
  if (!Array.isArray(v)) return false;
  for (var i = 0; i < v.length; i++) {
    if (!isValidWeekLabel_(v[i])) return false;
  }
  return true;
}

/**
 * Validate an ingest payload. Returns { ok:boolean, message?:string }.
 * `kind` (default 'suppliers') selects which per-row shape is enforced.
 * A `department` present on any row must be one of DEPARTMENTS — a typo'd
 * department would otherwise create a phantom third department no report
 * ever shows.
 */
function validateIngest_(body) {
  if (!body || typeof body !== 'object') return { ok: false, message: 'body is not an object' };
  if (!body.source || typeof body.source !== 'string') return { ok: false, message: 'missing source' };
  if (!Array.isArray(body.rows)) return { ok: false, message: 'missing rows array' };
  if (!body.extracted_at) return { ok: false, message: 'missing extracted_at' };

  var kind = body.kind || 'suppliers';
  if (kind !== 'suppliers' && kind !== 'revenue' && kind !== 'shopspend') {
    return { ok: false, message: 'unknown kind: ' + kind };
  }

  // Stock-intake invoices for Roastery arrive ONLY via the Order-app
  // greenBeanCost pull (source='greenbean') — coffee_order_app never had a
  // production suppliers-kind writer, and the reserved payload shape in
  // docs/ingest-contract.md is now superseded/rejected, not just unused.
  if (kind === 'suppliers' && String(body.source).trim().toLowerCase() === 'coffee_order_app') {
    return {
      ok: false,
      message: 'coffee_order_app suppliers payloads are rejected: stock-intake invoices ' +
        'for Roastery arrive only via the Order-app greenBeanCost pull (source=\'greenbean\')'
    };
  }

  // The other half of the same exclusivity (PRD-10): online revenue's ONLY
  // sanctioned producer is the Order-app shopifySales pull, which writes
  // Summary directly. A connector POSTing kind='revenue' rows with
  // channel='online' would flow through weeklySummarize into a second
  // source-keyed online Summary row and double-count the week.
  if (kind === 'revenue') {
    for (var oc = 0; oc < body.rows.length; oc++) {
      var rowChannel = body.rows[oc] && body.rows[oc].channel;
      if (String(rowChannel).trim().toLowerCase() === 'online') {
        return {
          ok: false,
          message: 'online-channel revenue rows are rejected: Shopify online revenue arrives ' +
            'only via the Order-app shopifySales pull (supplier=\'shopify_orderapp\' Summary rows, PRD-10)'
        };
      }
    }
  }

  if (body.weeks_complete !== undefined && !isValidWeekLabelArray_(body.weeks_complete)) {
    return { ok: false, message: 'invalid weeks_complete' };
  }

  var weeksVerifiedEmptySet_ = {};
  if (body.weeks_verified_empty !== undefined) {
    if (!isValidWeekLabelArray_(body.weeks_verified_empty)) {
      return { ok: false, message: 'invalid weeks_verified_empty' };
    }
    var weeksCompleteSet_ = {};
    var weeksCompleteArr_ = Array.isArray(body.weeks_complete) ? body.weeks_complete : [];
    for (var wc = 0; wc < weeksCompleteArr_.length; wc++) weeksCompleteSet_[weeksCompleteArr_[wc]] = true;
    for (var ve = 0; ve < body.weeks_verified_empty.length; ve++) {
      var veWeek = body.weeks_verified_empty[ve];
      if (!weeksCompleteSet_[veWeek]) {
        return { ok: false, message: 'weeks_verified_empty entry not in weeks_complete: ' + veWeek };
      }
      weeksVerifiedEmptySet_[veWeek] = true;
    }
  }

  for (var i = 0; i < body.rows.length; i++) {
    var r = body.rows[i];
    if (!r || typeof r !== 'object') return { ok: false, message: 'row ' + i + ' is not an object' };
    if (!r.date) return { ok: false, message: 'row ' + i + ' missing date' };

    if (r.department !== undefined && r.department !== null && r.department !== '' &&
        DEPARTMENTS.indexOf(String(r.department)) === -1) {
      return { ok: false, message: 'row ' + i + ' invalid department: ' + r.department };
    }

    if (kind === 'shopspend') {
      if (!r.shop_id) return { ok: false, message: 'row ' + i + ' missing shop_id' };
      if (!r.week_label || !isValidWeekLabel_(String(r.week_label))) {
        return { ok: false, message: 'row ' + i + ' invalid week_label' };
      }
      if (weeksVerifiedEmptySet_[r.week_label]) {
        return { ok: false, message: 'row ' + i + ' has week_label ' + r.week_label + ' but that week is in weeks_verified_empty' };
      }
      if (!r.week_start) return { ok: false, message: 'row ' + i + ' missing week_start' };
      if (!r.week_end) return { ok: false, message: 'row ' + i + ' missing week_end' };
      if (r.total_ex_gst === undefined || r.total_ex_gst === null || isNaN(Number(r.total_ex_gst))) {
        return { ok: false, message: 'row ' + i + ' missing/invalid total_ex_gst' };
      }
      if (r.gst === undefined || r.gst === null || isNaN(Number(r.gst))) {
        return { ok: false, message: 'row ' + i + ' missing/invalid gst' };
      }
      if (r.total_inc_gst === undefined || r.total_inc_gst === null || isNaN(Number(r.total_inc_gst))) {
        return { ok: false, message: 'row ' + i + ' missing/invalid total_inc_gst' };
      }
      if (r.order_count === undefined || r.order_count === null || isNaN(Number(r.order_count))) {
        return { ok: false, message: 'row ' + i + ' missing/invalid order_count' };
      }
      if (r.amended_count === undefined || r.amended_count === null || isNaN(Number(r.amended_count))) {
        return { ok: false, message: 'row ' + i + ' missing/invalid amended_count' };
      }
    } else if (kind === 'revenue') {
      if (r.amount === undefined || r.amount === null || isNaN(Number(r.amount))) {
        return { ok: false, message: 'row ' + i + ' missing/invalid amount' };
      }
      if (!r.order_ref) return { ok: false, message: 'row ' + i + ' missing order_ref' };
      if (!r.channel) return { ok: false, message: 'row ' + i + ' missing channel' };
      if (!r.customer) return { ok: false, message: 'row ' + i + ' missing customer' };
    } else {
      if (r.total === undefined || r.total === null || isNaN(Number(r.total))) {
        return { ok: false, message: 'row ' + i + ' missing/invalid total' };
      }
      if (!r.invoice_ref) return { ok: false, message: 'row ' + i + ' missing invoice_ref' };
    }
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
 * @returns {Array} [date, supplier, total, invoice_ref, location, source, extracted_at, department]
 */
function normalizeSupplierRow(row, source, extractedAt) {
  return [
    String(row.date),
    canonicalSupplier_(source, row),
    Number(row.total),
    String(row.invoice_ref),
    row.location ? String(row.location) : '',
    source,
    extractedAt,
    row.department ? String(row.department) : DEFAULT_DEPARTMENT
  ];
}

/**
 * Map a raw revenue row to the Revenue column order.
 * @returns {Array} [date, department, channel, customer, amount, order_ref, source, extracted_at]
 */
function normalizeRevenueRow(row, source, extractedAt) {
  return [
    String(row.date),
    row.department ? String(row.department) : DEFAULT_DEPARTMENT,
    String(row.channel),
    String(row.customer),
    Number(row.amount),
    String(row.order_ref),
    source,
    extractedAt
  ];
}

/**
 * Map [dateStr, location, gross, source, extractedAt] → the Sales column
 * order INCLUDING department. square.gs used to build this as a bare
 * literal, which meant every post-migration row landed with a blank
 * department while backfilled history read 'Cafe' — permanently splitting
 * the Sales tab. Route every writer through this normalizer instead.
 * @returns {Array} [date, location, gross_sales, source, extracted_at, department]
 */
function normalizeSalesRow_(dateStr, location, gross, source, extractedAt, department) {
  return [
    String(dateStr),
    String(location),
    Number(gross),
    source,
    extractedAt,
    department ? String(department) : DEFAULT_DEPARTMENT
  ];
}

/**
 * Map a raw shopspend row to the ShopSpend column order.
 * Per-row fetched_at (if present) overrides extracted_at; presence defaults to 'present'.
 * @returns {Array} [shop_id, week_label, week_start, week_end, order_count, amended_count, total_ex_gst, gst, total_inc_gst, gst_treatment, environment, fetched_at, source, presence]
 */
function normalizeShopSpendRow(row, source, extractedAt) {
  return [
    String(row.shop_id),
    String(row.week_label),
    String(row.week_start),
    String(row.week_end),
    Number(row.order_count),
    Number(row.amended_count),
    Number(row.total_ex_gst),
    Number(row.gst),
    Number(row.total_inc_gst),
    row.gst_treatment ? String(row.gst_treatment) : '',
    row.environment ? String(row.environment) : '',
    row.fetched_at ? String(row.fetched_at) : extractedAt,
    source,
    'present'
  ];
}

/**
 * Map a pull metadata object to the ShopSpendPulls column order.
 * @returns {Array} [fetched_at, environment, from_week, to_week, matched, returned, truncated, warnings_count, warnings, unpriced_sku_count, unpriced_skus, amended_count, possible_duplicate_shop_names, empty_range_with_invalid_labels, invalid_week_labels, gst_treatment, diverges_from_live_pricing, matches_live_pricing, total_orders_scanned, absent_shop_ids, diagnostics_json]
 */
function normalizePullMetadataRow_(pull) {
  return [
    String(pull.fetched_at),
    String(pull.environment),
    String(pull.from_week),
    String(pull.to_week),
    Number(pull.matched),
    Number(pull.returned),
    pull.truncated,
    Number(pull.warnings_count),
    String(pull.warnings),
    Number(pull.unpriced_sku_count),
    String(pull.unpriced_skus),
    Number(pull.amended_count),
    String(pull.possible_duplicate_shop_names),
    pull.empty_range_with_invalid_labels,
    String(pull.invalid_week_labels),
    String(pull.gst_treatment),
    pull.diverges_from_live_pricing,
    pull.matches_live_pricing,
    Number(pull.total_orders_scanned),
    String(pull.absent_shop_ids),
    String(pull.diagnostics_json)
  ];
}

/* ------------------------------------------------------------------ *
 * Ingest + dedup
 * ------------------------------------------------------------------ */

/**
 * Normalize + upsert a batch of supplier rows into a sheet.
 * Dedup/upsert is against existing sheet rows AND earlier rows in the same
 * batch — see upsertRows_.
 * @returns {{rowsAdded:number, rowsUpdated:number, duplicatesSkipped:number}}
 */
/**
 * The dedup keys of every invoice that has been purged to `_archive`.
 *
 * upsertRows_ can only see the tab it is writing to, so an invoice that
 * archiveAndPurge_ moved out of `Suppliers` reads as BRAND NEW on the next
 * ingest and gets appended again — the same invoice_ref now living in both
 * tabs. That is not theoretical: the 2026-08-25 Ordermentum backfill put 24
 * weeks into exactly that state.
 *
 * It matters because every consumer that reconstructs history reads
 * Suppliers + _archive together, so a duplicated invoice is counted twice.
 *
 * @returns {Object} { 'source||invoice_ref': true }
 */
function supplierArchiveKeySet_() {
  var ss = getHubSpreadsheet_();
  var archSheet = ss.getSheetByName(ARCHIVE_TAB);
  if (!archSheet) return {};
  return buildKeySet_(archSheet, SUPPLIERS_KEY_COLS);
}

function ingestSupplierRows(source, rows, extractedAt, sheet) {
  var normalizedRows = [];
  for (var i = 0; i < rows.length; i++) {
    normalizedRows.push(normalizeSupplierRow(rows[i], source, extractedAt));
  }

  /* Drop anything already sitting in `_archive` BEFORE the upsert. Skipping
   * rather than updating is deliberate: `_archive` is historical, a write
   * there would not reach Summary anyway, and re-appending to Suppliers is the
   * defect being fixed. The count is returned and logged so a supplier
   * genuinely re-issuing old invoices is visible rather than silently ignored. */
  var archivedKeys = supplierArchiveKeySet_();
  var fresh = [];
  var archivedSkipped = 0;
  for (var j = 0; j < normalizedRows.length; j++) {
    if (archivedKeys[rowKey_(normalizedRows[j], SUPPLIERS_KEY_COLS)] === true) {
      archivedSkipped++;
      continue;
    }
    fresh.push(normalizedRows[j]);
  }

  // amountCol=2 (total), stampCol=6 (extracted_at) — department (col 7) is
  // never touched by an upsert; only the invoice's own amount/date can change.
  var res = upsertRows_(sheet, fresh, SUPPLIERS_KEY_COLS, 2, 6);
  res.archivedSkipped = archivedSkipped;
  if (archivedSkipped > 0) {
    Logger.log('ingestSupplierRows: ' + archivedSkipped + ' row(s) already in ' +
      ARCHIVE_TAB + ' — not re-appended to ' + SUPPLIERS_TAB);
  }
  return res;
}

/**
 * Normalize + upsert a batch of revenue rows into the Revenue tab.
 * @returns {{rowsAdded:number, rowsUpdated:number, duplicatesSkipped:number}}
 */
function ingestRevenueRows(source, rows, extractedAt, sheet) {
  var normalizedRows = [];
  for (var i = 0; i < rows.length; i++) {
    normalizedRows.push(normalizeRevenueRow(rows[i], source, extractedAt));
  }
  // amountCol=4 (amount), stampCol=7 (extracted_at)
  return upsertRows_(sheet, normalizedRows, REVENUE_KEY_COLS, 4, 7);
}

/**
 * Append/update a single normalized Sales row.
 * Blanket upsert on Sales is unsafe: SALES_KEY_COLS is date+location, so a
 * mid-day squareDailyPull re-run must never overwrite a completed day's
 * gross with a partial figure. Only a PRIOR day (not today, Sydney time) may
 * be corrected in place; same-day re-runs always skip, matching the old
 * dedup-only behaviour.
 * @returns {{appended:boolean, updated:boolean}}
 */
function appendSalesRow_(sheet, normalizedRow) {
  var idx = buildKeyIndex_(sheet, SALES_KEY_COLS);
  var key = rowKey_(normalizedRow, SALES_KEY_COLS);
  var existingRowNum = idx[key];

  if (existingRowNum === undefined) {
    appendNewRows_(sheet, [normalizedRow]);
    return { appended: true, updated: false };
  }

  var rowDate = coerceDateStr_(normalizedRow[0]);
  if (rowDate === todayStr_()) {
    // Today's partial figure must never overwrite today's row.
    return { appended: false, updated: false };
  }

  sheet.getRange(existingRowNum, 3).setValue(normalizedRow[2]); // gross_sales (col C)
  sheet.getRange(existingRowNum, 5).setValue(normalizedRow[4]); // extracted_at (col E)
  return { appended: false, updated: true };
}

/**
 * Build a lookup of existing dedup keys → 1-based sheet row number
 * (skips the header row = row 1).
 * @returns {Object} { key: sheetRowNumber }
 */
function buildKeyIndex_(sheet, keyCols) {
  var idx = {};
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) { // row 0 = header
    idx[rowKey_(values[r], keyCols)] = r + 1;
  }
  return idx;
}

/**
 * Thin wrapper over buildKeyIndex_ for callers that only need membership.
 * @returns {Object} { key: true }
 */
function buildKeySet_(sheet, keyCols) {
  var idx = buildKeyIndex_(sheet, keyCols);
  var set = {};
  for (var k in idx) {
    if (Object.prototype.hasOwnProperty.call(idx, k)) set[k] = true;
  }
  return set;
}

/**
 * Upsert a batch of already-normalized rows into a sheet.
 * - New key (not on the sheet, not yet seen in this batch) → append.
 * - Existing sheet key, amount unchanged → duplicatesSkipped++, no write.
 * - Existing sheet key, amount changed → update amountCol + stampCol in
 *   place (getRange().setValue()), rowsUpdated++.
 * - A key repeated within the same batch (after being resolved once) →
 *   duplicatesSkipped++, matching the old within-batch dedup behaviour.
 * `updates` records only rows actually rewritten (amount genuinely changed) —
 * a new row or an unchanged-amount duplicate never appears in it. This is
 * what the correction alert (PRD-12) is driven from.
 * @returns {{rowsAdded:number, rowsUpdated:number, duplicatesSkipped:number, updates:Array<{key:string,from:number,to:number}>}}
 */
function upsertRows_(sheet, normalizedRows, keyCols, amountCol, stampCol) {
  var values = sheet.getDataRange().getValues();
  var idx = {}; // key -> 1-based sheet row number, existing rows only
  for (var r = 1; r < values.length; r++) {
    idx[rowKey_(values[r], keyCols)] = r + 1;
  }

  var seenInBatch = {};
  var toAppend = [];
  var rowsUpdated = 0, duplicatesSkipped = 0;
  var updates = [];

  for (var i = 0; i < normalizedRows.length; i++) {
    var row = normalizedRows[i];
    var key = rowKey_(row, keyCols);

    if (seenInBatch[key]) { duplicatesSkipped++; continue; }

    var existingRowNum = idx[key];
    if (existingRowNum === undefined) {
      seenInBatch[key] = true;
      toAppend.push(row);
      continue;
    }

    seenInBatch[key] = true;
    var existingAmount = Number(values[existingRowNum - 1][amountCol]);
    var newAmount = Number(row[amountCol]);

    if (existingAmount === newAmount) { duplicatesSkipped++; continue; }

    sheet.getRange(existingRowNum, amountCol + 1).setValue(newAmount);
    if (stampCol !== undefined && stampCol !== null) {
      sheet.getRange(existingRowNum, stampCol + 1).setValue(row[stampCol]);
    }
    rowsUpdated++;
    updates.push({ key: key, from: existingAmount, to: newAmount });
  }

  if (toAppend.length) appendNewRows_(sheet, toAppend);

  return { rowsAdded: toAppend.length, rowsUpdated: rowsUpdated, duplicatesSkipped: duplicatesSkipped, updates: updates };
}

function rowKey_(rowArray, keyCols) {
  var parts = [];
  for (var i = 0; i < keyCols.length; i++) {
    var v = rowArray[keyCols[i]];
    v = (v instanceof Date) ? coerceDateStr_(v) : v;
    parts.push(String(v).trim().toLowerCase());
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
 *   Suppliers : date | supplier | total | invoice_ref | location | source | extracted_at | department
 *   Sales     : date | location | gross_sales | source | extracted_at | department
 *   Revenue   : date | department | channel | customer | amount | order_ref | source | extracted_at
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
 * Pull labour cost for the given week(s) from the Onboarding app LABOUR_COST sheet.
 * Writes to the Labour tab (dedup week_start||location) AND to Summary (supplier='Labour').
 * Safe to call with empty/missing source — logs and returns zeros without writing garbage.
 *
 * @param {Array<{start:string,end:string}>} weeks  ISO date strings (week.start, week.end).
 *   A single week is passed as a one-element array. The external LABOUR_COST
 *   source is read exactly once for the whole list, not once per week.
 * @param {Spreadsheet}              ss     Hub spreadsheet
 * @param {Sheet}                    summSheet  Already-open Summary sheet
 * @param {string}                   pulledAt   ISO timestamp string
 * @returns {{labourAdded:number, summaryAdded:number, summaryUpdated:number}}
 */
function labourWeeklyPull_(weeks, ss, summSheet, pulledAt) {
  var labourSheet = ensureSheet(ss, LABOUR_TAB, LABOUR_HEADERS);

  var srcSS = getLabourSpreadsheet_();
  if (!srcSS) return { labourAdded: 0, summaryAdded: 0, summaryUpdated: 0 };

  var srcSheet = srcSS.getSheetByName('LABOUR_COST');
  if (!srcSheet) {
    Logger.log('labourWeeklyPull_: LABOUR_COST tab not found in source — skipping');
    return { labourAdded: 0, summaryAdded: 0, summaryUpdated: 0 };
  }

  var srcData = srcSheet.getDataRange().getValues();
  if (srcData.length <= 1) {
    Logger.log('labourWeeklyPull_: LABOUR_COST is empty — skipping');
    return { labourAdded: 0, summaryAdded: 0, summaryUpdated: 0 };
  }

  // Map source headers → column indexes
  var hdr = srcData[0];
  var col = {};
  for (var h = 0; h < hdr.length; h++) col[String(hdr[h])] = h;

  var weekStartSet = {};
  for (var w = 0; w < weeks.length; w++) weekStartSet[weeks[w].start] = true;

  // Labour tab dedup set. week_start reads back from a Sheet as a Date —
  // coerceDateStr_ before comparing or the key never matches its 'yyyy-MM-dd'
  // counterpart and the dedup silently passes everything through.
  var labourKeys = {};
  var labourData = labourSheet.getDataRange().getValues();
  for (var r = 1; r < labourData.length; r++) {
    labourKeys[coerceDateStr_(labourData[r][0]) + '||' + String(labourData[r][2])] = true;
  }

  var labourAdded = 0;
  var summaryNormalizedRows = [];

  for (var i = 1; i < srcData.length; i++) {
    var row = srcData[i];
    var ws = coerceDateStr_(row[col['week_start']]);
    if (!weekStartSet[ws]) continue;

    var location = String(row[col['location']] || '');
    var total    = Math.round(Number(row[col['total']] || 0) * 100) / 100;
    var isoWeek  = String(row[col['iso_week']] || '');
    var we       = coerceDateStr_(row[col['week_end']]);

    // Write to Labour tab. Labour is parked (no behaviour change), but it
    // still gets DEFAULT_DEPARTMENT so it isn't silently dropped by a
    // department-filtered read.
    var lKey = ws + '||' + location;
    if (!labourKeys[lKey]) {
      labourSheet.appendRow([ws, we, location, total, isoWeek, pulledAt, DEFAULT_DEPARTMENT]);
      labourKeys[lKey] = true;
      labourAdded++;
    }

    // Queue the Summary row, routed through the SAME upsertRows_ key
    // weeklySummarize uses (week_start||department||kind||supplier||location)
    // — two different dedup schemes writing the same tab is exactly the bug
    // §1e exists to prevent.
    summaryNormalizedRows.push([ws, we, 'Labour', location, total, pulledAt, DEFAULT_DEPARTMENT, 'spend']);
  }

  var summaryResult = upsertRows_(summSheet, summaryNormalizedRows, SUMMARY_KEY_COLS, SUMMARY_TOTAL_COL, SUMMARY_STAMP_COL);

  Logger.log('labourWeeklyPull_: weeks=' + weeks.map(function (w) { return w.start; }).join(',') +
    ' labourAdded=' + labourAdded +
    ' summaryAdded=' + summaryResult.rowsAdded + ' summaryUpdated=' + summaryResult.rowsUpdated);
  return { labourAdded: labourAdded, summaryAdded: summaryResult.rowsAdded, summaryUpdated: summaryResult.rowsUpdated };
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
    if (headers && headers.length) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length)
        .setBackground('#a5b89d').setFontColor('#ffffff').setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

/* ------------------------------------------------------------------ *
 * Migration — add the `department` column (idempotent, dry-run by default)
 * ------------------------------------------------------------------ */

// SUPPLIERS_HEADERS-shaped tabs, incl. _staging and _archive.
var DEPARTMENT_TABS = [
  [SUPPLIERS_TAB, SUPPLIERS_HEADERS], [STAGING_TAB, SUPPLIERS_HEADERS],
  [ARCHIVE_TAB, SUPPLIERS_HEADERS], [SALES_TAB, SALES_HEADERS],
  [LABOUR_TAB, LABOUR_HEADERS]
];

/**
 * Add the `department` header + backfill blank data cells to every tab in
 * DEPARTMENT_TABS, plus rewrite the Summary header row and create Revenue.
 * DRY RUN BY DEFAULT — matches this repo's convention for destructive Sheet
 * work (cleanupCorruptSalesRows, cleanupDuplicateSummaryRows).
 *   migrateAddDepartment_()       → dry run, reports only
 *   migrateAddDepartment_(false)  → writes
 * Idempotency is checked PER TAB, so a run that dies halfway resumes cleanly.
 * @returns {Object} { <tabName>: {tab, headerAction, blanksFilled}, ... }
 */
function migrateAddDepartment_(dryRun) {
  dryRun = (dryRun !== false);
  return withScriptLock_(function () {
    var ss = getHubSpreadsheet_(), report = {};
    DEPARTMENT_TABS.forEach(function (p) {
      report[p[0]] = addDepartmentColumn_(ss.getSheetByName(p[0]), p[1], dryRun, p[0]);
    });
    report[SUMMARY_TAB] = migrateSummaryHeaders_(ss.getSheetByName(SUMMARY_TAB), dryRun, SUMMARY_TAB);
    if (!dryRun) ensureSheet(ss, REVENUE_TAB, REVENUE_HEADERS);
    return report;
  });
}

/**
 * Sweep pass, separate from the header migration on purpose:
 * addDepartmentColumn_ short-circuits the moment the header exists, so
 * calling it a second time can never fill anything — it would report
 * 'skipped', look successful, and leave blank-department rows written during
 * the runbook's deploy window (step 3-6) there permanently and invisibly.
 * fillBlankDepartments_ has NO header guard, so it always sweeps.
 *   sweepBlankDepartments_()       → dry run, reports only
 *   sweepBlankDepartments_(false)  → writes
 */
function sweepBlankDepartments_(dryRun) {
  dryRun = (dryRun !== false);
  return withScriptLock_(function () {
    var ss = getHubSpreadsheet_(), report = {};
    DEPARTMENT_TABS.forEach(function (p) {
      report[p[0]] = fillBlankDepartments_(ss.getSheetByName(p[0]), p[1], dryRun, p[0]);
    });
    return report;
  });
}

/* ------------------------------------------------------------------ *
 * Editor entry points for the migration runbook.
 *
 * migrateAddDepartment_ / sweepBlankDepartments_ are private (trailing _),
 * so they never appear in the Apps Script Run dropdown — and the Run button
 * passes NO arguments, so even a public version could only ever be invoked
 * as dryRun===undefined, which the `dryRun !== false` default turns into a
 * dry run. The write path is unreachable from the editor without a no-arg
 * wrapper: it would report success and change nothing.
 *
 * These also Logger.log the report, because the editor displays log output
 * but NOT return values — the report is a return value.
 * ------------------------------------------------------------------ */

function runDepartmentMigrationDryRun() {
  var report = migrateAddDepartment_();
  Logger.log('DRY RUN (nothing written): ' + JSON.stringify(report, null, 2));
  return report;
}

function runDepartmentMigrationApply() {
  var report = migrateAddDepartment_(false);
  Logger.log('APPLIED (written): ' + JSON.stringify(report, null, 2));
  return report;
}

function runBlankDepartmentSweepDryRun() {
  var report = sweepBlankDepartments_();
  Logger.log('SWEEP DRY RUN (nothing written): ' + JSON.stringify(report, null, 2));
  return report;
}

function runBlankDepartmentSweepApply() {
  var report = sweepBlankDepartments_(false);
  Logger.log('SWEEP APPLIED (written): ' + JSON.stringify(report, null, 2));
  return report;
}

/**
 * Owns the HEADER only. Guarded on header presence — a second call is a
 * safe no-op that reports 'already migrated'. Delegates the data fill to
 * fillBlankDepartments_.
 * @returns {{tab:string, headerAction:('add'|'present'|'absent'), blanksFilled:number}}
 */
function addDepartmentColumn_(sheet, headers, dryRun, tabName) {
  if (!sheet) return { tab: tabName || null, headerAction: 'absent', blanksFilled: 0 };

  var headerRow = sheet.getDataRange().getValues()[0] || [];
  var deptCol = headers.indexOf('department') + 1; // 1-based

  if (headerRow.indexOf('department') !== -1) {
    return { tab: tabName, headerAction: 'present', blanksFilled: 0 };
  }

  if (!dryRun) sheet.getRange(1, deptCol).setValue('department');

  var fill = fillBlankDepartments_(sheet, headers, dryRun, tabName);
  return { tab: tabName, headerAction: 'add', blanksFilled: fill.blanksFilled };
}

/**
 * Owns the DATA. Always scans, always blank-only-fills — never clobbers an
 * existing value — regardless of header state. Idempotent by construction (a
 * filled cell is not blank).
 *
 * Single setValues block write, not a per-row setValue loop — _archive holds
 * up to ARCHIVE_RETENTION_DAYS of rows and a per-row loop risks the 6-minute
 * GAS execution limit, dying mid-tab.
 * @returns {{tab:string, headerAction:('present'|'absent'), blanksFilled:number}}
 */
function fillBlankDepartments_(sheet, headers, dryRun, tabName) {
  if (!sheet) return { tab: tabName || null, headerAction: 'absent', blanksFilled: 0 };

  var deptCol = headers.indexOf('department'); // 0-based
  var values = sheet.getDataRange().getValues();

  var blanksFilled = 0;
  var writes = []; // { row: 1-based sheet row, value }
  for (var r = 1; r < values.length; r++) {
    var cur = values[r][deptCol];
    if (cur === undefined || cur === null || String(cur) === '') {
      writes.push(r + 1);
      blanksFilled++;
    }
  }

  if (!dryRun && writes.length) {
    var block = writes.map(function () { return [DEFAULT_DEPARTMENT]; });
    // Contiguous ranges write in one call; non-contiguous rows still need one
    // setValues() per contiguous run to stay a "single block write" per run
    // rather than a per-row loop. Rows are 1-based and ascending here.
    var start = 0;
    for (var i = 1; i <= writes.length; i++) {
      var breakHere = (i === writes.length) || (writes[i] !== writes[i - 1] + 1);
      if (breakHere) {
        var runRows = writes.slice(start, i);
        sheet.getRange(runRows[0], deptCol + 1, runRows.length, 1)
          .setValues(block.slice(start, i));
        start = i;
      }
    }
  }

  return { tab: tabName, headerAction: 'present', blanksFilled: blanksFilled };
}

/**
 * The Summary tab is NOT rebuilt by weeklySummarize (append-with-upsert,
 * never a header rewrite), so its header row must be rewritten in place:
 * rename E1 'total_spend' -> 'total', write G1 'department' / H1 'kind', and
 * backfill existing data rows 'Cafe' / 'spend'. Idempotent on the presence
 * of 'kind' in the header row.
 * @returns {{tab:string, headerAction:('add'|'present'|'absent'), blanksFilled:number}}
 */
function migrateSummaryHeaders_(sheet, dryRun, tabName) {
  if (!sheet) return { tab: tabName || null, headerAction: 'absent', blanksFilled: 0 };

  var values = sheet.getDataRange().getValues();
  var headerRow = values[0] || [];

  if (headerRow.indexOf('kind') !== -1) {
    return { tab: tabName, headerAction: 'present', blanksFilled: 0 };
  }

  if (!dryRun) {
    sheet.getRange(1, 1, 1, SUMMARY_HEADERS.length).setValues([SUMMARY_HEADERS]);
  }

  // Backfill data rows: department (col 7) / kind (col 8) blank-only.
  var blanksFilled = 0;
  var deptWrites = [], kindWrites = [];
  for (var r = 1; r < values.length; r++) {
    var dept = values[r][6];
    var kind = values[r][7];
    if (dept === undefined || dept === null || String(dept) === '') { deptWrites.push(r + 1); blanksFilled++; }
    if (kind === undefined || kind === null || String(kind) === '') { kindWrites.push(r + 1); }
  }

  if (!dryRun) {
    deptWrites.forEach(function (rowNum) { sheet.getRange(rowNum, 7).setValue(DEFAULT_DEPARTMENT); });
    kindWrites.forEach(function (rowNum) { sheet.getRange(rowNum, 8).setValue('spend'); });
  }

  return { tab: tabName, headerAction: 'add', blanksFilled: blanksFilled };
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

var CLEANUP_EXPECTED_CORRUPT_ROWS = 8;   // module-level so tests can reassign it

/**
 * True if a Sales row is a trigger-event corruption (Fault 3): the date column
 * holds a stringified trigger event object instead of a date.
 *
 * The date cell reads back as a Date for healthy rows and a String for corrupt
 * ones, so normalize via coerceDateStr_ first. Narrowed to source='square' — a
 * predicate that DELETES shouldn't assume nothing else ever writes Sales.
 * Blank rows have source '' → never touched.
 *
 * gross_sales === 0 is deliberately NOT part of this: it's true of all 8 known
 * corrupt rows, but it's a symptom, not the definition — a genuinely closed
 * trading day is $0 on a valid date and must be kept. The date shape is the
 * invariant.
 */
function salesRowIsCorrupt_(row) {
  if (String(row[3]).trim().toLowerCase() !== 'square') return false;
  return !DATE_ARG_RE.test(coerceDateStr_(row[0]));
}

/**
 * ONE-SHOT (destructive): delete the Sales rows corrupted by the Fault 3 trigger.
 *
 * DRY RUN BY DEFAULT — only an explicit `false` deletes. The editor's Run button
 * passes no argument, and a trigger would pass an event object; both are
 * non-false → both dry-run. (That's Fault 3's own bug turned into a safety
 * property.)
 *
 *   cleanupCorruptSalesRows()       → dry run, logs what it WOULD delete
 *   cleanupCorruptSalesRows(false)  → actually deletes
 *
 * THE DRY RUN IS MANDATORY, NOT ADVISORY. salesRowIsCorrupt_ matches ANY
 * source='square' row whose date isn't YYYY-MM-DD — a blank date, or a date
 * stored as text ('15/07/2026'), would match too. The CLEANUP_EXPECTED_CORRUPT_ROWS
 * guard is the only thing bounding that, so read the pass-1 log and confirm all
 * 8 rows are genuinely the trigger-event corruption BEFORE passing false.
 *
 * Delete this function, salesRowIsCorrupt_ and CLEANUP_EXPECTED_CORRUPT_ROWS once
 * it has been run — but KEEP DATE_ARG_RE and resolveDateArg_, which are
 * load-bearing for the Fault 3 fix in squareDailyPull.
 */
function cleanupCorruptSalesRows(dryRun) {
  var isDryRun = (dryRun !== false);
  var ss = getHubSpreadsheet_();
  var sheet = ss.getSheetByName(SALES_TAB);
  if (!sheet) { Logger.log('cleanupCorruptSalesRows: no Sales tab'); return 'no-sheet'; }

  var data = sheet.getDataRange().getValues();

  // Pass 1: identify + log every match, in BOTH modes, so the destructive run
  // leaves the same audit trail as the dry run.
  var matches = [];
  for (var r = 1; r < data.length; r++) {
    if (!salesRowIsCorrupt_(data[r])) continue;
    matches.push(r);
    Logger.log('cleanupCorruptSalesRows: row ' + (r + 1) +
      ' | location=' + String(data[r][1]) +
      ' | gross=' + String(data[r][2]) +
      ' | date=' + String(data[r][0]).slice(0, 60));
  }

  Logger.log('cleanupCorruptSalesRows: ' + (isDryRun ? 'DRY RUN' : 'APPLY') +
    ' — found ' + matches.length + ' corrupt row(s)');

  if (isDryRun) {
    return { mode: 'dryRun', found: matches.length, rows: matches.map(function (r) { return r + 1; }) };
  }

  if (matches.length !== CLEANUP_EXPECTED_CORRUPT_ROWS) {
    Logger.log('ABORT: expected ' + CLEANUP_EXPECTED_CORRUPT_ROWS + ', got ' + matches.length);
    return 'aborted';
  }

  // Pass 2: delete bottom-up so pass-1 row numbers stay valid as rows shift.
  var deleted = 0;
  for (var m = matches.length - 1; m >= 0; m--) {
    sheet.deleteRow(matches[m] + 1);
    deleted++;
  }

  Logger.log('cleanupCorruptSalesRows: deleted=' + deleted);
  return { mode: 'apply', found: matches.length, deleted: deleted };
}

/**
 * cleanupDuplicateSummaryRows — one-shot repair for the Summary rows appended by
 * the broken week_start dedup (it keyed on String(Date), which never matched the
 * 'yyyy-MM-dd' key, so every weeklySummarize run re-appended the whole week).
 *
 * Keeps the FIRST row for each week_start||department||kind||supplier||location
 * and removes the later copies (the same key upsertRows_ uses for Summary —
 * once Summary carries department+kind, a Cafe-spend row and a
 * Roastery-revenue row sharing week_start+supplier+location must NOT be
 * treated as the same conflict). doGet sums Summary, so leaving duplicates in
 * over-reports by however many times the week was summarized.
 *
 * A later row is only ever deleted when its total MATCHES the row it duplicates.
 * A same-key row with a different total is not a mechanical duplicate — it means
 * the underlying spend changed between runs — so it is reported as a conflict and
 * left alone rather than silently destroying the newer figure.
 *
 * Dry run by default, matching cleanupCorruptSalesRows: pass false to apply.
 * Idempotent — a second apply finds nothing.
 *
 * @param {boolean} dryRun  false to actually delete; anything else = dry run
 * @returns {Object} { mode, found, deleted, conflicts:[] }
 */
function cleanupDuplicateSummaryRows(dryRun) {
  var isDryRun = (dryRun !== false);
  var ss = getHubSpreadsheet_();
  var sheet = ss.getSheetByName(SUMMARY_TAB);
  if (!sheet) { Logger.log('cleanupDuplicateSummaryRows: no Summary tab'); return 'no-sheet'; }

  var data = sheet.getDataRange().getValues();

  // Pass 1: identify, in both modes, so an apply leaves the same audit trail.
  var firstSeen = {};          // key -> { row, total }
  var matches = [];
  var conflicts = [];

  for (var r = 1; r < data.length; r++) {
    var key = rowKey_(data[r], SUMMARY_KEY_COLS);
    var total = Number(data[r][4]);

    if (!firstSeen[key]) {
      firstSeen[key] = { row: r, total: total };
      continue;
    }

    var kept = firstSeen[key];
    if (total !== kept.total) {
      conflicts.push({ row: r + 1, key: key, keptTotal: kept.total, thisTotal: total });
      Logger.log('cleanupDuplicateSummaryRows: CONFLICT row ' + (r + 1) + ' | ' + key +
        ' | kept row ' + (kept.row + 1) + ' total=' + kept.total + ' vs this total=' + total +
        ' — NOT deleted, resolve by hand');
      continue;
    }

    matches.push(r);
    Logger.log('cleanupDuplicateSummaryRows: dup row ' + (r + 1) + ' | ' + key +
      ' | total=' + total + ' | duplicates row ' + (kept.row + 1));
  }

  Logger.log('cleanupDuplicateSummaryRows: ' + (isDryRun ? 'DRY RUN' : 'APPLY') +
    ' — ' + matches.length + ' duplicate(s), ' + conflicts.length + ' conflict(s)');

  if (isDryRun) {
    return {
      mode: 'dryRun', found: matches.length, deleted: 0, conflicts: conflicts,
      rows: matches.map(function (r) { return r + 1; })
    };
  }

  // Pass 2: delete bottom-up so pass-1 row numbers stay valid as rows shift.
  var deleted = 0;
  for (var m = matches.length - 1; m >= 0; m--) {
    sheet.deleteRow(matches[m] + 1);
    deleted++;
  }

  Logger.log('cleanupDuplicateSummaryRows: deleted=' + deleted);
  return { mode: 'apply', found: matches.length, deleted: deleted, conflicts: conflicts };
}

/* ------------------------------------------------------------------ *
 * v23 online-revenue grain cleanup (one-shot, dry-run by default)
 * ------------------------------------------------------------------ */

var ONLINE_REVENUE_BACKUP_TAB = 'Summary_online_revenue_backup';

/**
 * Index the LIVE Revenue tab's online rows by ISO week.
 *
 * Two questions the cleanup cannot answer from Summary alone:
 *   1. Can week W actually be rebuilt? weeklySummarize re-derives Summary from
 *      Revenue, so a week whose Revenue rows are gone comes back as nothing —
 *      deleting its Summary row would destroy the figure with no source to
 *      regenerate it from. `rows` answers that.
 *   2. Is the week safe to rebuild? aggregateSupplierRows_ groups on the RAW
 *      channel string while rowKey_ lowercases (Code.gs:421), so 'Online' and
 *      'online' in one week produce two groups that collapse to one Summary
 *      row — the later one dropped as an in-batch duplicate. `casings` surfaces
 *      that before it silently eats revenue on the re-summarize.
 *
 * @returns {Object} weekStart -> { rows, casings:[] }
 */
function onlineRevenueWeeks_(ss) {
  var out = {};
  var revSheet = ss.getSheetByName(REVENUE_TAB);
  if (!revSheet) return out;

  var rows = revSheet.getDataRange().getValues();
  for (var r = 1; r < rows.length; r++) {
    var channel = String(rows[r][2]).trim();
    if (channel.toLowerCase() !== 'online') continue;

    var date = coerceDateStr_(rows[r][0]);
    if (!DATE_ARG_RE.test(date)) continue;

    var wk = weekStartForDate_(date);
    if (!out[wk]) out[wk] = { rows: 0, casings: [] };
    out[wk].rows++;
    if (out[wk].casings.indexOf(channel) === -1) out[wk].casings.push(channel);
  }
  return out;
}

/**
 * cleanupOnlineRevenueSummaryRows — one-shot repair for the online-revenue
 * grain change that shipped in version 23 (aggregateSupplierRows_, 2026-08-03):
 * online revenue is now grouped by SOURCE, where it used to be grouped by
 * CUSTOMER.
 *
 * SUMMARY_KEY_COLS includes `supplier`, so the new source-keyed rows do not
 * update the old customer-keyed ones — upsertRows_ sees a new key and APPENDS
 * alongside them. doGet sums Summary, so every affected week is then counted
 * twice. The stale rows have to be deleted and those weeks re-summarized.
 *
 * SCOPE — matches kind='revenue' AND location='online', both case-insensitive,
 * and nothing else. Wholesale revenue deliberately keeps per-customer grain, so
 * its key is unchanged and its rows are already correct; spend and labour rows
 * are never touched.
 *
 * The apply pass COPIES every matched row to ONLINE_REVENUE_BACKUP_TAB before
 * deleting it. That backup is the whole safety net for a week flagged
 * `resummarizable:false` — re-summarizing such a week regenerates nothing, so
 * the backup row is the only remaining record of the figure.
 *
 * Dry run by default, matching cleanupCorruptSalesRows /
 * cleanupDuplicateSummaryRows: pass false to apply. Idempotent — a second apply
 * finds nothing.
 *
 * @param {boolean} dryRun  false to actually delete; anything else = dry run
 * @returns {Object} { mode, found, deleted, weeks:[{week_start, rows, total, resummarizable, ...}] }
 */
function cleanupOnlineRevenueSummaryRows(dryRun) {
  var isDryRun = (dryRun !== false);
  return withScriptLock_(function () {
    var ss = getHubSpreadsheet_();
    var sheet = ss.getSheetByName(SUMMARY_TAB);
    if (!sheet) { Logger.log('cleanupOnlineRevenueSummaryRows: no Summary tab'); return 'no-sheet'; }

    var data = sheet.getDataRange().getValues();
    var revWeeks = onlineRevenueWeeks_(ss);
    var today = todayStr_();

    // Pass 1: identify + log every match in BOTH modes, so an apply leaves the
    // same audit trail as the dry run that authorized it.
    var matches = [];
    var weeks = {};

    for (var r = 1; r < data.length; r++) {
      var kind = String(data[r][7]).trim().toLowerCase();
      var location = String(data[r][3]).trim().toLowerCase();
      if (kind !== 'revenue' || location !== 'online') continue;

      // shopify_orderapp Summary rows are written directly by the orderapp pull
      // (PRD-10), not derived from Revenue — this cleanup's subject is the v23
      // customer-keyed grain-change rows, and deleting a pull-owned row would be
      // unrecoverable by resummarize (no Revenue rows back it).
      if (String(data[r][2]).trim().toLowerCase() === 'shopify_orderapp') {
        Logger.log('cleanupOnlineRevenueSummaryRows: skipping pull-owned shopify_orderapp row ' + (r + 1));
        continue;
      }

      var weekStart = coerceDateStr_(data[r][0]);
      matches.push(r);

      if (!weeks[weekStart]) {
        var weekEnd = addDaysStr_(weekStart, 6);
        weeks[weekStart] = {
          week_start: weekStart,
          week_end: weekEnd,
          rows: 0,
          total: 0,
          // weeklySummarize REFUSES a week that has not finished, so deleting
          // an in-flight week's rows would be unrecoverable except by hand from
          // the backup tab.
          complete: weekEnd < today,
          revenueRowsPresent: revWeeks[weekStart] ? revWeeks[weekStart].rows : 0,
          channelCasings: revWeeks[weekStart] ? revWeeks[weekStart].casings : []
        };
      }
      weeks[weekStart].rows++;
      weeks[weekStart].total += Number(data[r][4]) || 0;

      Logger.log('cleanupOnlineRevenueSummaryRows: match row ' + (r + 1) +
        ' | week=' + weekStart +
        ' | supplier=' + String(data[r][2]) +
        ' | department=' + String(data[r][6]) +
        ' | total=' + String(data[r][4]));
    }

    var weekList = Object.keys(weeks).sort().map(function (w) {
      var wk = weeks[w];
      wk.total = Math.round(wk.total * 100) / 100;
      wk.resummarizable = wk.complete && wk.revenueRowsPresent > 0;

      if (!wk.resummarizable) {
        Logger.log('cleanupOnlineRevenueSummaryRows: WARNING week ' + w +
          ' is NOT re-summarizable (' +
          (wk.complete ? 'no online rows left in ' + REVENUE_TAB : 'week has not finished yet') +
          ') — restore its figure from ' + ONLINE_REVENUE_BACKUP_TAB + ' by hand.');
      }
      if (wk.channelCasings.length > 1) {
        Logger.log('cleanupOnlineRevenueSummaryRows: WARNING week ' + w +
          ' has mixed channel casing ' + JSON.stringify(wk.channelCasings) +
          ' — rowKey_ lowercases, so one group collapses into the other and the week' +
          ' under-reports. Normalize the casing in ' + REVENUE_TAB + ' BEFORE re-summarizing.');
      }
      return wk;
    });

    Logger.log('cleanupOnlineRevenueSummaryRows: ' + (isDryRun ? 'DRY RUN' : 'APPLY') +
      ' — ' + matches.length + ' online revenue row(s) across ' + weekList.length + ' week(s): ' +
      weekList.map(function (w) { return w.week_start; }).join(', '));

    if (isDryRun) {
      return {
        mode: 'dryRun', found: matches.length, deleted: 0, weeks: weekList,
        rows: matches.map(function (r) { return r + 1; })
      };
    }

    // Pass 2: back up EVERY matched row before a single deleteRow fires. A
    // half-backed-up delete is worse than no cleanup at all.
    var backup = ensureSheet(ss, ONLINE_REVENUE_BACKUP_TAB, SUMMARY_HEADERS);
    for (var b = 0; b < matches.length; b++) backup.appendRow(data[matches[b]]);
    Logger.log('cleanupOnlineRevenueSummaryRows: backed up ' + matches.length +
      ' row(s) to ' + ONLINE_REVENUE_BACKUP_TAB);

    // Pass 3: delete bottom-up so pass-1 row numbers stay valid as rows shift.
    var deleted = 0;
    for (var m = matches.length - 1; m >= 0; m--) {
      sheet.deleteRow(matches[m] + 1);
      deleted++;
    }

    Logger.log('cleanupOnlineRevenueSummaryRows: deleted=' + deleted +
      ' — now run runOnlineRevenueResummarize() to rebuild ' + weekList.length + ' week(s).');
    return { mode: 'apply', found: matches.length, deleted: deleted, weeks: weekList };
  });
}

/**
 * resummarizeWeeks_ — step 4 of the cleanup runbook.
 *
 * weeklySummarize writes ONE week per call, so a single run after the purge
 * would rebuild only the most recent week and leave every older one
 * permanently missing from Summary — doGet would then under-report history
 * instead of double-counting it. This loops it, oldest week first.
 *
 * @param {string[]} weekStarts  'yyyy-MM-dd' Mondays
 * @returns {Object[]} one weeklySummarize result per week, in order
 */
function resummarizeWeeks_(weekStarts) {
  var results = [];
  for (var i = 0; i < weekStarts.length; i++) {
    var res = weeklySummarize(weekStarts[i]);
    results.push({ week: weekStarts[i], result: res });
    Logger.log('resummarizeWeeks_: ' + weekStarts[i] + ' → ' + JSON.stringify(res));
  }
  return results;
}

/**
 * Distinct week_start values sitting in the backup tab, oldest first — the
 * exact set of weeks the apply pass removed, read back rather than re-typed.
 */
function backedUpOnlineRevenueWeeks_(ss) {
  var sheet = ss.getSheetByName(ONLINE_REVENUE_BACKUP_TAB);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var seen = {};
  for (var r = 1; r < data.length; r++) {
    var wk = coerceDateStr_(data[r][0]);
    if (DATE_ARG_RE.test(wk)) seen[wk] = true;
  }
  return Object.keys(seen).sort();
}

/* ------------------------------------------------------------------ *
 * Editor entry points for the v23 online-revenue cleanup runbook.
 *
 * The Apps Script Run button passes NO arguments, so
 * cleanupOnlineRevenueSummaryRows(false) and weeklySummarize('2026-07-27') are
 * both unreachable from the editor without a no-arg wrapper — the first would
 * silently dry-run, the second would summarize last week instead of the week
 * asked for. These also Logger.log their reports, because the editor shows log
 * output but NOT return values.
 *
 * Run order: DryRun → Apply → Resummarize.
 * ------------------------------------------------------------------ */

function runOnlineRevenueCleanupDryRun() {
  var report = cleanupOnlineRevenueSummaryRows();
  Logger.log('DRY RUN (nothing written): ' + JSON.stringify(report, null, 2));
  return report;
}

function runOnlineRevenueCleanupApply() {
  var report = cleanupOnlineRevenueSummaryRows(false);
  Logger.log('APPLIED (written): ' + JSON.stringify(report, null, 2));
  return report;
}

/**
 * Rebuild every week the apply pass removed. Reads its week list from the
 * backup tab, so it is only ever meaningful AFTER runOnlineRevenueCleanupApply.
 */
function runOnlineRevenueResummarize() {
  var ss = getHubSpreadsheet_();
  var weeks = backedUpOnlineRevenueWeeks_(ss);
  if (!weeks.length) {
    Logger.log('runOnlineRevenueResummarize: no weeks in ' + ONLINE_REVENUE_BACKUP_TAB +
      ' — run runOnlineRevenueCleanupApply() first.');
    return { weeks: 0, results: [] };
  }
  Logger.log('runOnlineRevenueResummarize: rebuilding ' + weeks.length +
    ' week(s): ' + weeks.join(', '));
  var results = resummarizeWeeks_(weeks);
  Logger.log('RESUMMARIZED: ' + JSON.stringify(results, null, 2));
  return { weeks: weeks.length, results: results };
}

/* ------------------------------------------------------------------ *
 * Read API (doGet) — token-gated, serves weekly summaries
 * ------------------------------------------------------------------ */

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var tokenCheck = checkReadToken_(params);
    if (!tokenCheck.ok) return jsonOut_({ result: 'error', message: tokenCheck.message });

    var fn = params.fn || 'summary';
    if (fn === 'summary') return doGetSummary_(params);
    if (fn === 'shopspendCoverage') return doGetShopSpendCoverage_();
    return jsonOut_({ result: 'error', message: 'unknown fn: ' + fn });
  } catch (err) {
    return jsonOut_({ result: 'error', message: String((err && err.message) || err) });
  }
}

function doGetSummary_(params) {
  try {
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

    // department/kind are already emitted by summaryDataToObjects_ (it maps
    // every header generically). Keep the JSON field name 'supplier' — on
    // kind='revenue' rows it holds the SOURCE when location is 'online' and the
    // customer name on every other channel (see aggregateSupplierRows_) — and
    // keep 'total_spend' as a one-release alias for 'total' so existing
    // consumers don't break.
    if (params.department) {
      rows = rows.filter(function (r) { return String(r.department) === String(params.department); });
    }
    rows = rows.map(function (r) {
      // Only alias on a migrated (new-header) sheet — an unmigrated sheet's
      // header is still literally 'total_spend' and already carries it via
      // the generic header mapping above; overwriting it with undefined
      // would be a regression, not backward compatibility.
      if (r.total !== undefined) r.total_spend = r.total;
      return r;
    });

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

/**
 * fn=shopspendCoverage — delegates span expansion to shopSpendCoveredWeeks_
 * (shopspend.gs, step 7) so the watchdog and this endpoint never disagree on
 * which weeks count as covered. A missing or empty ShopSpendPulls tab is a
 * normal cold-start state, not an error.
 */
function doGetShopSpendCoverage_() {
  var ss = getHubSpreadsheet_();
  var sheet = ss.getSheetByName(SHOPSPEND_PULLS_TAB);
  var pullsRows = [];
  if (sheet) {
    var data = sheet.getDataRange().getValues();
    pullsRows = data.slice(1);
  }
  var weeks = shopSpendCoveredWeeks_(pullsRows);
  return jsonOut_({ result: 'ok', count: weeks.length, weeks: weeks });
}

function timingSafeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  var mismatch = a.length === b.length ? 0 : 1;
  // Compare a against itself when lengths differ, so the loop's cost tracks
  // the caller-supplied value rather than leaking the secret's length.
  var other = mismatch ? a : b;
  for (var i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ other.charCodeAt(i);
  }
  return mismatch === 0;
}

function checkReadToken_(params) {
  var stored = PropertiesService.getScriptProperties().getProperty('API_READ_TOKEN');
  if (!stored) return { ok: false, message: 'unauthorized' };
  if (!params.token) return { ok: false, message: 'unauthorized' };
  // Not a plain !== — since the write path (doPost weeks_verified_empty) reuses
  // this check, the comparison guards a destructive operation and must not
  // short-circuit on the first differing character.
  if (!timingSafeEqual_(String(params.token), stored)) return { ok: false, message: 'unauthorized' };
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

var DATE_ARG_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a caller/trigger-supplied date argument to 'YYYY-MM-DD'.
 * A time-based trigger invokes its handler with an EVENT OBJECT as arg 1 — truthy,
 * so `if (!arg)` lets it through and the stringified object lands in a date cell.
 * Accept ONLY a real YYYY-MM-DD calendar date; anything else (event object,
 * 'yesterday', '2026-7-5', '2026-02-31') falls back.
 */
function resolveDateArg_(arg, fallback) {
  if (typeof arg !== 'string') return fallback;
  var s = arg.trim();
  if (!DATE_ARG_RE.test(s)) return fallback;
  var d = new Date(s + 'T00:00:00Z');                    // regex admits 2026-02-31
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return fallback;
  return s;
}

/**
 * Add n days to a 'YYYY-MM-DD' string. Noon-UTC anchor mirrors weekStartForDate_
 * so DST can never shift the result across a day boundary.
 */
function addDaysStr_(dateStr, n) {
  var d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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

/**
 * Aggregate one week's raw rows into Summary groups.
 * @param {Array}  rows      Suppliers-shaped rows (kind='spend', default) or
 *                            Revenue-shaped rows (kind='revenue').
 * @param {string} weekStart 'YYYY-MM-DD'
 * @param {string} weekEnd   'YYYY-MM-DD'
 * @param {string} [kind]    'spend' (default) | 'revenue'
 * @returns {Array<{supplier, location, department, kind, total}>}
 *   Spend: supplier=supplier name, location=location, department=row[7].
 *   Revenue: location=channel, department=row[1], supplier (JSON field name
 *     kept for doGet compat) = the customer name. channel='online' rows
 *     (case-insensitive) are EXCLUDED from the rollup entirely (PRD-10):
 *     online revenue's sole producer is shopifyWeeklyPull's pull-owned
 *     supplier='shopify_orderapp' Summary row — deriving a second row here
 *     would double-count beside it. Wholesale customers are real named
 *     accounts and keep their own weekly line. Revenue is never netted
 *     against spend — each kind aggregates into its own groups.
 */
function aggregateSupplierRows_(rows, weekStart, weekEnd, kind) {
  kind = kind || 'spend';
  var groups = {};
  var onlineExcludedCount = 0;
  var onlineExcludedTotal = 0;
  for (var i = 0; i < rows.length; i++) {
    var date = coerceDateStr_(rows[i][0]);
    if (date < weekStart || date > weekEnd) continue;

    var name, location, total, department;
    if (kind === 'revenue') {
      department = rows[i][1] ? String(rows[i][1]) : DEFAULT_DEPARTMENT;
      var channel = String(rows[i][2]);
      location = channel;
      // Online revenue is PULL-OWNED (PRD-10): shopifyWeeklyPull writes the
      // supplier='shopify_orderapp' Summary row directly, and validateIngest_
      // rejects new online Revenue POSTs. Deriving a second per-source online
      // row here would sit BESIDE the pull row (different key, both served by
      // doGet — an additive double-count). Residual channel='online' Revenue
      // rows are historical; they are counted, logged and excluded.
      if (channel.trim().toLowerCase() === 'online') {
        onlineExcludedCount++;
        onlineExcludedTotal += Number(rows[i][4]) || 0;
        continue;
      }
      // Every non-online channel (wholesale especially) keeps per-customer
      // grain: those are real named accounts, and doGet serves Summary only —
      // collapsing them would delete per-customer weekly revenue from the API
      // with no replacement.
      name = String(rows[i][3]);       // customer
      total = Number(rows[i][4]);      // amount
    } else {
      name = String(rows[i][1]);       // supplier
      total = Number(rows[i][2]);
      location = String(rows[i][4]);
      department = rows[i][7] ? String(rows[i][7]) : DEFAULT_DEPARTMENT;
    }

    var key = department + '||' + kind + '||' + name + '||' + location;
    if (!groups[key]) groups[key] = { supplier: name, location: location, department: department, kind: kind, total: 0 };
    groups[key].total += total;
  }

  var result = [];
  var keys = Object.keys(groups).sort();
  for (var k = 0; k < keys.length; k++) {
    var g = groups[keys[k]];
    result.push({
      supplier: g.supplier,
      location: g.location,
      department: g.department,
      kind: g.kind,
      total: Math.round(g.total * 100) / 100
    });
  }
  if (onlineExcludedCount > 0) {
    Logger.log('aggregateSupplierRows_: excluded ' + onlineExcludedCount +
      ' historical channel=online Revenue row(s) ($' +
      (Math.round(onlineExcludedTotal * 100) / 100) + ') from ' + weekStart +
      ' — online revenue is pull-owned (shopify_orderapp, PRD-10); ' +
      'the figure for pre-pull weeks lives in ' + ONLINE_REVENUE_BACKUP_TAB);
  }
  return result;
}

/**
 * The single source of truth for what a Summary heal WOULD do, for a given
 * set of weeks. Both the read-only preview (previewSummaryHeal) and the
 * eventual write path call this — they must never diverge, because the
 * preview is the only look Jake gets before real money moves. Pure: `ctx` is
 * built ONCE by the caller and holds `archiveWeeks` (a Set of week_start
 * strings present in `_archive`), `summaryRows` (live Summary values,
 * header included), `supplierRows`, `revenueRows` — this function performs
 * NO Sheet reads and NO Sheet writes.
 *
 * @param {string[]} weeks 'YYYY-MM-DD' week_start strings to plan
 * @param {{archiveWeeks:Object, summaryRows:Array, supplierRows:Array, revenueRows:Array}} ctx
 * @returns {Array<{week:string, action:string, rows:Array, projectedSetValues:number, reason:?string}>}
 *   action is one of:
 *     'heal'                 — rows is [{key, live, computed, delta, isNew}]
 *     'skip-split'           — the week has at least one _archive row
 *     'refuse-duplicate-keys'— the live Summary already holds duplicate keys
 *   No pull-owned filtering of any kind: a derived row (e.g. Bennetts,
 *   location='') is healed like any other. Rows that are structurally
 *   unreachable from Suppliers/Revenue (e.g. shopify_orderapp's online
 *   revenue, excluded by aggregateSupplierRows_ itself) never appear in the
 *   recomputed batch and so are left untouched, not orphaned.
 */
function computeHealPlan_(weeks, ctx) {
  var archiveWeeks = ctx.archiveWeeks || {};
  var summaryRows = ctx.summaryRows || [];
  var supplierRows = ctx.supplierRows || [];
  var revenueRows = ctx.revenueRows || [];

  var plan = [];
  for (var w = 0; w < weeks.length; w++) {
    var week = weeks[w];
    var weekEnd = addDaysStr_(week, 6);

    if (archiveWeeks[week]) {
      plan.push({
        week: week,
        action: 'skip-split',
        rows: [],
        projectedSetValues: 0,
        reason: 'week has _archive row(s) — a heal here would overwrite a partial recompute (split week)'
      });
      continue;
    }

    // Live rows for this week, keyed exactly as rowKey_(SUMMARY_KEY_COLS)
    // would key them — duplicate detection mirrors that normalization.
    var liveCounts = {};
    var live = {};
    for (var s = 1; s < summaryRows.length; s++) {
      var srow = summaryRows[s];
      if (coerceDateStr_(srow[0]) !== week) continue;
      var lkey = rowKey_(srow, SUMMARY_KEY_COLS);
      liveCounts[lkey] = (liveCounts[lkey] || 0) + 1;
      live[lkey] = { total: Number(srow[SUMMARY_TOTAL_COL]) };
    }
    var hasDuplicate = false;
    for (var lk in liveCounts) {
      if (liveCounts[lk] > 1) { hasDuplicate = true; break; }
    }
    if (hasDuplicate) {
      plan.push({
        week: week,
        action: 'refuse-duplicate-keys',
        rows: [],
        projectedSetValues: 0,
        reason: 'live Summary already holds duplicate keys for this week — refusing to heal until deduplicated'
      });
      continue;
    }

    var recomputed = aggregateSupplierRows_(supplierRows, week, weekEnd, 'spend')
      .concat(aggregateSupplierRows_(revenueRows, week, weekEnd, 'revenue'));

    var rows = [];
    var projectedSetValues = 0;
    for (var g = 0; g < recomputed.length; g++) {
      var grp = recomputed[g];
      var keyRow = mayersSummaryKeyRow_(week, grp.department, grp.kind, grp.supplier, grp.location);
      var key = rowKey_(keyRow, SUMMARY_KEY_COLS);
      var hit = live[key];

      if (!hit) {
        // Brand-new row: upsertRows_ appends it — 0 setValue calls.
        rows.push({ key: key, live: null, computed: grp.total, delta: grp.total, isNew: true });
        continue;
      }
      if (auditCents_(hit.total) === auditCents_(grp.total)) continue; // matches — nothing to write

      var delta = Math.round((grp.total - hit.total) * 100) / 100;
      // An updated row: upsertRows_ pays amountCol + stampCol — 2 setValue calls.
      rows.push({ key: key, live: hit.total, computed: grp.total, delta: delta, isNew: false });
      projectedSetValues += 2;
    }

    plan.push({ week: week, action: 'heal', rows: rows, projectedSetValues: projectedSetValues, reason: null });
  }
  return plan;
}

/* ------------------------------------------------------------------ *
 * Guarded shared write path (PRD-12) — healWeeks_/healWeek_
 *
 * healWeek_ is the ONE place a heal (scheduled or override, including every
 * greenBeanPull_ override call routed through weeklySummarize) is allowed to
 * touch Summary: snapshot-once backup, SPLIT guard, duplicate-key refusal,
 * the actual upsert, and the correction alert all live here so no caller can
 * write around any of them.
 * ------------------------------------------------------------------ */

/**
 * Pure. Given Summary_heal_backup rows (possibly holding more than one
 * snapshot for a week, which healBackupWeek_'s write-once guard is meant to
 * prevent but a restore must still defend against), returns only the
 * EARLIEST snapshot's rows for that week — never a later, already-corrected
 * one. Row shape is SUMMARY_HEAL_BACKUP_HEADERS (SUMMARY_HEADERS + run_id);
 * "earliest" is decided by original row order (append order), not run_id
 * content.
 * @param {Array} backupRows  Summary_heal_backup DATA rows (no header)
 * @param {string} week 'YYYY-MM-DD'
 * @returns {Array} the earliest snapshot's rows for `week`, or []
 */
function healEarliestBackupRows_(backupRows, week) {
  var firstRunId = null;
  var result = [];
  for (var i = 0; i < backupRows.length; i++) {
    var row = backupRows[i];
    if (coerceDateStr_(row[0]) !== week) continue;
    var runId = row[8];
    if (firstRunId === null) firstRunId = runId;
    if (runId !== firstRunId) continue; // a later snapshot for the same week — ignore
    result.push(row);
  }
  return result;
}

/**
 * Snapshot-once backup of a week's LIVE Summary rows (pre-heal state) to
 * SUMMARY_HEAL_BACKUP_TAB, tagged with ctx.runId. Refuses to overwrite an
 * existing snapshot for the week — without that, healing the same week twice
 * would store the POST-heal values as a later "snapshot", and a restore
 * would restore the corruption instead of undoing it. Always runs BEFORE any
 * guard decision or write, so a SPLIT-skipped or duplicate-refused week is
 * backed up exactly like a healed one.
 * @returns {boolean} true — a snapshot for `week` exists after this call.
 */
function healBackupWeek_(week, ctx) {
  if (ctx.backedUpWeeks[week]) return true;

  var rowsForWeek = [];
  for (var i = 1; i < ctx.summaryRows.length; i++) { // row 0 = header
    var row = ctx.summaryRows[i];
    if (coerceDateStr_(row[0]) !== week) continue;
    rowsForWeek.push(row.concat([ctx.runId]));
  }
  for (var r = 0; r < rowsForWeek.length; r++) {
    ctx.backupSheet.appendRow(rowsForWeek[r]);
  }
  ctx.backedUpWeeks[week] = true;
  return true;
}

/**
 * Raise one all-day calendar alert for a heal event on `week`. Reuses
 * stalenessCalendar_'s acquisition mechanism (staleness.gs) — never throws.
 * @param {boolean} highSeverity RED (not ORANGE) — reserved for a SPLIT-skip
 *   or duplicate-refusal of the NEWEST week: a silently un-summarized current
 *   week is worse than a slightly wrong one (PRD-12).
 */
function healRaiseAlert_(week, kind, detail, highSeverity) {
  try {
    var cal = stalenessCalendar_();
    if (!cal) {
      Logger.log('healRaiseAlert_: no calendar available for week ' + week + ' (' + kind + ')');
      return;
    }
    var title = 'LEIBLE expense Summary heal ' + week + ': ' + kind;
    var ev = cal.createAllDayEvent(title, new Date(Date.now()));
    ev.setColor(highSeverity ? CalendarApp.EventColor.RED : CalendarApp.EventColor.ORANGE);
    ev.setDescription((detail || '') + '\n\nWeek: ' + week +
      '\nSnapshot: ' + SUMMARY_HEAL_BACKUP_TAB + ' (earliest run_id per week is the pre-heal truth).');
  } catch (err) {
    Logger.log('healRaiseAlert_: failed for week ' + week + ' — ' + err.message);
  }
}

/**
 * The guarded per-week write. Every caller (the scheduled run and every
 * override, greenBeanPull_'s included) goes through this — see healWeeks_
 * for the shared entry point that builds `ctx` once per run and calls this
 * per week, newest-first.
 *
 * Order, always: (1) backup (2) SPLIT guard (3) duplicate-key refusal
 * (4) write via one upsertRows_ call (5) correction alert, raised
 * immediately — never batched to the end of the run.
 *
 * No pull-owned filtering of any kind: a derived row (Bennetts, blank
 * location) is healed like any other; a row structurally unreachable from
 * Suppliers/Revenue (shopify_orderapp's online revenue) is left untouched,
 * not orphaned, because aggregateSupplierRows_ itself never recomputes it.
 *
 * @param {string} week 'YYYY-MM-DD'
 * @param {{archiveWeeks:Object, summaryRows:Array, supplierRows:Array,
 *   revenueRows:Array, summSheet:Sheet, backupSheet:Sheet,
 *   backedUpWeeks:Object, runId:string, extractedAt:string}} ctx built ONCE
 *   by the caller — never per week.
 * @param {boolean} [isNewest] — true only for the newest week in the caller's
 *   batch; escalates a SPLIT-skip/duplicate-refusal alert to high severity.
 * @returns {{week:string, action:string, reason:?string, rowsAdded:number,
 *   rowsUpdated:number, updates:Array<{key:string,from:number,to:number}>,
 *   backedUp:boolean}}
 */
function healWeek_(week, ctx, isNewest) {
  healBackupWeek_(week, ctx);

  var plan = computeHealPlan_([week], ctx)[0];

  if (plan.action === 'skip-split' || plan.action === 'refuse-duplicate-keys') {
    healRaiseAlert_(week,
      plan.action === 'skip-split' ? 'SPLIT week skipped' : 'duplicate keys — refused',
      plan.reason, !!isNewest);
    return {
      week: week, action: plan.action, reason: plan.reason,
      rowsAdded: 0, rowsUpdated: 0, updates: [], backedUp: true
    };
  }

  var weekEnd = addDaysStr_(week, 6);
  var recomputed = aggregateSupplierRows_(ctx.supplierRows, week, weekEnd, 'spend')
    .concat(aggregateSupplierRows_(ctx.revenueRows, week, weekEnd, 'revenue'));
  var normalizedRows = recomputed.map(function (g) {
    return [week, weekEnd, g.supplier, g.location, g.total, ctx.extractedAt, g.department, g.kind];
  });

  var writeRes = upsertRows_(ctx.summSheet, normalizedRows, SUMMARY_KEY_COLS, SUMMARY_TOTAL_COL, SUMMARY_STAMP_COL);

  if (writeRes.updates.length > 0) {
    var detail = writeRes.updates.map(function (u) {
      return u.key + ': ' + u.from + ' -> ' + u.to;
    }).join('\n');
    healRaiseAlert_(week, 'Summary corrected', detail, false);
  }

  return {
    week: week, action: 'heal', reason: null,
    rowsAdded: writeRes.rowsAdded, rowsUpdated: writeRes.rowsUpdated,
    updates: writeRes.updates, backedUp: true
  };
}

/**
 * Shared entry point for both the scheduled run and every override
 * (greenBeanPull_'s up-to-5-per-run override calls included). Builds `ctx`
 * ONCE for the whole batch — a per-week ctx build would add a full
 * `_archive` read (and a Summary snapshot) per week on a path already near
 * the 6-minute GAS ceiling, where a timeout is a partial-ingest event — then
 * processes `weeks` NEWEST-first regardless of input order, so a mid-run
 * death always leaves the most recent weeks done.
 *
 * A refused/skipped NEWEST week is a loud, run-level failure: the current
 * week is what every report and LEIBLE_GM_COST_MONITOR reads, and a silently
 * un-summarized current week is worse than a slightly wrong one. The same
 * failure on an older week is not fatal — only the newest week's success
 * gates `success`.
 *
 * @param {string[]} weeks 'YYYY-MM-DD' week_start strings, any order.
 * @returns {{weeks:Array, success:boolean, newestWeekFailed:boolean}}
 */
function healWeeks_(weeks) {
  var ss = getHubSpreadsheet_();
  var suppSheet = ss.getSheetByName(SUPPLIERS_TAB);
  var archSheet = ensureSheet(ss, ARCHIVE_TAB, SUPPLIERS_HEADERS);
  var summSheet = ensureSheet(ss, SUMMARY_TAB, SUMMARY_HEADERS);
  var revSheet = ensureSheet(ss, REVENUE_TAB, REVENUE_HEADERS);
  var backupSheet = ensureSheet(ss, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);

  var archRows = archSheet.getDataRange().getValues().slice(1);
  var archiveWeeks = {};
  archRows.forEach(function (r) {
    var d = coerceDateStr_(r[0]);
    if (DATE_ARG_RE.test(d)) archiveWeeks[weekStartForDate_(d)] = true;
  });

  var backupRows = backupSheet.getDataRange().getValues().slice(1);
  var backedUpWeeks = {};
  backupRows.forEach(function (r) { backedUpWeeks[coerceDateStr_(r[0])] = true; });

  var nowStamp = Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX");

  var ctx = {
    archiveWeeks: archiveWeeks,
    summaryRows: summSheet.getDataRange().getValues(),
    supplierRows: suppSheet ? suppSheet.getDataRange().getValues().slice(1) : [],
    revenueRows: revSheet ? revSheet.getDataRange().getValues().slice(1) : [],
    summSheet: summSheet,
    backupSheet: backupSheet,
    backedUpWeeks: backedUpWeeks,
    runId: 'HEAL-' + nowStamp,
    extractedAt: nowStamp
  };

  var sorted = weeks.slice().sort().reverse(); // 'YYYY-MM-DD' sorts lexically — newest first

  var results = [];
  var newestWeekFailed = false;
  for (var i = 0; i < sorted.length; i++) {
    var isNewest = (i === 0);
    var res = healWeek_(sorted[i], ctx, isNewest);
    results.push(res);
    if (isNewest && (res.action === 'skip-split' || res.action === 'refuse-duplicate-keys')) {
      newestWeekFailed = true;
    }
  }

  return { weeks: results, success: !newestWeekFailed, newestWeekFailed: newestWeekFailed };
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

/**
 * Summarize one week into the Summary tab, then archive/purge old Suppliers rows.
 *
 * @param {string} [weekStartOverride] — any 'YYYY-MM-DD' inside the target week;
 *   it is SNAPPED to that week's Monday. Used to summarize a backlog week that
 *   the Monday trigger has already passed by. A non-date arg (e.g. a trigger
 *   event object) falls back to the last completed week.
 */
function weeklySummarize(weekStartOverride) {
  // Entry-point lock (§1c): weeklySummarize is a read-modify-write across
  // Suppliers/Revenue/Summary/_archive. Locking only the inner writes would
  // let a concurrent doPost finish its scan before this holds the lock and
  // still race it — so the whole entry point is wrapped, not the helpers.
  var res = withScriptLock_(function () { return weeklySummarize_impl_(weekStartOverride); });
  if (res === LOCK_TIMEOUT_) {
    Logger.log('weeklySummarize: could not acquire script lock — skipped this run');
    return { refused: 'locked' };
  }
  return res;
}

/**
 * How many weeks a SCHEDULED (no-override) run heals. The kill switch
 * (SUMMARY_HEAL_ENABLED, default OFF/absent) controls ONLY this — every gate
 * in healWeek_ stays active regardless: "off" means "today's single-week
 * behaviour, now guarded", never "gates bypassed".
 */
function summaryHealWindowSize_() {
  var props = PropertiesService.getScriptProperties();
  var enabled = String(props.getProperty('SUMMARY_HEAL_ENABLED') || '').toLowerCase() === 'true';
  if (!enabled) return 1;
  var n = Number(props.getProperty('SUMMARY_HEAL_WEEKS'));
  return (isFinite(n) && n > 0) ? Math.floor(n) : SUMMARY_HEAL_WEEKS_;
}

function weeklySummarize_impl_(weekStartOverride) {
  var ss = getHubSpreadsheet_();
  var suppSheet = ss.getSheetByName(SUPPLIERS_TAB);
  if (!suppSheet) { Logger.log('weeklySummarize: no Suppliers tab'); return; }

  var summSheet = ensureSheet(ss, SUMMARY_TAB, SUMMARY_HEADERS);
  ensureSheet(ss, ARCHIVE_TAB, SUPPLIERS_HEADERS);
  ensureSheet(ss, REVENUE_TAB, REVENUE_HEADERS);
  ensureSheet(ss, SUMMARY_HEAL_BACKUP_TAB, SUMMARY_HEAL_BACKUP_HEADERS);

  var today = todayStr_();                              // KEEP: still used for cutoffDate below
  var ovr = resolveDateArg_(weekStartOverride, null);   // trigger-event safe
  var weeks;
  if (ovr) {
    // Snap to Monday: an unsnapped week_start writes Summary rows that overlap
    // the trigger's Monday-aligned rows -> filterSummaryByDateRange_ returns both
    // -> double-counted spend. Dedup keys on week_start, so it would NOT save us.
    var start = weekStartForDate_(ovr);
    var weekEnd = addDaysStr_(start, 6);

    // Refuse a week that hasn't finished yet. Summary now upserts (§1h), so a
    // re-summarize CAN correct a frozen partial total in principle — but a
    // partial week written to Summary is indistinguishable from a final one to
    // any consumer of doGet in the meantime, and nothing guarantees a
    // re-summarize ever happens before that partial figure is read/reported
    // on. Only a completed week may be summarized.
    if (weekEnd >= today) {
      Logger.log('weeklySummarize: REFUSED incomplete week ' + start + ' … ' + weekEnd +
        ' (today=' + today + ') — a partial total would be frozen by dedup. ' +
        'Re-run once the week has ended.');
      return {
        weekStart: start, weekEnd: weekEnd,
        refused: 'incomplete-week',
        summariesAdded: 0, labourTabAdded: 0, labourSummaryAdded: 0
      };
    }

    Logger.log('weeklySummarize: override ' + ovr + ' → week ' + start + ' … ' + weekEnd);
    weeks = [start];
  } else {
    var windowSize = summaryHealWindowSize_();
    var last = getLastCompletedWeek_(today);
    weeks = [];
    for (var i = 0; i < windowSize; i++) weeks.push(addDaysStr_(last.start, -7 * i));
  }

  // The ONE guarded write path — backup, SPLIT guard, duplicate-key refusal,
  // upsert, correction alert — shared by the scheduled run and this override
  // alike (Code.gs: healWeeks_/healWeek_).
  var healRes = healWeeks_(weeks);

  // Labour is a second, independent write against Summary (its own source,
  // its own upsert). It respects the same guard: only weeks healWeeks_
  // actually healed (never a SPLIT/refused one — the guard means "write
  // nothing", full stop) are eligible, and the source is read once for the
  // whole batch, not once per week.
  var extractedAt = Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX");
  var labourWeeks = [];
  healRes.weeks.forEach(function (w) {
    if (w.action === 'heal') labourWeeks.push({ start: w.week, end: addDaysStr_(w.week, 6) });
  });
  var labourResult = { labourAdded: 0, summaryAdded: 0, summaryUpdated: 0 };
  if (labourWeeks.length > 0) {
    labourResult = labourWeeklyPull_(labourWeeks, ss, summSheet, extractedAt);
    if (labourResult.summaryAdded + labourResult.summaryUpdated > 0) {
      healRaiseAlert_(labourWeeks.map(function (w) { return w.start; }).join(', '), 'Labour correction',
        'labourAdded=' + labourResult.labourAdded + ' summaryAdded=' + labourResult.summaryAdded +
        ' summaryUpdated=' + labourResult.summaryUpdated, false);
    }
  }

  var cutoffDate = new Date(today + 'T12:00:00Z');
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - ARCHIVE_RETENTION_DAYS);
  var cutoffStr = cutoffDate.toISOString().slice(0, 10);

  // Archive/purge is weekly MAINTENANCE and belongs to the scheduled run only.
  // On an override (backlog) run it would purge the very Suppliers rows just
  // summarized — and since a re-run then reads an empty source, it would report
  // summariesAdded:0, which reads as "already done" but actually means "the
  // source data is gone". Manual backfills must be repeatable. Runs exactly
  // once per scheduled run, never once per healed week.
  if (!ovr) {
    var archSheet = ss.getSheetByName(ARCHIVE_TAB);
    archiveAndPurge_(suppSheet, archSheet, cutoffStr);
  } else {
    Logger.log('weeklySummarize: override run — skipping archive/purge (maintenance is the trigger\'s job)');
  }

  // A single-week run (every override, and a scheduled run with the kill
  // switch off) keeps the pre-existing flat return shape — callers
  // (greenBeanPull_, the older test suite) depend on weekStart/weekEnd/
  // summariesAdded/summariesUpdated/labourTabAdded/labourSummaryAdded/
  // refused living at the top level, not nested under `weeks`.
  if (weeks.length === 1) {
    var wk = healRes.weeks[0];
    var wkEnd = addDaysStr_(wk.week, 6);
    if (wk.action !== 'heal') {
      return {
        weekStart: wk.week, weekEnd: wkEnd,
        refused: wk.action,
        summariesAdded: 0, summariesUpdated: 0, labourTabAdded: 0, labourSummaryAdded: 0
      };
    }
    Logger.log('weeklySummarize: week ' + wk.week + ' → ' + wkEnd +
      ', supplierSummariesAdded=' + wk.rowsAdded +
      ', supplierSummariesUpdated=' + wk.rowsUpdated +
      ', labourTabAdded=' + labourResult.labourAdded +
      ', labourSummaryAdded=' + labourResult.summaryAdded +
      ', cutoff=' + cutoffStr);
    return {
      weekStart: wk.week, weekEnd: wkEnd,
      summariesAdded: wk.rowsAdded,
      summariesUpdated: wk.rowsUpdated,
      labourTabAdded: labourResult.labourAdded,
      labourSummaryAdded: labourResult.summaryAdded
    };
  }

  Logger.log('weeklySummarize: healed ' +
    healRes.weeks.map(function (w) { return w.week + ':' + w.action; }).join(', ') +
    ', success=' + healRes.success + ', cutoff=' + cutoffStr);
  return {
    weeks: healRes.weeks,
    success: healRes.success,
    newestWeekFailed: healRes.newestWeekFailed,
    weekStart: healRes.weeks[0].week,
    weekEnd: addDaysStr_(healRes.weeks[0].week, 6)
  };
}

function archiveAndPurge_(sourceSheet, archiveSheet, cutoffDateStr) {
  var data = sourceSheet.getDataRange().getValues();
  var archived = 0;
  var alreadyArchived = 0;

  /* `_archive` has no dedup of its own, and appendRow always appends. So an
   * invoice that was re-ingested into Suppliers after being purged gained
   * ANOTHER archive copy on the next run — and another, every cycle. By
   * 2026-08-25 nine weeks held six copies each of the same invoices, and any
   * reader summing Suppliers + _archive over-counted by $20,624.23.
   *
   * The re-ingest that starts the cycle is fixed in ingestSupplierRows, but
   * this is the step that MULTIPLIES it, so it guards too: purge the Suppliers
   * row either way, only append when the archive does not already hold it. */
  var archivedKeys = buildKeySet_(archiveSheet, SUPPLIERS_KEY_COLS);

  for (var r = data.length - 1; r >= 1; r--) {
    var rowDate = coerceDateStr_(data[r][0]);
    // A blank date coerces to '' and '' <= any cutoff is TRUE, which would
    // archive+purge every blank row. Only ever act on a real calendar date.
    if (!DATE_ARG_RE.test(rowDate)) continue;
    if (rowDate <= cutoffDateStr) {
      var key = rowKey_(data[r], SUPPLIERS_KEY_COLS);
      if (key !== '||' && archivedKeys[key] === true) {
        alreadyArchived++;                 // already preserved — do not duplicate it
      } else {
        archiveSheet.appendRow(data[r]);
        if (key !== '||') archivedKeys[key] = true;   // guard within this run too
        archived++;
      }
      sourceSheet.deleteRow(r + 1);
    }
  }

  Logger.log('archiveAndPurge_: archived=' + archived +
    ' alreadyInArchive=' + alreadyArchived +
    ' rows older than ' + cutoffDateStr);
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
