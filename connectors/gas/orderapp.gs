/**
 * orderapp.gs — shared plumbing for the LEIBLE_Order_app read-API pulls.
 *
 * These pulls live in GAS (not a Python connector) because they need the
 * hub's internal upsert helpers and Google-side scheduling; the doPost
 * boundary is for external connectors only.
 */

var ORDER_APP_EXEC_URL = 'https://script.google.com/macros/s/AKfycbwuLSrcyi-e0dLyjEP4-unU5CLCywm6-SRFhSOq_Cufdn0MnvY0MtP4zNvGj20Dy4S9RQ/exec'; // PROD, not a secret
var ORDER_APP_TOKEN_PROP = 'ORDER_APP_COST_TOKEN'; // Script Property; value = Order app's COST_API_TOKEN. Jake pastes it manually. NEVER in repo/logs.
var ORDERAPP_FAILCOUNT_PREFIX = 'ORDERAPP_FAILCOUNT_';
var ORDERAPP_ALERT_THRESHOLD = 2;

var SHOPIFY_REPULL_WEEKS = 4;
// Never 'shopify' — aggregateSupplierRows_ names online Revenue-tab Summary
// groups by their `source`, so a channel='online', source='shopify' Revenue
// row would produce the byte-identical Summary key as this writer and the
// two would silently overwrite each other (last-write-wins, no divergence
// signal). See docs/schema.md's shopify_orderapp note.
var SHOPIFY_ORDERAPP_SOURCE = 'shopify_orderapp';

// Reserved in docs/ingest-contract.md §1 for exactly this writer — the
// PRD-14 roastery wholesale pull.
var WHOLESALE_SOURCE = 'coffee_order_app';

// 8, not SHOPIFY_REPULL_WEEKS's 4: an order enters the wholesaleSales window
// only once Invoice_Status reaches Finalized/Archived, which lags the
// order-entry date, and Invoice_Total stays editable after that. The step-0
// PROD probe saw non-zero `excluded` (in-week but not yet Finalized) in 2 of
// 8 weeks — the lag is real, not theoretical, so the repull window has to
// reach back far enough to self-heal it.
var WHOLESALE_REPULL_WEEKS_ = 8;
var WHOLESALE_REPULL_WEEKS_PROP = 'WHOLESALE_REPULL_WEEKS';

// The producer's own default page size. It silently CLAMPS an over-cap
// request (Math.min(reqLimit, 500)) instead of returning BAD_REQUEST, so a
// mis-set value here would give no error signal — just a smaller page.
var WHOLESALE_PAGE_LIMIT = 200;
var WHOLESALE_MAX_PAGES = 20; // page-cap backstop, mirrors GREENBEAN_MAX_PAGES

// Heartbeat low-water mark, NOT the median: the worst observed external week
// was $1,200.30 and a median floor (~$1,934) would suppress the heartbeat
// about half the time.
var WHOLESALE_GROSS_FLOOR = 800;

var WHOLESALE_DIAGNOSTIC_FLAGS_ = ['rowsOk', 'crossFootOk', 'moneyOk', 'partitionOk', 'byShopOk'];

/**
 * @returns {number} WHOLESALE_REPULL_WEEKS Script Property, or the constant
 * fallback when unset or unparseable.
 */
function wholesaleRepullWeeks_() {
  var raw = PropertiesService.getScriptProperties().getProperty(WHOLESALE_REPULL_WEEKS_PROP);
  var parsed = Number(raw);
  return (raw && isFinite(parsed)) ? parsed : WHOLESALE_REPULL_WEEKS_;
}

/**
 * Pure shape gate for one ?api=wholesaleSales week body, sibling to
 * shopifyValidWeekBody_. Rejects unless the five diagnostics flags are all
 * STRICTLY true (never a loose/truthy check — the producer computes them
 * over its own internal identities, and they are the only signal that the
 * money is real rather than a getCol() miss zeroing every gross while row
 * counts still balance).
 * @param {Object} body — the parsed ?api=wholesaleSales response.
 * @param {{label:string, start:string, end:string}} requestedWeek — a
 *   lastCompletedWeeks_ entry.
 * @returns {{ok:true, weekStart:string, summary:Object, paging:Object}|{ok:false, reason:string}}
 */
function wholesaleValidWeekBody_(body, requestedWeek) {
  if (!body || typeof body !== 'object' || !body.meta || typeof body.meta !== 'object') {
    return { ok: false, reason: 'missing meta' };
  }
  if (body.meta.week !== requestedWeek.label) {
    return { ok: false, reason: 'meta.week ' + body.meta.week + ' does not echo requested ' + requestedWeek.label };
  }
  if (typeof body.meta.weekStart !== 'string') {
    return { ok: false, reason: 'meta.weekStart is not a string' };
  }
  var weekStart = body.meta.weekStart.slice(0, 10);
  if (weekStart !== requestedWeek.start) {
    return { ok: false, reason: 'meta.weekStart ' + weekStart + ' does not echo requested ' + requestedWeek.start };
  }

  if (!body.summary || typeof body.summary !== 'object') {
    return { ok: false, reason: 'missing summary' };
  }
  var buckets = ['all', 'internal', 'external', 'ambiguous', 'unknown'];
  for (var b = 0; b < buckets.length; b++) {
    var bucketName = buckets[b];
    var bucket = body.summary[bucketName];
    if (!bucket || typeof bucket !== 'object') {
      return { ok: false, reason: 'summary.' + bucketName + ' is missing' };
    }
    if (typeof bucket.orderCount !== 'number' || !isFinite(bucket.orderCount)) {
      return { ok: false, reason: 'summary.' + bucketName + '.orderCount is not a finite number: ' + bucket.orderCount };
    }
    if (typeof bucket.gross !== 'number' || !isFinite(bucket.gross)) {
      return { ok: false, reason: 'summary.' + bucketName + '.gross is not a finite number: ' + bucket.gross };
    }
  }

  if (!body.diagnostics || typeof body.diagnostics !== 'object') {
    return { ok: false, reason: 'missing diagnostics' };
  }
  for (var f = 0; f < WHOLESALE_DIAGNOSTIC_FLAGS_.length; f++) {
    var flag = WHOLESALE_DIAGNOSTIC_FLAGS_[f];
    if (body.diagnostics[flag] !== true) {
      return { ok: false, reason: 'diagnostics.' + flag + ' is not true' };
    }
  }

  if (!body.meta.paging || typeof body.meta.paging !== 'object') {
    return { ok: false, reason: 'missing meta.paging' };
  }
  // typeof, NOT isFinite(Number(x)) — Number(null), Number('') and Number([])
  // are all 0, a "finite" value that would pass. `matched` sizes the paging
  // loop, so a null reading as 0 means the scan believes it has collected
  // everything after page 0. The collected-vs-matched check downstream does
  // catch it, but the gate is the layer that is supposed to reject a
  // malformed body — and this is the same strictness the money fields above
  // already use.
  var pagingFields = ['matched', 'returned', 'limit', 'offset'];
  for (var p = 0; p < pagingFields.length; p++) {
    var pagingVal = body.meta.paging[pagingFields[p]];
    if (typeof pagingVal !== 'number' || !isFinite(pagingVal)) {
      return { ok: false, reason: 'meta.paging.' + pagingFields[p] + ' is not a finite number: ' + pagingVal };
    }
  }

  if (!Array.isArray(body.orders)) {
    return { ok: false, reason: 'orders is not an array' };
  }

  return { ok: true, weekStart: weekStart, summary: body.summary, paging: body.meta.paging };
}

/* ------------------------------------------------------------------ *
 * Fetch / auth / classify
 * ------------------------------------------------------------------ */

/**
 * @returns {string|null} the token, or null (and a skip-safe log) if unset.
 */
function getOrderAppToken_() {
  var token = PropertiesService.getScriptProperties().getProperty(ORDER_APP_TOKEN_PROP);
  if (!token) {
    Logger.log('orderapp: ORDER_APP_COST_TOKEN not set — skipping');
    return null;
  }
  return token;
}

/** Pure. Appends each key=value onto execUrl, percent-encoding values. */
function orderAppBuildUrl_(execUrl, params) {
  var parts = [];
  for (var key in params) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    parts.push(key + '=' + encodeURIComponent(params[key]));
  }
  return execUrl + '?' + parts.join('&');
}

/**
 * Pure. (httpCode, bodyText) -> {ok:true, body} | {ok:false, reason}.
 * Never throws — an expired /exec deployment serves an HTML login page,
 * which must classify as reason:'parse', not blow up the caller.
 */
function orderAppClassifyResponse_(httpCode, bodyText) {
  if (httpCode !== 200) {
    return { ok: false, reason: 'http-' + httpCode };
  }

  var parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    return { ok: false, reason: 'parse' };
  }

  if (!parsed || parsed.ok !== true) {
    var errCode = (parsed && parsed.error) ? parsed.error : 'unknown';
    // Log the body verbatim (it may carry a traceId) — never the token, which
    // never appears in a response body in the first place.
    Logger.log('orderapp: API error — ' + bodyText);
    return { ok: false, reason: 'api:' + errCode };
  }

  return { ok: true, body: parsed };
}

/**
 * Thin fetch wrapper: no token -> zero fetches. A thrown fetch (network
 * failure) is caught, never left to propagate into a scheduled trigger.
 * @param {Object} params — query params, excluding token (added here).
 */
function orderAppFetch_(params) {
  var token = getOrderAppToken_();
  if (!token) {
    return { ok: false, reason: 'no-token' };
  }

  var allParams = {};
  for (var key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) allParams[key] = params[key];
  }
  allParams.token = token;
  var url = orderAppBuildUrl_(ORDER_APP_EXEC_URL, allParams);

  var response;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    return { ok: false, reason: 'http-exception' };
  }

  return orderAppClassifyResponse_(response.getResponseCode(), response.getContentText());
}

/**
 * Offset-paginates ?api=wholesaleSales across one week, re-gating EVERY page
 * with wholesaleValidWeekBody_ — the sheet is read live per request, so a
 * later page can go bad while the first was clean. Only page 0's summary and
 * meta ever leave this function: paging covers orders[] alone, and summary/
 * diagnostics are computed by the producer over its full unpaged scan, so a
 * later page's copy must never overwrite or be summed into page 0's.
 * @param {{label:string, start:string, end:string}} week — a
 *   lastCompletedWeeks_ entry.
 * @returns {{ok:true, orders:Array, summary:Object, meta:Object}|{ok:false, reason:string}}
 */
