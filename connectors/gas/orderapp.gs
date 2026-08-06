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
function shopifyWeeklyPull_impl_() {
  var token = getOrderAppToken_();
  if (!token) {
    return { noToken: true };
  }

  var weeks = lastCompletedWeeks_(todayStr_(), SHOPIFY_REPULL_WEEKS);
  var pulledAt = Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX");

  var normalizedRows = [];
  var weeksFetched = 0;
  var apiFailed = false;

  for (var i = 0; i < weeks.length; i++) {
    var res = orderAppFetch_({ api: 'shopifySales', week: weeks[i].label });
    if (!res.ok) {
      apiFailed = true;
      continue;
    }
    weeksFetched++;

    var body = res.body;
    var weekStart = String(body.meta.weekStart).slice(0, 10);
    var weekEnd = addDaysStr_(weekStart, 6);
    normalizedRows.push([
      weekStart, weekEnd, SHOPIFY_ORDERAPP_SOURCE, 'online',
      Number(body.summary.grossSales), pulledAt, 'Roastery', 'revenue'
    ]);
  }

  var ss = getHubSpreadsheet_();
  var summSheet = ensureSheet(ss, SUMMARY_TAB, SUMMARY_HEADERS);
  var upsertResult = upsertRows_(summSheet, normalizedRows, SUMMARY_KEY_COLS, SUMMARY_TOTAL_COL, SUMMARY_STAMP_COL);

  var result = {
    weeksRequested: weeks.length,
    weeksFetched: weeksFetched,
    rowsAdded: upsertResult.rowsAdded,
    rowsUpdated: upsertResult.rowsUpdated,
    duplicatesSkipped: upsertResult.duplicatesSkipped
  };

  if (apiFailed) {
    result.apiFailed = true;
  } else {
    orderAppRunSuccess_(SHOPIFY_ORDERAPP_SOURCE);
  }

  return result;
}