function wholesaleFetchWeekOrders_(week) {
  var offset = 0;
  var collected = [];
  var seen = {};
  var pages = 0;
  var matched = null;
  var summary = null;
  var meta = null;

  while (true) {
    var res = orderAppFetch_({
      api: 'wholesaleSales',
      week: week.label,
      limit: WHOLESALE_PAGE_LIMIT,
      offset: offset
    });
    if (!res.ok) {
      return { ok: false, reason: 'fetch: ' + res.reason };
    }

    var gate = wholesaleValidWeekBody_(res.body, week);
    if (!gate.ok) {
      return { ok: false, reason: 'page ' + pages + ': ' + gate.reason };
    }

    // Snapshot-shift guard: the producer recomputes matched over the LIVE
    // sheet on every request, so a row inserted/deleted between pages would
    // otherwise silently resize the target mid-scan.
    var pageMatched = Number(gate.paging.matched);
    if (pages === 0) {
      summary = res.body.summary;
      meta = res.body.meta;
      matched = pageMatched;
    } else if (pageMatched !== matched) {
      return { ok: false, reason: 'matched shifted mid-scan: ' + matched + ' -> ' + pageMatched };
    }

    // Offset paging is not snapshot-stable — dedup on orderId the same way
    // greenBeanFetchAllRows_ dedups on rowNumber.
    var pageOrders = res.body.orders;
    for (var i = 0; i < pageOrders.length; i++) {
      var order = pageOrders[i];
      if (seen[order.orderId]) continue;
      seen[order.orderId] = true;
      collected.push(order);
    }

    offset += pageOrders.length;
    if (pageOrders.length === 0 && collected.length < matched) {
      return {
        ok: false,
        reason: 'short page ' + pages + ': 0 orders returned with ' + collected.length + ' of ' + matched + ' collected'
      };
    }

    pages++;
    if (pages > WHOLESALE_MAX_PAGES) {
      return { ok: false, reason: 'exceeded ' + WHOLESALE_MAX_PAGES + ' pages — aborting (suspect non-advancing paging)' };
    }

    if (collected.length >= matched) break;
  }

  if (collected.length !== matched) {
    return { ok: false, reason: 'collected ' + collected.length + ' !== matched ' + matched };
  }

  return { ok: true, orders: collected, summary: summary, meta: meta };
}

/**
 * Explicit shopType -> {bucket, channel} map. wholesaleRevenueRows_ maps
 * ONLY through this table, never a default — a fallback in either direction
 * would misclassify real money (see roastery-wholesale step 3 Prohibitions).
 * Exported so step 4's cross-foot can index the producer's own summary
 * bucket from an emitted channel without re-deriving the mapping.
 */
var WHOLESALE_SHOPTYPE_MAP_ = {
  WHOLESALE: { bucket: 'external', channel: 'wholesale' },
  INTERNAL: { bucket: 'internal', channel: 'internal' },
  AMBIGUOUS: { bucket: 'ambiguous', channel: 'ambiguous' },
  UNKNOWN: { bucket: 'unknown', channel: 'unknown' }
};

var WHOLESALE_DROP_REASON_CAP_ = 20;
var WHOLESALE_DATE_RE_ = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure. Maps raw wholesaleSales orders onto Revenue-tab rows. This is the
 * ONLY validator on this GAS-native path — doPost's validateIngest_ is never
 * reached here, so every rejection it would normally do has to happen right
 * here instead. Never throws: a malformed order is dropped and counted, not
 * allowed to abort the whole week.
 *
 * amount is gated on typeof, not Number() coercion: Number(null) === 0 (a
 * finite "valid" amount) and Number('342.10') would silently accept a string
 * the producer never sends — see docs/schema.md and the mutation check in
 * this step's Verification Procedure.
 * @param {Array} orders — raw order objects from wholesaleFetchWeekOrders_.
 * @returns {{rows:Array, drops:Object, grossCentsByChannel:Object}}
 */
function wholesaleRevenueRows_(orders) {
  var rows = [];
  var drops = { unknownShopType: 0, badAmount: 0, badDate: 0, badOrderRef: 0, byReason: [] };
  var grossCentsByChannel = { wholesale: 0, internal: 0, ambiguous: 0, unknown: 0 };

  function drop(orderId, reason, counterKey) {
    drops[counterKey]++;
    if (drops.byReason.length < WHOLESALE_DROP_REASON_CAP_) {
      drops.byReason.push({ orderId: orderId, reason: reason });
    }
  }

  for (var i = 0; i < orders.length; i++) {
    var order = orders[i];

    var mapping = Object.prototype.hasOwnProperty.call(WHOLESALE_SHOPTYPE_MAP_, order.shopType)
      ? WHOLESALE_SHOPTYPE_MAP_[order.shopType]
      : null;
    if (!mapping) {
      drop(order.orderId, 'unrecognised shopType: ' + order.shopType, 'unknownShopType');
      continue;
    }

    var orderRef = String(order.orderId).trim();
    if (!orderRef) {
      drop(order.orderId, 'blank orderId', 'badOrderRef');
      continue;
    }

    var amount = order.amount;
    if (typeof amount !== 'number' || !isFinite(amount)) {
      drop(orderRef, 'bad amount: ' + amount, 'badAmount');
      continue;
    }

    var date = String(order.date).trim();
    if (!WHOLESALE_DATE_RE_.test(date)) {
      drop(orderRef, 'bad date: ' + date, 'badDate');
      continue;
    }

    var shopId = String(order.shopId).trim();
    var customer = shopId || '(blank shop id)';

    rows.push({
      date: date,
      department: 'Roastery',
      channel: mapping.channel,
      customer: customer,
      amount: amount,
      order_ref: orderRef
    });

    grossCentsByChannel[mapping.channel] += Math.round(amount * 100);
  }

  return { rows: rows, drops: drops, grossCentsByChannel: grossCentsByChannel };
}

/* ------------------------------------------------------------------ *
 * Failure accounting — fail-open (a crash/timeout must still count)
 * ------------------------------------------------------------------ */

/**
 * Call BEFORE lock acquisition so a lock-timeout skip still counts as a
 * non-completion. Increments the per-source failcount; at >=2 raises the
 * "previous run did not complete" alert.
 */
function orderAppRunStart_(source) {
  var props = PropertiesService.getScriptProperties();
  var key = ORDERAPP_FAILCOUNT_PREFIX + source;
  var current = Number(props.getProperty(key)) || 0;
  var next = current + 1;
  props.setProperty(key, String(next));

  if (next >= ORDERAPP_ALERT_THRESHOLD) {
    orderAppRaiseAlert_(source, next);
  }
}

/**
 * Call when a run SKIPS because the feed is not armed (ORDER_APP_COST_TOKEN
 * unset). Not-armed is not failure: resets the failcount WITHOUT stamping a
 * heartbeat, so triggers installed before the token is pasted can never build
 * up to a false "did not complete" alert.
 */
function orderAppRunSkipped_(source) {
  PropertiesService.getScriptProperties().setProperty(ORDERAPP_FAILCOUNT_PREFIX + source, '0');
  Logger.log('orderapp: ' + source + ' skipped (not armed) — failcount reset, no heartbeat');
}

/** Call ONLY on full success: resets the failcount and stamps the heartbeat. */
function orderAppRunSuccess_(source) {
  var props = PropertiesService.getScriptProperties();
  var key = ORDERAPP_FAILCOUNT_PREFIX + source;
  var previous = Number(props.getProperty(key)) || 0;
  props.setProperty(key, '0');
  stalenessStampHeartbeat_(source);

  if (previous >= ORDERAPP_ALERT_THRESHOLD) {
    Logger.log('orderapp: ' + source + ' recovered');
  }
}

/**
 * Purpose-built alert — do NOT reuse stalenessRaiseAlerts_'s body builder,
 * which renders age-hours fields that don't exist here and points at Windows
 * Task Scheduler / Playwright re-auth, the wrong remediation class for a GAS
 * time trigger. Reuses stalenessCalendar_'s acquisition mechanism only.
 * Never throws.
 */
function orderAppRaiseAlert_(source, count) {
  try {
    var cal = stalenessCalendar_();
    if (!cal) {
      Logger.log('orderAppRaiseAlert_: no calendar available for ' + source);
      return;
    }

    var title = 'LEIBLE expense orderapp: previous ' + source + ' run did not complete';
    var body = [
      'The previous orderapp run for "' + source + '" did not complete.',
      'This run is retrying automatically.',
      '',
      'Where to look:',
      '  - the GAS time trigger for the orderapp pulls',
      '  - the ORDER_APP_COST_TOKEN Script Property (missing or expired?)',
      '  - the Order app /exec URL (' + ORDER_APP_EXEC_URL + ') — the deployment may have changed'
    ].join('\n');

    var ev = cal.createAllDayEvent(title, new Date());
    ev.setColor(CalendarApp.EventColor.ORANGE);
    ev.setDescription(body);
  } catch (err) {
    Logger.log('orderAppRaiseAlert_: failed to raise alert for ' + source + ' — ' + err.message);
  }
}

/**
 * Data-quality alert — the PRD-8 precedent says money-affecting warnings must
 * reach Jake, not just the execution log nobody reads on a schedule. Raised
 * for RARE, ACTIONABLE states (flagged $0-coerced intake rows, upstream
 * dropped-row warnings) — NOT for routine ones like weekly excluded gross,
 * which stays log+result. Never throws.
 */
/**
 * Signature-gated: `signature` is a short string describing the CONDITION
 * (e.g. 'flagged:2'). The alert fires only when the signature differs from
 * the last one alerted — a rolling 3-month window means one un-fixed cell
 * would otherwise re-alert every weekly run for ~13 weeks straight, which is
 * how an alert gets tuned out. A clean run must call
 * orderAppClearDataQualitySignature_ so the NEXT occurrence re-alerts.
 */
function orderAppRaiseDataQualityAlert_(source, message, signature) {
  try {
    var props = PropertiesService.getScriptProperties();
    var sigKey = 'ORDERAPP_DQ_SIG_' + source;
    if (signature && props.getProperty(sigKey) === signature) {
      Logger.log('orderAppRaiseDataQualityAlert_: ' + source + ' condition unchanged (' + signature + ') — alert suppressed');
      return;
    }
    var cal = stalenessCalendar_();
    if (!cal) {
      Logger.log('orderAppRaiseDataQualityAlert_: no calendar available for ' + source);
      return;
    }
    var ev = cal.createAllDayEvent('LEIBLE expense orderapp data quality: ' + source, new Date());
    ev.setColor(CalendarApp.EventColor.ORANGE);
    ev.setDescription(message + '\n\nFix the underlying cells in the Order app (06_Stock_Intake); ' +
      'the next scheduled pull re-ingests corrected figures automatically.');
    if (signature) props.setProperty(sigKey, signature);
  } catch (err) {
    Logger.log('orderAppRaiseDataQualityAlert_: failed for ' + source + ' — ' + err.message);
  }
}

/**
 * Tiny content hash for suppression signatures. Counting is NOT enough: the
 * producer embeds row counts inside warning STRINGS (e.g. "3 row(s) were
 * excluded..."), so a condition escalating 3 -> 40 dropped rows changes the
 * text but not the array length — a count-based signature would stay silent.
 */
function orderAppSignatureHash_(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Call on a clean run: the condition is gone, so its next occurrence re-alerts. */
function orderAppClearDataQualitySignature_(source) {
  try {
    PropertiesService.getScriptProperties().deleteProperty('ORDERAPP_DQ_SIG_' + source);
  } catch (err) {
    Logger.log('orderAppClearDataQualitySignature_: failed for ' + source + ' — ' + err.message);
  }
}

/* ------------------------------------------------------------------ *
 * ISO week labels (pure, unit-tested)
 * ------------------------------------------------------------------ */

/**
 * ISO-8601 week label ('YYYY-Www') for a 'yyyy-MM-dd' string, via the ISO
 * Thursday rule (the week's Thursday determines the ISO year). Built from
 * local date components only — no toISOString/UTC getters, so it can't pick
 * up the AEST off-by-one that a UTC round-trip would introduce.
 */
function isoWeekLabel_(dateStr) {
  var parts = dateStr.split('-');
  var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));

  // ISO day-of-week: Mon=1..Sun=7 (native getDay() is Sun=0..Sat=6).
  var isoDay = date.getDay() === 0 ? 7 : date.getDay();
  date.setDate(date.getDate() + (4 - isoDay)); // jump to this week's Thursday

  var isoYear = date.getFullYear();
  var jan1 = new Date(isoYear, 0, 1);
  var dayOfYear = Math.round((date.getTime() - jan1.getTime()) / 86400000);
  var week = Math.floor(dayOfYear / 7) + 1;

  return isoYear + '-W' + (week < 10 ? '0' + week : week);
}

/**
 * The `n` most recent completed ISO weeks (Mon-start, end < todayStr),
 * oldest-first. Composed from getLastCompletedWeek_/addDaysStr_ (Code.gs) —
 * they own the week-math single source of truth — plus isoWeekLabel_ above.
 */
function lastCompletedWeeks_(todayStr, n) {
  var newest = getLastCompletedWeek_(todayStr);
  var weeks = [];
  for (var i = n - 1; i >= 0; i--) {
    var start = addDaysStr_(newest.start, -7 * i);
    var end = addDaysStr_(start, 6);
    weeks.push({ label: isoWeekLabel_(start), start: start, end: end });
  }
  return weeks;
}

/* ------------------------------------------------------------------ *
 * Shopify online revenue — weekly pull from the Order-app read API
 * ------------------------------------------------------------------ */

/**
 * Entry point: orderAppRunStart_ runs BEFORE the lock so a lock-timeout skip
 * still counts as a non-completion (same convention as every other fail-open
 * accounting call in this file). Lock-wrapped because this is scan-then-write
 * against Summary (upsertRows_ reads the whole sheet before writing).
 * @returns {Object} shopifyWeeklyPull_impl_'s result, or {locked:true}.
 */
function shopifyWeeklyPull() {
  orderAppRunStart_(SHOPIFY_ORDERAPP_SOURCE);
  var res = withScriptLock_(function () { return shopifyWeeklyPull_impl_(); });
  if (res === LOCK_TIMEOUT_) {
    Logger.log('shopifyWeeklyPull: could not acquire script lock — skipped this run');
    return { locked: true };
  }
  return res;
}

/**
 * Pulls the last SHOPIFY_REPULL_WEEKS completed ISO weeks of Shopify online
 * revenue (?api=shopifySales) and upserts them into Summary as kind:'revenue'
 * rows. Past weeks are re-pulled every run because the Order app serves a
 * LIVE snapshot (meta.snapshot) — a changed gross updates the existing row
 * in place via upsertRows_, rather than appending a duplicate.
 * @returns {{weeksRequested:number, weeksFetched:number, rowsAdded:number,
 *   rowsUpdated:number, duplicatesSkipped:number, apiFailed?:boolean, noToken?:boolean}}
 */
/**
 * Pure shape gate for one shopifySales week body. Returns {ok:true, weekStart,
 * grossSales} only when the body carries a finite numeric summary.grossSales
 * AND meta.weekStart echoes the requested week's Monday — anything else is
 * {ok:false, reason} and the week is treated as a failed fetch.
 */
function shopifyValidWeekBody_(body, requestedWeek) {
  if (!body || typeof body !== 'object' || !body.meta || typeof body.meta.weekStart !== 'string') {
    return { ok: false, reason: 'missing meta.weekStart' };
  }
  if (!body.summary || typeof body.summary !== 'object') {
    return { ok: false, reason: 'missing summary' };
  }
  var gross = Number(body.summary.grossSales);
  if (typeof body.summary.grossSales === 'undefined' || body.summary.grossSales === null || !isFinite(gross)) {
    return { ok: false, reason: 'grossSales is not a finite number: ' + body.summary.grossSales };
  }
  var weekStart = body.meta.weekStart.slice(0, 10);
  if (weekStart !== requestedWeek.start) {
    return { ok: false, reason: 'weekStart ' + weekStart + ' does not echo requested ' + requestedWeek.start };
  }
  return { ok: true, weekStart: weekStart, grossSales: gross };
}

function shopifyWeeklyPull_impl_() {
  var token = getOrderAppToken_();
  if (!token) {
    orderAppRunSkipped_(SHOPIFY_ORDERAPP_SOURCE);
    return { noToken: true };
  }

  var weeks = lastCompletedWeeks_(todayStr_(), SHOPIFY_REPULL_WEEKS);
  var pulledAt = Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX");

  var normalizedRows = [];
  var weeksFetched = 0;
  var apiFailed = false;
  var excludedGross = 0;

  for (var i = 0; i < weeks.length; i++) {
    var res = orderAppFetch_({ api: 'shopifySales', week: weeks[i].label });
    if (!res.ok) {
      apiFailed = true;
      continue;
    }

    // Shape-validate before touching money: an {ok:true} body with a missing
    // summary would throw out of a scheduled trigger; a non-numeric grossSales
    // would write NaN into Summary (and NaN !== NaN makes upsertRows_ rewrite
    // it forever); a weekStart that doesn't echo the requested week means the
    // API ignored/clamped the week param and one week would be written 4x.
    var shape = shopifyValidWeekBody_(res.body, weeks[i]);
    if (!shape.ok) {
      apiFailed = true;
      Logger.log('shopifyWeeklyPull: ' + weeks[i].label + ' response failed shape validation (' +
        shape.reason + ') — week skipped, run marked failed');
      continue;
    }
    weeksFetched++;

    var body = res.body;
    var weekStart = shape.weekStart;
    var weekEnd = addDaysStr_(weekStart, 6);
    normalizedRows.push([
      weekStart, weekEnd, SHOPIFY_ORDERAPP_SOURCE, 'online',
      shape.grossSales, pulledAt, 'Roastery', 'revenue'
    ]);

    // The metric is gross of PAID/PARTIALLY_PAID orders; a refund of any size
    // removes the WHOLE order from the week (Order-app contract — deliberate).
    // The excluded buckets exist precisely so that shrink can be reconciled;
    // surface them instead of discarding them.
    // Shape verified against the producer: byStatusTotals and cancelled are
    // scalar-holding objects ({orderCount, gross} / {count, gross}) — the
    // per-status MAP is the separate excluded.byStatus key, deliberately not
    // read here (Order app Engine_ShopifySales.js:474).
    var excluded = body.excluded || {};
    var weekExcluded = 0;
    if (excluded.byStatusTotals) weekExcluded += Number(excluded.byStatusTotals.gross) || 0;
    if (excluded.cancelled) weekExcluded += Number(excluded.cancelled.gross) || 0;
    if (weekExcluded > 0) {
      excludedGross += weekExcluded;
      Logger.log('shopifyWeeklyPull: ' + weeks[i].label + ' holds out $' + weekExcluded.toFixed(2) +
        ' gross in excluded orders (PENDING/cancelled; a refunded order drops its FULL amount) — ' +
        'reconcile via the Order-app excluded buckets if the weekly figure looks low');
    }
  }

  var ss = getHubSpreadsheet_();
  var summSheet = ensureSheet(ss, SUMMARY_TAB, SUMMARY_HEADERS);
  var upsertResult = upsertRows_(summSheet, normalizedRows, SUMMARY_KEY_COLS, SUMMARY_TOTAL_COL, SUMMARY_STAMP_COL);

  var result = {
    weeksRequested: weeks.length,
    weeksFetched: weeksFetched,
    rowsAdded: upsertResult.rowsAdded,
    rowsUpdated: upsertResult.rowsUpdated,
    duplicatesSkipped: upsertResult.duplicatesSkipped,
    excludedGross: Math.round(excludedGross * 100) / 100
  };

  if (apiFailed) {
    result.apiFailed = true;
  } else {
    orderAppRunSuccess_(SHOPIFY_ORDERAPP_SOURCE);
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * Green Bean invoices — normalize & group supplier invoice lines
 * ------------------------------------------------------------------ */

/**
 * Pure. Groups raw invoice lines by (supplierKey, invoiceNum) or
 * (supplierKey, date) if invoiceNum is blank/undefined. Sums totals,
 * uses earliest dateLocal, formats for Suppliers tab.
 * @param {Array} lines — objects with dateLocal, supplierRaw, supplierKey,
 *   invoiceNum, totalCostIncGst, status, (optional flags).
 * @returns {Array} normalized rows [{date, supplier, total, invoice_ref, department}],
 *   sorted by invoice_ref.
 */
function greenBeanInvoices_(lines) {
  if (!lines || lines.length === 0) {
    return [];
  }

  var groups = {};
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var invoiceNum = String(line.invoiceNum || '').trim();
    // Group case-INSENSITIVELY: the producer trims but does not lowercase
    // invoiceNum, so one hand-typed invoice can arrive as 'INV-700' + 'inv-700'.
    // Case-sensitive grouping would emit TWO rows whose refs collapse to ONE
    // dedup key at the sheet (rowKey_ lowercases) — the second row is dropped
    // as an in-batch duplicate and its money silently vanishes. The emitted
    // ref keeps the group's first-seen casing (display only; every key
    // comparison downstream is lowercased).
    var displayRef;
    var groupKey;
    if (invoiceNum) {
      displayRef = line.supplierKey + '/' + invoiceNum;
    } else {
      displayRef = line.supplierKey + '/noinv-' + line.dateLocal;
    }
    groupKey = displayRef.toLowerCase();

    if (!groups[groupKey]) {
      groups[groupKey] = {
        supplierRaw: line.supplierRaw,
        supplierKey: line.supplierKey,
        invoiceNum: invoiceNum,
        dateLocal: line.dateLocal,
        total: 0,
        displayRef: displayRef
      };
    }

    // Coerce like every other money read in the hub: a string-typed cell would
    // otherwise turn the accumulator into string concatenation (0+'50'->'050'),
    // a silently 100x-overstated invoice. undefined/non-numeric counts as 0 —
    // the API's flags[] mechanism marks those lines and the pull alerts on them.
    groups[groupKey].total += Number(line.totalCostIncGst) || 0;
    if (line.dateLocal < groups[groupKey].dateLocal) {
      groups[groupKey].dateLocal = line.dateLocal;
    }
  }

  var result = [];
  for (var key in groups) {
    if (!Object.prototype.hasOwnProperty.call(groups, key)) continue;
    var group = groups[key];
    result.push({
      date: group.dateLocal,
      // Explicit fallback for BLANK_SUPPLIER rows: a blank supplierRaw would
      // fall through canonicalSupplier_ to the source token 'greenbean' in
      // one column while the ref reads 'unknown/<num>' in another — two
      // placeholder spellings for the same row. One self-describing name
      // keeps the weekly report readable; the flags alert carries the fix.
      supplier: group.supplierRaw || 'Green Bean (unnamed supplier)',
      total: Math.round(group.total * 100) / 100,
      invoice_ref: group.displayRef,
      department: 'Roastery'
    });
  }

  result.sort(function (a, b) {
    return a.invoice_ref < b.invoice_ref ? -1 : (a.invoice_ref > b.invoice_ref ? 1 : 0);
  });

  return result;
}

/* ------------------------------------------------------------------ *
 * Green Bean committed spend — fetch, ingest, snapshot-diff resummarize
 * ------------------------------------------------------------------ */

var GREENBEAN_RESUM_CAP = 5;
var GREENBEAN_MAX_PAGES = 20; // 20 x 5000-row pages >> any real window; a loop that needs more is a paging bug
// Single source of truth for the source string — it is simultaneously the
// failcount/heartbeat key, the Suppliers row filter, the ingest source and the
// alert label; a typo in ONE occurrence would silently split those keys while
// every run still looked healthy (same rationale as SHOPIFY_ORDERAPP_SOURCE).
var GREENBEAN_SOURCE = 'greenbean';
// File-scope, execution-lifetime: greenBeanFetchAllRows_ collects upstream
// warnings here (its rows|null return contract can't carry them); the impl
// reads it after the fetch to decide the signature-gated data-quality alert.
var GREENBEAN_UPSTREAM_WARNINGS_ = [];
var GREENBEAN_RESUM_QUEUE_PROP = 'ORDERAPP_RESUM_QUEUE_greenbean'; // JSON array of 'yyyy-MM-dd' week starts

/**
 * Pure. {from, to} for the greenBeanCost window: from = 1st of (month−2)
 * relative to todayStr, to = todayStr. String arithmetic only — no Date
 * object, so there is nothing here for a UTC/local offset to corrupt.
 */
function greenBeanWindow_(todayStr) {
  var parts = todayStr.split('-');
  var year = Number(parts[0]);
  var month = Number(parts[1]); // 1-based

  var fromMonth = month - 2;
  var fromYear = year;
  if (fromMonth <= 0) {
    fromMonth += 12;
    fromYear -= 1;
  }
  var fromMonthStr = fromMonth < 10 ? '0' + fromMonth : String(fromMonth);

  return { from: fromYear + '-' + fromMonthStr + '-01', to: todayStr };
}

/**
 * Offset-paginates ?api=greenBeanCost across the full greenBeanWindow_.
 * A response that reports truncated:true with rowsIncluded:false means the
 * Order app's own size guard dropped the rows array for that page — the
 * window can only ever be ingested whole, so this aborts rather than
 * silently ingest a partial slice.
 * @returns {Array|null} concatenated raw rows, or null on abort/fetch failure.
 */
function greenBeanFetchAllRows_() {
  var window = greenBeanWindow_(todayStr_());
  GREENBEAN_UPSTREAM_WARNINGS_.length = 0; // fresh per pull; the impl reads it after the fetch
  var rows = [];
  var offset = 0;
  var seenRowNumbers = {};
  var duplicatesSkipped = 0;
  var pages = 0;
  var lastPaging = null;

  while (true) {
    // Bounded loop — the deleted shopify.gs carried SHOPIFY_MAX_PAGES for the
    // same reason: an API bug that reports truncated without advancing would
    // otherwise re-issue the identical fetch until the 6-minute limit,
    // burning fetch quota every Tuesday with zero ingest.
    pages++;
    if (pages > GREENBEAN_MAX_PAGES) {
      Logger.log('greenBeanFetchAllRows_: exceeded ' + GREENBEAN_MAX_PAGES + ' pages — aborting (suspect non-advancing paging)');
      return null;
    }
    var res = orderAppFetch_({
      api: 'greenBeanCost',
      from: window.from,
      to: window.to,
      status: 'ALL',
      include: 'rows',
      limit: 5000,
      offset: offset
    });
    if (!res.ok) {
      Logger.log('greenBeanFetchAllRows_: fetch failed (' + res.reason + ') — aborting incomplete window');
      return null;
    }

    // Shape gate, same contract as shopifyValidWeekBody_: an {ok:true} body
    // missing meta.paging must abort cleanly, not throw a TypeError out of
    // the Tuesday trigger.
    if (!res.body || !res.body.meta || !res.body.meta.paging || typeof res.body.meta.paging !== 'object') {
      Logger.log('greenBeanFetchAllRows_: response missing meta.paging — aborting (shape validation)');
      return null;
    }
    var paging = res.body.meta.paging;
    lastPaging = paging;
    // Anything truncated where rowsIncluded is not EXACTLY true aborts: ===false
    // is the documented size guard, but an absent/non-boolean value would
    // otherwise fall through BOTH branches, break the loop, and silently ingest
    // a partial window as if it were complete.
    // Surface upstream data-quality signals verbatim BEFORE any abort path —
    // an abort discards the rows but the warnings often EXPLAIN it, and the
    // impl's abort handler reads what was collected here. The API coerces a
    // non-numeric price/kg cell to 0 and drops invalid-Timestamp rows,
    // reporting both ONLY here.
    // The producer recomputes diagnostics.warnings over the WHOLE matched set
    // on every page, so a multi-page pull would collect N identical copies —
    // dedupe here so the alert body lists each warning once and the
    // suppression signature stays stable across page counts.
    var diagnostics = res.body.diagnostics || {};
    var warnings = diagnostics.warnings || res.body.warnings || [];
    for (var w = 0; w < warnings.length; w++) {
      var warnText = String(warnings[w]);
      if (GREENBEAN_UPSTREAM_WARNINGS_.indexOf(warnText) === -1) {
        Logger.log('greenBeanFetchAllRows_: UPSTREAM WARNING — ' + warnText);
        GREENBEAN_UPSTREAM_WARNINGS_.push(warnText);
      }
    }

    if (paging.truncated === true && paging.rowsIncluded !== true) {
      Logger.log('greenBeanFetchAllRows_: truncated response without rows (size guard or ambiguous rowsIncluded=' +
        paging.rowsIncluded + ') — aborting rather than ingest an incomplete window');
      return null;
    }

    // Offset paging is not snapshot-stable: the Order app re-slices the live
    // sheet per request, so a row inserted between pages can shift the window
    // and resend a line. rowNumber is stable per row — dedup on it.
    var pageRows = res.body.rows || [];
    for (var p = 0; p < pageRows.length; p++) {
      var rn = pageRows[p].rowNumber;
      if (rn !== undefined && rn !== null) {
        if (seenRowNumbers[rn]) { duplicatesSkipped++; continue; }
        seenRowNumbers[rn] = true;
      }
      rows.push(pageRows[p]);
    }

    if (paging.truncated === true && paging.rowsIncluded === true) {
      var returned = Number(paging.returned);
      if (!isFinite(returned) || returned <= 0) {
        Logger.log('greenBeanFetchAllRows_: paging.returned is ' + paging.returned +
          ' on a truncated page — offset cannot advance, aborting');
        return null;
      }
      offset += returned;
      continue;
    }
    break;
  }

  if (duplicatesSkipped > 0) {
    Logger.log('greenBeanFetchAllRows_: skipped ' + duplicatesSkipped +
      ' duplicate row(s) across pages (live-sheet offset shift) — totals kept exact');
  }

  // The inverse shift: a row DELETED mid-pagination slides the offset window
  // forward and one row is never returned on any page — the window would
  // ingest short with no signal. The final page's paging.matched counts the
  // whole matched set, so a shortfall is detectable: abort, next run re-pulls
  // a consistent snapshot.
  var finalMatched = Number(lastPaging && lastPaging.matched);
  if (isFinite(finalMatched) && finalMatched > 0 && rows.length < finalMatched) {
    Logger.log('greenBeanFetchAllRows_: collected ' + rows.length + ' rows but paging.matched=' +
      finalMatched + ' (row deleted mid-pagination?) — aborting rather than ingest a short window');
    return null;
  }
  return rows;
}

function greenBeanReadQueue_() {
  var raw = PropertiesService.getScriptProperties().getProperty(GREENBEAN_RESUM_QUEUE_PROP);
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function greenBeanWriteQueue_(weekStarts) {
  PropertiesService.getScriptProperties().setProperty(GREENBEAN_RESUM_QUEUE_PROP, JSON.stringify(weekStarts));
}

/**
 * Entry point: orderAppRunStart_ runs BEFORE the lock so a lock-timeout skip
 * still counts as a non-completion (same convention as shopifyWeeklyPull).
 * @returns {Object} greenBeanPull_impl_'s result, or {locked:true}.
 */
function greenBeanPull() {
  orderAppRunStart_(GREENBEAN_SOURCE);
  var res = withScriptLock_(function () { return greenBeanPull_impl_(); });
  if (res === LOCK_TIMEOUT_) {
    Logger.log('greenBeanPull: could not acquire script lock — skipped this run');
    return { locked: true };
  }
  return res;
}

/**
 * Fetches the full greenBeanCost window, ingests it into Suppliers, and
 * snapshot-diffs the submitted invoices against the PRE-ingest state of the
 * sheet to decide which completed weeks need re-summarizing. A changed
 * invoice's affected week is the STORED date's week (upsertRows_ never
 * rewrites the date column, so the row still lives there) — never the
 * recomputed date from this run's (possibly earlier) grouped lines.
 * @returns {{rowsFetched:number, invoices:Array, rowsAdded:number,
 *   rowsUpdated:number, duplicatesSkipped:number, weeksResummarized:number,
 *   weeksQueued:number, noToken?:boolean, apiFailed?:boolean}}
 */
function greenBeanPull_impl_() {
  var token = getOrderAppToken_();
  if (!token) {
    orderAppRunSkipped_(GREENBEAN_SOURCE);
    return { noToken: true };
  }

  var rows = greenBeanFetchAllRows_();
  if (rows === null) {
    // Surface any upstream warnings collected before the abort — they often
    // EXPLAIN the failure, and the abort path is exactly where losing them
    // to the execution log would hurt most.
    if (GREENBEAN_UPSTREAM_WARNINGS_.length > 0) {
      Logger.log('greenBeanPull: run aborted with ' + GREENBEAN_UPSTREAM_WARNINGS_.length +
        ' upstream warning(s) already collected: ' + GREENBEAN_UPSTREAM_WARNINGS_.join(' | '));
      orderAppRaiseDataQualityAlert_(GREENBEAN_SOURCE + '_upstream',
        'greenBeanPull ABORTED mid-fetch; upstream warnings collected before the abort ' +
        '(these may explain it):\n- ' + GREENBEAN_UPSTREAM_WARNINGS_.join('\n- '),
        // 'abort:' prefix, not 'warnings:': the two conditions share a
        // signature key, and the milder success-with-warnings sig must never
        // suppress the more severe aborted-run alert for the same text.
        'abort:' + orderAppSignatureHash_(GREENBEAN_UPSTREAM_WARNINGS_.slice().sort().join('|')));
    }
    return { apiFailed: true };
  }

  // Upstream warnings persist across pulls (the same broken row sits in the
  // rolling window for ~13 weekly runs), so the alert is signature-gated:
  // it fires when the condition appears or CHANGES, stays silent while it is
  // unchanged, and re-arms once a clean pull clears it.
  var upstreamWarnings = GREENBEAN_UPSTREAM_WARNINGS_.slice();
  if (upstreamWarnings.length > 0) {
    orderAppRaiseDataQualityAlert_(GREENBEAN_SOURCE + '_upstream',
      'The greenBeanCost API reported ' + upstreamWarnings.length + ' data-quality warning(s) this pull ' +
      '(e.g. rows hidden by an invalid Timestamp) — the ingested spend may be incomplete:\n- ' +
      upstreamWarnings.join('\n- '),
      // Content-hashed, not counted: the row count lives INSIDE the warning
      // text, so "3 rows excluded" -> "40 rows excluded" must re-alert.
      'warnings:' + orderAppSignatureHash_(upstreamWarnings.slice().sort().join('|')));
  } else {
    orderAppClearDataQualitySignature_(GREENBEAN_SOURCE + '_upstream');
  }

  // Per-row flags mark data problems the API worked around (NON_NUMERIC_*
  // coerced to $0, BLANK_SUPPLIER, …; invalid-Timestamp rows never reach
  // rows[] on a from/to query — they surface via diagnostics.warnings above).
  // The lines still ingest (locked decision: never dropped), but the count
  // must be loud — and the alert names the DISTINCT flags present, because
  // "fix the price cell" is wrong advice for a blank-supplier row.
  var flaggedRows = 0;
  var flagNamesSeen = {};
  for (var f = 0; f < rows.length; f++) {
    if (rows[f].flags && rows[f].flags.length) {
      flaggedRows++;
      for (var fn = 0; fn < rows[f].flags.length; fn++) flagNamesSeen[String(rows[f].flags[fn])] = true;
    }
  }
  var flagNames = Object.keys(flagNamesSeen).sort();
  if (flaggedRows > 0) {
    Logger.log('greenBeanPull: ' + flaggedRows + ' flagged intake row(s) [' + flagNames.join(', ') + '] — ' +
      'greenbean figures may be off; fix the 06_Stock_Intake cells in the Order app');
    orderAppRaiseDataQualityAlert_(GREENBEAN_SOURCE + '_flags',
      flaggedRows + ' stock-intake row(s) carry data-quality flags: ' + flagNames.join(', ') + '. ' +
      'NON_NUMERIC_* flags mean a value was read as $0 (committed spend likely UNDERSTATED); ' +
      'other flags mean the row needs its named field fixed.',
      'flagged:' + flaggedRows + ':' + flagNames.join(','));
  } else {
    orderAppClearDataQualitySignature_(GREENBEAN_SOURCE + '_flags');
  }

  var invoices = greenBeanInvoices_(rows);
  var extractedAt = Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX");

  var ss = getHubSpreadsheet_();
  var suppSheet = ensureSheet(ss, SUPPLIERS_TAB, SUPPLIERS_HEADERS);

  // Snapshot BEFORE ingest — only source='greenbean' rows — so an updated
  // invoice's affected week can be derived from where it CURRENTLY lives.
  // Keys are LOWERCASED to match upsertRows_'s case-insensitive rowKey_: a
  // retyped 'inv-700' -> 'INV-700' updates the existing sheet row, so the
  // snapshot lookup must hit the same row or the diff misclassifies it as new
  // and resummarizes the wrong week.
  var snapshot = {};
  var existingValues = suppSheet.getDataRange().getValues();
  for (var r = 1; r < existingValues.length; r++) {
    var existingRow = existingValues[r];
    if (String(existingRow[5]) !== GREENBEAN_SOURCE) continue;
    snapshot[GREENBEAN_SOURCE + '||' + sheetKeyPart_(existingRow[3])] = {
      storedDate: coerceDateStr_(existingRow[0]),
      total: Number(existingRow[2]),
      rowIndex: r + 1 // 1-based sheet row, for the date-move self-heal below
    };
  }

  var ingestResult = ingestSupplierRows(GREENBEAN_SOURCE, invoices, extractedAt, suppSheet);

  var currentWeekStart = weekStartForDate_(todayStr_());
  var affectedSet = {};
  var affected = [];
  function addAffectedWeek(weekStart) {
    if (weekStart >= currentWeekStart) return; // never resummarize/queue the current, incomplete week
    if (affectedSet[weekStart]) return;
    affectedSet[weekStart] = true;
    affected.push(weekStart);
  }

  // This pull's full ref set, normalized exactly like the snapshot keys —
  // consulted by both the update-classification loop below and the orphan
  // sweep after it.
  var pullRefs = {};
  for (var pk = 0; pk < invoices.length; pk++) {
    pullRefs[sheetKeyPart_(invoices[pk].invoice_ref)] = true;
  }
  // Bare invoice-number part of every ref NEW to this pull. Purely a display
  // hint so an orphan alert can say where the money probably went after a
  // supplier rename — it plays NO part in deciding what is an orphan.
  var newRefsByBare = {};

  for (var i = 0; i < invoices.length; i++) {
    var invoice = invoices[i];
    var snap = snapshot[GREENBEAN_SOURCE + '||' + sheetKeyPart_(invoice.invoice_ref)];
    if (!snap) {
      addAffectedWeek(weekStartForDate_(invoice.date));
      var newParts = sheetKeyPart_(invoice.invoice_ref).split('/');
      var newBare = newParts.slice(1).join('/');
      if (newBare) newRefsByBare[newBare] = invoice.invoice_ref;
      continue;
    }
    // Date-move self-heal: upsertRows_ never rewrites the date column, so an
    // upstream date correction (same ref, same total) would otherwise leave
    // the money attributed to the wrong ISO week FOREVER — the true week
    // understated, the stale week overstated, and nothing to distinguish
    // either from correct data. Fix the cell here and resummarize BOTH weeks.
    var dateMoved = invoice.date !== snap.storedDate;
    if (dateMoved) {
      suppSheet.getRange(snap.rowIndex, 1).setValue(invoice.date);
      // Value+stamp convention (upsertRows_, appendSalesRow_): every in-place
      // correction refreshes extracted_at too, so the row answers "when was
      // this last touched?" truthfully.
      suppSheet.getRange(snap.rowIndex, 7).setValue(extractedAt);
      addAffectedWeek(weekStartForDate_(snap.storedDate)); // old week loses the invoice
      addAffectedWeek(weekStartForDate_(invoice.date));    // new week gains it
      Logger.log('greenBeanPull: ' + invoice.invoice_ref + ' date moved ' + snap.storedDate +
        ' -> ' + invoice.date + ' upstream — Suppliers row updated, both weeks resummarized');
    }

    var newTotal = Math.round(Number(invoice.total) * 100) / 100;
    var oldTotal = Math.round(Number(snap.total) * 100) / 100;
    if (newTotal !== oldTotal) {
      addAffectedWeek(weekStartForDate_(dateMoved ? invoice.date : snap.storedDate));
    }
  }

  // Orphan detection: the pull re-fetches the ENTIRE window every run, so a
  // snapshot row whose storedDate lies inside this pull's window but whose
  // ref was NOT re-submitted has lost its upstream counterpart — the invoice
  // was renamed (supplier edit), re-keyed (invoiceNum edit), re-dated (a date
  // edit on a blank-invoice line mints a brand-new noinv-<date> ref, so the
  // ref-equality self-heal above can never fire for it), or deleted from
  // 06_Stock_Intake. In every case the sheet row is stale money: left alone
  // it double-counts against its freshly-appended replacement, or over-counts
  // a deletion, and nothing else can notice. Detected, not auto-fixed (same
  // decision as the rename detector this generalizes): any replacement row is
  // current truth; the alert points at the stale old row and the schema.md
  // runbook (zero it, resummarize its week).
  //
  // Candidates are BOUNDED to the pull window: the tab retains ~6 months
  // (ARCHIVE_RETENTION_DAYS=183) but the pull spans ~3, so an OLDER row's
  // absence from the pull is expected — flagging it would send the runbook
  // after real historical spend. In-window rows can't be that artifact: if
  // the date is in the window, the pull re-fetched it by definition.
  var pullWindow = greenBeanWindow_(todayStr_());
  var orphans = [];
  for (var oKey in snapshot) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, oKey)) continue;
    var oEntry = snapshot[oKey];
    if (oEntry.storedDate < pullWindow.from || oEntry.storedDate > pullWindow.to) continue;
    var oRef = oKey.substring((GREENBEAN_SOURCE + '||').length);
    if (pullRefs[oRef]) continue;
    // A zeroed row is the runbook's own end state (money already
    // neutralized), so skipping it lets remediation clear this alert instead
    // of re-flagging the same row forever. A NaN total carries no summable
    // money either.
    if (!(Math.round(Number(oEntry.total) * 100))) continue;
    var oBare = oRef.split('/').slice(1).join('/');
    var hint = (oBare && newRefsByBare[oBare])
      ? ' — possibly renamed to ' + newRefsByBare[oBare]
      : '';
    orphans.push(oRef + ' (stored date ' + oEntry.storedDate + ', $' + oEntry.total + hint + ')');
  }
  orphans.sort();
  if (orphans.length > 0) {
    Logger.log('greenBeanPull: ' + orphans.length + ' orphaned Suppliers row(s) — in-window rows this pull ' +
      'did not re-submit: ' + orphans.join('; '));
    orderAppRaiseDataQualityAlert_(GREENBEAN_SOURCE + '_orphan',
      'Orphaned greenbean Suppliers row(s): the stored date is inside the pull window but the invoice was ' +
      'NOT in this pull — it was renamed, re-dated (blank-invoice lines re-key as noinv-<date>), or deleted ' +
      'in 06_Stock_Intake. The stale row DOUBLE-COUNTS against its replacement (or over-counts a deletion) ' +
      'until fixed:\n- ' + orphans.join('\n- ') +
      '\n\nRunbook (docs/schema.md): zero the OLD Suppliers row, then run weeklySummarize(\'<week>\').',
      'orphan:' + orderAppSignatureHash_(orphans.join('|')));
  } else {
    orderAppClearDataQualitySignature_(GREENBEAN_SOURCE + '_orphan');
  }

  // Merge queue-from-property (drain oldest-first) with this run's affected
  // weeks, dedup, oldest-first — a plain string sort works since the labels
  // are 'yyyy-MM-dd'.
  var merged = greenBeanReadQueue_().concat(affected);
  var mergedSet = {};
  var mergedUnique = [];
  for (var m = 0; m < merged.length; m++) {
    if (mergedSet[merged[m]]) continue;
    mergedSet[merged[m]] = true;
    mergedUnique.push(merged[m]);
  }
  mergedUnique.sort();

  var toSummarize = mergedUnique.slice(0, GREENBEAN_RESUM_CAP);

  // Crash safety: Suppliers already holds the new totals, so the snapshot
  // diff above can never be re-derived. Persist the FULL affected list BEFORE
  // the resummarize loop — if the run dies mid-loop (throw, 6-min limit), the
  // next run drains every week from the property; an already-summarized week
  // re-runs idempotently. Only after the loop finishes does the property
  // shrink to the true remainder.
  greenBeanWriteQueue_(mergedUnique);
  var summarizedOk = {};
  for (var s = 0; s < toSummarize.length; s++) {
    // The queue is the SOLE record of pending weeks, so only a call that
    // actually completed may remove its week — a {refused:...} or empty
    // return stays queued and is logged, never silently dropped.
    var sumRes = weeklySummarize(toSummarize[s]);
    // POSITIVE completion test, never `!sumRes.refused`. A negative test
    // passes for ANY return shape that merely lacks the key — including the
    // multi-week heal shape, whose weekStart is not even the week we asked
    // for. Require both: no refusal, AND the run reports back the requested
    // week. Anything else stays queued and is logged.
    var reported = sumRes && sumRes.weekStart ? coerceDateStr_(sumRes.weekStart) : null;
    if (sumRes && !sumRes.refused && reported === toSummarize[s]) {
      summarizedOk[toSummarize[s]] = true;
    } else {
      Logger.log('greenBeanPull: weeklySummarize did not complete for ' + toSummarize[s] +
        ' (' + (!sumRes ? 'no result'
                : sumRes.refused ? sumRes.refused
                : reported ? 'reported week ' + reported + ', not the one requested'
                : 'no weekStart in the return') + ') — week stays queued');
    }
  }
  var remainingQueue = mergedUnique.filter(function (w) { return !summarizedOk[w]; });
  greenBeanWriteQueue_(remainingQueue);
  if (remainingQueue.length > 0) {
    // A trigger-invoked run has no reader for the return value, so an
    // undrained backlog must say so itself — Summary stays stale for these
    // weeks until later runs (or a manual weeklySummarize sweep) drain them.
    Logger.log('greenBeanPull: ' + remainingQueue.length + ' affected week(s) still queued beyond the ' +
      GREENBEAN_RESUM_CAP + '/run cap (oldest: ' + remainingQueue[0] + ') — drained over coming runs');
  }

  // A live roastery with ZERO intake rows across a rolling quarter almost
  // certainly means a broken feed (renamed 06_Stock_Intake columns that still
  // resolve, a from/to mismatch), not real zero spend — say so loudly. Still
  // counted as a completed run (no alert spam if the quarter is genuinely
  // quiet), but the log makes the probe-worthy state visible.
  if (rows.length === 0) {
    Logger.log('greenBeanPull: WARNING — 0 intake rows across the entire 3-month window; ' +
      'verify 06_Stock_Intake in the Order app before trusting this as real zero spend');
  }

  orderAppRunSuccess_(GREENBEAN_SOURCE);

  return {
    rowsFetched: rows.length,
    invoices: invoices,
    flaggedRows: flaggedRows,
    rowsAdded: ingestResult.rowsAdded,
    rowsUpdated: ingestResult.rowsUpdated,
    duplicatesSkipped: ingestResult.duplicatesSkipped,
    weeksResummarized: Object.keys(summarizedOk).length,
    weeksQueued: remainingQueue.length
  };
}

/* ------------------------------------------------------------------ *
 * Coffee Order App wholesale revenue — PRD-14 weekly pull
 * ------------------------------------------------------------------ */

var WHOLESALE_RESUM_QUEUE_PROP = 'WHOLESALE_RESUM_QUEUE';

function wholesaleReadQueue_() {
  var raw = PropertiesService.getScriptProperties().getProperty(WHOLESALE_RESUM_QUEUE_PROP);
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function wholesaleWriteQueue_(weekStarts) {
  PropertiesService.getScriptProperties().setProperty(WHOLESALE_RESUM_QUEUE_PROP, JSON.stringify(weekStarts));
}

/**
 * Pure. Simulates upsertRows_'s dedup/compare logic against a working copy of
 * the pre-run Revenue snapshot, WITHOUT touching the sheet — used only for
 * dryRun, so a preview run reports the exact counts a real run would produce.
 * Mutates `simSnapshot` in place (adds/updates entries) so a later week in
 * the same dry run sees an earlier week's simulated write, mirroring how
 * sequential real ingestRevenueRows calls would.
 */
function wholesaleSimulateUpsert_(rows, simSnapshot) {
  var seenInBatch = {};
  var rowsAdded = 0, rowsUpdated = 0, duplicatesSkipped = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var key = WHOLESALE_SOURCE + '||' + sheetKeyPart_(row.order_ref);
    if (seenInBatch[key]) { duplicatesSkipped++; continue; }
    seenInBatch[key] = true;

    var existing = simSnapshot[key];
    var newAmount = Number(row.amount);
    if (!existing) {
      simSnapshot[key] = { amount: newAmount };
      rowsAdded++;
      continue;
    }
    if (Number(existing.amount) === newAmount) {
      duplicatesSkipped++;
    } else {
      existing.amount = newAmount;
      rowsUpdated++;
    }
  }
  return { rowsAdded: rowsAdded, rowsUpdated: rowsUpdated, duplicatesSkipped: duplicatesSkipped };
}

/**
 * Entry point: orderAppRunStart_ runs BEFORE the lock so a lock-timeout skip
 * still counts as a non-completion (same convention as shopifyWeeklyPull /
 * greenBeanPull).
 * @param {{dryRun?:boolean}} [opts]
 * @returns {Object} wholesalePull_impl_'s result, or {locked:true}.
 */
function wholesalePull(opts) {
  orderAppRunStart_(WHOLESALE_SOURCE);
  var res = withScriptLock_(function () { return wholesalePull_impl_(opts); });
  if (res === LOCK_TIMEOUT_) {
    Logger.log('wholesalePull: could not acquire script lock — skipped this run');
    return { locked: true };
  }
  return res;
}

/**
 * PRD-14 — fetch, cross-foot, guard, self-heal, ingest, re-summarize and
 * decide the heartbeat for the roastery wholesale revenue pull.
 * `opts.dryRun === true` builds and logs everything but writes NOTHING —
 * no ingest, no date-move cell writes, no weeklySummarize, no heartbeat, no
 * data-quality alert.
 * @param {{dryRun?:boolean}} [opts]
 */
function wholesalePull_impl_(opts) {
  opts = opts || {};
  var dryRun = opts.dryRun === true;

  var token = getOrderAppToken_();
  if (!token) {
    orderAppRunSkipped_(WHOLESALE_SOURCE);
    return { noToken: true };
  }

  var weeks = lastCompletedWeeks_(todayStr_(), wholesaleRepullWeeks_());
  var extractedAt = Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX");

  var ss = getHubSpreadsheet_();
  var revSheet = ensureSheet(ss, REVENUE_TAB, REVENUE_HEADERS);

  // Pre-ingest snapshot — read Revenue ONCE per run. Keys mirror rowKey_'s
  // normalization (source+order_ref, lowercased) so the date-move self-heal
  // and the dry-run simulation both key against exactly what upsertRows_
  // would see.
  var snapshot = {};
  var existingValues = revSheet.getDataRange().getValues();
  for (var er = 1; er < existingValues.length; er++) {
    var existingRow = existingValues[er];
    if (String(existingRow[6]) !== WHOLESALE_SOURCE) continue;
    snapshot[WHOLESALE_SOURCE + '||' + sheetKeyPart_(existingRow[5])] = {
      storedDate: coerceDateStr_(existingRow[0]),
      amount: Number(existingRow[4]),
      rowIndex: er + 1
    };
  }
  var simSnapshot = null;
  if (dryRun) {
    simSnapshot = {};
    for (var sk in snapshot) {
      if (Object.prototype.hasOwnProperty.call(snapshot, sk)) simSnapshot[sk] = { amount: snapshot[sk].amount };
    }
  }

  var failedWeeks = [];
  var crossFootFailures = [];
  var splitWeeks = [];
  var ordersFetched = 0;
  var rowsAdded = 0, rowsUpdated = 0, duplicatesSkipped = 0;
  var datesHealed = 0;
  var byBucket = { wholesale: 0, internal: 0, ambiguous: 0, unknown: 0 };
  var conflictList = [];
  var ambiguousTotal = 0, unknownTotal = 0;
  var zeroRowCompletedWeek = false;
  // weeksFetched counts weeks that fetched AND passed the shape gate (same
  // point its shopifyWeeklyPull sibling increments). It deliberately says
  // nothing about whether the money landed: a week can fetch cleanly and
  // still be dropped by the cross-foot or the archive-split guard. This is
  // the end-to-end counter — weeks that passed every guard and reached the
  // write path.
  var weeksWritten = 0;

  var affectedSet = {};
  var affected = [];
  function addAffectedWeek(weekStart) {
    if (affectedSet[weekStart]) return;
    affectedSet[weekStart] = true;
    affected.push(weekStart);
  }

  var weekWroteRows = {};      // week.label -> boolean (mapped.rows.length > 0)
  var weekWholesaleCents = {}; // week.label -> grossCentsByChannel.wholesale

  for (var wi = 0; wi < weeks.length; wi++) {
    var week = weeks[wi];

    var fetched = wholesaleFetchWeekOrders_(week);
    if (!fetched.ok) {
      failedWeeks.push({ week: week.label, reason: fetched.reason });
      continue;
    }
    ordersFetched += fetched.orders.length;

    // Per-scan diagnostics: NEVER week-scoped, NEVER ingested — the step-0
    // probe measured orphanRows at a constant $2,703 in every weekly
    // response and outOfWeekRows at ~$241k; summing them across weekly
    // pulls would invent six figures of revenue.
    var diagKeys = ['orphanRows', 'undatedRows', 'outOfWeekRows', 'excluded'];
    for (var dk = 0; dk < diagKeys.length; dk++) {
      var diag = fetched.meta && fetched.meta[diagKeys[dk]];
      if (diag && Number(diag.count) > 0) {
        Logger.log('wholesalePull: ' + week.label + ' ' + diagKeys[dk] + ' count=' + diag.count +
          ' gross=$' + diag.gross + ' — diagnostic only — never ingested');
      }
    }

    var conflicts = (fetched.meta && fetched.meta.classificationConflicts) || [];
    for (var cci = 0; cci < conflicts.length; cci++) conflictList.push(conflicts[cci]);

    if (fetched.summary.ambiguous) ambiguousTotal += Number(fetched.summary.ambiguous.orderCount) || 0;
    if (fetched.summary.unknown) unknownTotal += Number(fetched.summary.unknown.orderCount) || 0;

    var mapped = wholesaleRevenueRows_(fetched.orders);
    Logger.log('wholesalePull: ' + week.label + ' wholesale=$' + (mapped.grossCentsByChannel.wholesale / 100).toFixed(2) +
      ' internal=$' + (mapped.grossCentsByChannel.internal / 100).toFixed(2) +
      ' ambiguous=$' + (mapped.grossCentsByChannel.ambiguous / 100).toFixed(2) +
      ' unknown=$' + (mapped.grossCentsByChannel.unknown / 100).toFixed(2));

    // Cross-foot, integer cents: an order the PRODUCER counted (its shopType
    // classifies to a channel, and its amount reads as a real number even
    // though our stricter row-validator rejected it) must be subtracted from
    // that channel's producer gross before comparing — never as floats.
    var rowOrderRefs = {};
    for (var ri = 0; ri < mapped.rows.length; ri++) rowOrderRefs[mapped.rows[ri].order_ref] = true;
    var droppedCentsByChannel = { wholesale: 0, internal: 0, ambiguous: 0, unknown: 0 };
    for (var oi = 0; oi < fetched.orders.length; oi++) {
      var ord = fetched.orders[oi];
      var oRef = String(ord.orderId).trim();
      if (rowOrderRefs[oRef]) continue;
      var dropMapping = Object.prototype.hasOwnProperty.call(WHOLESALE_SHOPTYPE_MAP_, ord.shopType)
        ? WHOLESALE_SHOPTYPE_MAP_[ord.shopType] : null;
      if (!dropMapping) continue;
      var dropAmt = Number(ord.amount);
      if (!isFinite(dropAmt)) continue;
      droppedCentsByChannel[dropMapping.channel] += Math.round(dropAmt * 100);
    }

    var crossFootOk = true;
    var crossFootDetail = [];
    for (var mk in WHOLESALE_SHOPTYPE_MAP_) {
      if (!Object.prototype.hasOwnProperty.call(WHOLESALE_SHOPTYPE_MAP_, mk)) continue;
      var chMap = WHOLESALE_SHOPTYPE_MAP_[mk];
      var bucketObj = fetched.summary[chMap.bucket];
      var producerCents = Math.round(Number(bucketObj.gross) * 100);
      var expectedCents = producerCents - droppedCentsByChannel[chMap.channel];
      var mappedCents = mapped.grossCentsByChannel[chMap.channel];
      if (mappedCents !== expectedCents) {
        crossFootOk = false;
        crossFootDetail.push(chMap.channel + ': mapped=' + mappedCents + ' expected=' + expectedCents);
      }
    }
    if (!crossFootOk) {
      crossFootFailures.push({ week: week.label, reason: crossFootDetail.join('; ') });
      continue;
    }

    // Archive-split guard, BEFORE the write. weeksWithArchivedRows_ itself
    // fails CLOSED (unreadable _archive header -> every requested week
    // reported split) and logs that condition; called per-week (a single-
    // element array) so a genuine split is never conflated with the whole
    // run's fail-closed sweep.
    var split = weeksWithArchivedRows_([week.start]);
    if (split.indexOf(week.start) !== -1) {
      splitWeeks.push(week.start);
      Logger.log('wholesalePull: ' + week.start + ' has rows already in ' + ARCHIVE_TAB +
        ' — split week, writing nothing this run (see docs/schema.md)');
      continue;
    }

    // Date-move self-heal (ported from greenBeanPull_impl_, orderapp.gs:842-858):
    // upsertRows_/ingestRevenueRows never rewrite the date column, so an
    // upstream date correction (same ref, possibly same amount) would
    // otherwise leave the money in the wrong ISO week forever, invisible to
    // both duplicatesSkipped and the cross-foot (the API and mapped rows
    // agree; the disagreement is with what is already in the Sheet).
    var weekDatesHealed = 0;
    for (var mi = 0; mi < mapped.rows.length; mi++) {
      var mrow = mapped.rows[mi];
      var key = WHOLESALE_SOURCE + '||' + sheetKeyPart_(mrow.order_ref);
      var snap = snapshot[key];
      if (snap && mrow.date !== snap.storedDate) {
        if (!dryRun) {
          revSheet.getRange(snap.rowIndex, 1).setValue(mrow.date);
          revSheet.getRange(snap.rowIndex, 8).setValue(extractedAt);
        }
        addAffectedWeek(weekStartForDate_(snap.storedDate));
        addAffectedWeek(weekStartForDate_(mrow.date));
        weekDatesHealed++;
        // Keep the snapshot consistent with what the sheet now holds. The
        // same order_ref CAN surface in more than one weekly response (the
        // producer's week filter and the row's own date are different
        // fields), and a stale storedDate would re-fire this heal on the
        // later week — an idempotent write, but it double-counts datesHealed
        // and re-queues both weeks for no reason.
        snap.storedDate = mrow.date;
        Logger.log('wholesalePull: ' + mrow.order_ref + ' date moved ' + snap.storedDate + ' -> ' + mrow.date +
          ' upstream — Revenue row updated, both weeks resummarized');
      }
    }
    datesHealed += weekDatesHealed;

    var ingestRes;
    if (dryRun) {
      ingestRes = wholesaleSimulateUpsert_(mapped.rows, simSnapshot);
    } else {
      ingestRes = ingestRevenueRows(WHOLESALE_SOURCE, mapped.rows, extractedAt, revSheet);
    }

    rowsAdded += ingestRes.rowsAdded;
    rowsUpdated += ingestRes.rowsUpdated;
    duplicatesSkipped += ingestRes.duplicatesSkipped;
    weeksWritten++;

    // Within-batch order_ref collision detection. NOTE: this does NOT
    // reconcile ingestRes.duplicatesSkipped — it is derived from mapped.rows
    // alone, independently of what ingest reported. A legitimate skip (a
    // pre-existing sheet row with an identical amount) is invisible here by
    // design; what this catches is the one case upsertRows_ resolves
    // silently: a key that recurs within THIS week's batch is, by its own
    // short-circuit (Code.gs:728), ALWAYS dropped with no amount comparison
    // and never summed. Treated exactly like a cross-foot mismatch:
    // recorded, heartbeat suppressed — but the row(s) already written stay
    // written (the collision is discovered only after ingest resolves it).
    var batchSeen = {};
    var unexplainedSkips = 0;
    for (var br = 0; br < mapped.rows.length; br++) {
      var bkey = WHOLESALE_SOURCE + '||' + sheetKeyPart_(mapped.rows[br].order_ref);
      if (batchSeen[bkey]) { unexplainedSkips++; continue; }
      batchSeen[bkey] = true;
    }
    if (unexplainedSkips > 0) {
      crossFootFailures.push({
        week: week.label,
        reason: unexplainedSkips + ' unexplained duplicatesSkipped — within-batch order_ref collision'
      });
      Logger.log('wholesalePull: ' + week.label + ' — ' + unexplainedSkips +
        ' unexplained duplicatesSkipped (within-batch order_ref collision) — recorded, heartbeat suppressed');
    }

    if (ingestRes.rowsAdded + ingestRes.rowsUpdated > 0) addAffectedWeek(week.start);

    weekWroteRows[week.label] = mapped.rows.length > 0;
    weekWholesaleCents[week.label] = mapped.grossCentsByChannel.wholesale;
    if (mapped.rows.length === 0) zeroRowCompletedWeek = true;

    byBucket.wholesale += mapped.grossCentsByChannel.wholesale / 100;
    byBucket.internal += mapped.grossCentsByChannel.internal / 100;
    byBucket.ambiguous += mapped.grossCentsByChannel.ambiguous / 100;
    byBucket.unknown += mapped.grossCentsByChannel.unknown / 100;
  }

  // Resummarize: same cap + persisted overflow queue as greenBeanPull_impl_
  // (crash safety: the full affected list is persisted BEFORE the loop).
  var merged = wholesaleReadQueue_().concat(affected);
  var mergedSet = {};
  var mergedUnique = [];
  for (var m = 0; m < merged.length; m++) {
    if (mergedSet[merged[m]]) continue;
    mergedSet[merged[m]] = true;
    mergedUnique.push(merged[m]);
  }
  mergedUnique.sort();

  var resummarizedWeeksOk = {};
  var remainingQueue = mergedUnique;
  if (!dryRun) {
    var toSummarize = mergedUnique.slice(0, GREENBEAN_RESUM_CAP);
    wholesaleWriteQueue_(mergedUnique);
    for (var s = 0; s < toSummarize.length; s++) {
      var sumRes = weeklySummarize(toSummarize[s]);
      var reported = sumRes && sumRes.weekStart ? coerceDateStr_(sumRes.weekStart) : null;
      if (sumRes && !sumRes.refused && reported === toSummarize[s]) {
        resummarizedWeeksOk[toSummarize[s]] = true;
      } else {
        Logger.log('wholesalePull: weeklySummarize did not complete for ' + toSummarize[s] + ' (' +
          (!sumRes ? 'no result' : sumRes.refused ? sumRes.refused :
            reported ? 'reported week ' + reported + ', not the one requested' : 'no weekStart in the return') +
          ') — week stays queued');
      }
    }
    remainingQueue = mergedUnique.filter(function (w) { return !resummarizedWeeksOk[w]; });
    wholesaleWriteQueue_(remainingQueue);
    if (remainingQueue.length > 0) {
      // A trigger-invoked run has no reader for the return value, so an
      // undrained backlog must say so itself (same as greenBeanPull).
      // Read the OLDEST entry first: toSummarize takes mergedUnique's first
      // GREENBEAN_RESUM_CAP in chronological order, and a week that is split
      // across _archive is refused ('skip-split') by weeklySummarize on EVERY
      // run — so it never clears. Enough stuck old weeks would consume the
      // whole per-run cap and starve newer weeks indefinitely. A run where
      // the oldest entry never changes is that condition, not a slow drain.
      Logger.log('wholesalePull: ' + remainingQueue.length + ' affected week(s) still queued beyond the ' +
        GREENBEAN_RESUM_CAP + '/run cap (oldest: ' + remainingQueue[0] + ') — drained over coming runs; ' +
        'an oldest entry that never advances is a permanently-refused week, not a backlog');
    }
  }

  // Heartbeat — Prohibition 10, all five conditions on the NEWEST week only
  // (the 8-week-window rule: an older week failing must never block it).
  var newestWeek = weeks.length ? weeks[weeks.length - 1] : null;
  var heartbeatStamped = false;
  if (newestWeek && !dryRun) {
    var newestFailed = failedWeeks.some(function (f) { return f.week === newestWeek.label; });
    var newestCrossFootBad = crossFootFailures.some(function (f) { return f.week === newestWeek.label; });
    var newestSplit = splitWeeks.indexOf(newestWeek.start) !== -1;
    var newestWroteRows = !!weekWroteRows[newestWeek.label];
    var newestGrossOk = (weekWholesaleCents[newestWeek.label] || 0) >= Math.round(WHOLESALE_GROSS_FLOOR * 100);
    // A week that needed no resummarize (nothing new/updated, no date move)
    // cannot fail one — only a week that DID need it must have completed.
    var newestNeededResum = !!affectedSet[newestWeek.start];
    var newestResumOk = !newestNeededResum || !!resummarizedWeeksOk[newestWeek.start];

    heartbeatStamped = !newestFailed && !newestCrossFootBad && !newestSplit &&
      newestWroteRows && newestGrossOk && newestResumOk;
  }

  // Data-quality alert — never auto-resolve a conflict; a human fixes SHOPS
  // in the Order app. Signature-gated so an unchanged condition doesn't
  // re-alert every run for ~13 weeks straight (same convention as
  // greenBeanPull's upstream-warning alert).
  var dqTriggered = failedWeeks.length > 0 || crossFootFailures.length > 0 || splitWeeks.length > 0 ||
    zeroRowCompletedWeek || ambiguousTotal > 0 || unknownTotal > 0 || conflictList.length > 0;

  if (!dryRun) {
    if (dqTriggered) {
      var sigParts = conflictList.slice().sort()
        .concat(failedWeeks.map(function (f) { return f.week; }).sort())
        .concat(splitWeeks.slice().sort());
      var message = [
        'wholesalePull data-quality conditions this run:',
        failedWeeks.length ? ('- failed weeks: ' + failedWeeks.map(function (f) { return f.week + ' (' + f.reason + ')'; }).join(', ')) : null,
        crossFootFailures.length ? ('- cross-foot/collision issues: ' + crossFootFailures.map(function (f) { return f.week + ' (' + f.reason + ')'; }).join(', ')) : null,
        splitWeeks.length ? ('- split weeks (rows already archived): ' + splitWeeks.join(', ')) : null,
        zeroRowCompletedWeek ? '- a completed week produced zero rows' : null,
        ambiguousTotal > 0 ? ('- ' + ambiguousTotal + ' AMBIGUOUS order(s) — a human resolves SHOPS in the Order app') : null,
        unknownTotal > 0 ? ('- ' + unknownTotal + ' UNKNOWN order(s)') : null,
        conflictList.length ? ('- classification conflicts: ' + conflictList.join('; ')) : null
      ].filter(Boolean).join('\n');
      orderAppRaiseDataQualityAlert_(WHOLESALE_SOURCE, message, orderAppSignatureHash_(sigParts.join('|')));
    } else {
      orderAppClearDataQualitySignature_(WHOLESALE_SOURCE);
    }
  }

  if (!dryRun && heartbeatStamped) {
    orderAppRunSuccess_(WHOLESALE_SOURCE);
  }

  return {
    weeksRequested: weeks.length,
    weeksFetched: weeks.length - failedWeeks.length,
    weeksWritten: weeksWritten,
    failedWeeks: failedWeeks,
    crossFootFailures: crossFootFailures,
    splitWeeks: splitWeeks,
    ordersFetched: ordersFetched,
    rowsAdded: rowsAdded,
    rowsUpdated: rowsUpdated,
    duplicatesSkipped: duplicatesSkipped,
    datesHealed: datesHealed,
    weeksResummarized: Object.keys(resummarizedWeeksOk).length,
    weeksQueued: remainingQueue.length,
    byBucket: byBucket,
    heartbeatStamped: heartbeatStamped,
    dryRun: dryRun
  };
}

/* ------------------------------------------------------------------ *
 * Triggers
 * ------------------------------------------------------------------ */

/**
 * shopifyWeeklyPull: Monday 05:00 Sydney — one hour after the 04:00
 * weeklySummarize, so a lock collision is rare; if it happens it's
 * loud-logged, counted, and self-heals next run via the 4-week repull
 * window. greenBeanPull: Tuesday 05:00 Sydney.
 *
 * wholesalePull: Monday 06:00 Sydney — after weeklySummarize (04:00) and
 * shopifyWeeklyPull (05:00). The slot is not arbitrary: LEIBLE_GM_COST_MONITOR
 * reads doGet at Monday 08:00 (Main.gs:270), so a pull landing after that
 * misses the read by six days and permanently understates the company
 * headline by the newest week's wholesale revenue. GAS weekly triggers fire
 * at a random minute inside the named hour, so the real margin is ~50
 * minutes, and a withScriptLock_ timeout aborts with no retry — hence
 * wholesalePullRetry at 07:00 as a second chance.
 *
 * Idempotent: deletes only triggers for these four handler names before
 * recreating them, mirroring installShopSpendWatchdogTrigger_ (shopspend.gs)
 * — never sweeps unrelated triggers.
 */
function installOrderAppTriggers() {
  var handlers = ['shopifyWeeklyPull', 'greenBeanPull', 'wholesalePull', 'wholesalePullRetry'];
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (handlers.indexOf(triggers[i].getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('shopifyWeeklyPull')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(5)
    .inTimezone('Australia/Sydney').create();
  ScriptApp.newTrigger('greenBeanPull')
    .timeBased().onWeekDay(ScriptApp.WeekDay.TUESDAY).atHour(5)
    .inTimezone('Australia/Sydney').create();
  ScriptApp.newTrigger('wholesalePull')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6)
    .inTimezone('Australia/Sydney').create();
  ScriptApp.newTrigger('wholesalePullRetry')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7)
    .inTimezone('Australia/Sydney').create();
  Logger.log('installOrderAppTriggers: shopifyWeeklyPull Monday 05:00 + greenBeanPull Tuesday 05:00 + ' +
    'wholesalePull Monday 06:00 + wholesalePullRetry Monday 07:00 (Australia/Sydney) installed');
}

/**
 * Mon 07:00 second chance for wholesalePull's Mon 06:00 slot. No-ops
 * (logged) when the coffee_order_app heartbeat was already stamped within
 * the last 6 hours — the 06:00 run succeeded and a re-pull would be
 * redundant. An older or absent heartbeat means that run never fired or
 * aborted (e.g. a withScriptLock_ timeout), so this calls through.
 */
function wholesalePullRetry() {
  var raw = PropertiesService.getScriptProperties().getProperty(STALENESS_HEARTBEAT_PREFIX + WHOLESALE_SOURCE);
  var lastMs = stalenessParseTs_(raw);
  if (lastMs !== null && (Date.now() - lastMs) < 6 * 3600000) {
    Logger.log('wholesalePullRetry: coffee_order_app heartbeat is fresh (<6h) — Mon 06:00 run already succeeded, no-op');
    return;
  }
  wholesalePull();
}
