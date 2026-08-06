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
function orderAppRaiseDataQualityAlert_(source, message) {
  try {
    var cal = stalenessCalendar_();
    if (!cal) {
      Logger.log('orderAppRaiseDataQualityAlert_: no calendar available for ' + source);
      return;
    }
    var ev = cal.createAllDayEvent('LEIBLE expense orderapp data quality: ' + source, new Date());
    ev.setColor(CalendarApp.EventColor.ORANGE);
    ev.setDescription(message + '\n\nFix the underlying cells in the Order app (06_Stock_Intake); ' +
      'the next scheduled pull re-ingests corrected figures automatically.');
  } catch (err) {
    Logger.log('orderAppRaiseDataQualityAlert_: failed for ' + source + ' — ' + err.message);
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
    weeksFetched++;

    var body = res.body;
    var weekStart = String(body.meta.weekStart).slice(0, 10);
    var weekEnd = addDaysStr_(weekStart, 6);
    normalizedRows.push([
      weekStart, weekEnd, SHOPIFY_ORDERAPP_SOURCE, 'online',
      Number(body.summary.grossSales), pulledAt, 'Roastery', 'revenue'
    ]);

    // The metric is gross of PAID/PARTIALLY_PAID orders; a refund of any size
    // removes the WHOLE order from the week (Order-app contract — deliberate).
    // The excluded buckets exist precisely so that shrink can be reconciled;
    // surface them instead of discarding them.
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
    var invoiceNum = line.invoiceNum || '';
    var groupKey;
    if (invoiceNum) {
      groupKey = line.supplierKey + '/' + invoiceNum;
    } else {
      groupKey = line.supplierKey + '/noinv-' + line.dateLocal;
    }

    if (!groups[groupKey]) {
      groups[groupKey] = {
        supplierRaw: line.supplierRaw,
        supplierKey: line.supplierKey,
        invoiceNum: invoiceNum,
        dateLocal: line.dateLocal,
        total: 0,
        groupKey: groupKey
      };
    }

    groups[groupKey].total += line.totalCostIncGst;
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
      supplier: group.supplierRaw,
      total: Math.round(group.total * 100) / 100,
      invoice_ref: group.groupKey,
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
  var rows = [];
  var offset = 0;
  var seenRowNumbers = {};
  var duplicatesSkipped = 0;
  var upstreamAlertRaised = false; // one alert per pull, not per page

  while (true) {
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

    var paging = res.body.meta.paging;
    if (paging.truncated === true && paging.rowsIncluded === false) {
      Logger.log('greenBeanFetchAllRows_: truncated response with rows omitted (size guard) — aborting rather than ingest an incomplete window');
      return null;
    }

    // Surface upstream data-quality signals verbatim — the API coerces a
    // non-numeric price/kg cell to 0 and drops invalid-Timestamp rows,
    // reporting both ONLY here. Discarding them turns a typo'd cell into a
    // silently understated committed-spend figure.
    var diagnostics = res.body.diagnostics || {};
    var warnings = diagnostics.warnings || res.body.warnings || [];
    for (var w = 0; w < warnings.length; w++) {
      Logger.log('greenBeanFetchAllRows_: UPSTREAM WARNING — ' + warnings[w]);
    }
    if (warnings.length > 0 && !upstreamAlertRaised) {
      upstreamAlertRaised = true;
      orderAppRaiseDataQualityAlert_('greenbean',
        'The greenBeanCost API reported ' + warnings.length + ' data-quality warning(s) this pull ' +
        '(e.g. rows hidden by an invalid Timestamp) — the ingested spend may be incomplete:\n- ' +
        warnings.join('\n- '));
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
      offset += paging.returned;
      continue;
    }
    break;
  }

  if (duplicatesSkipped > 0) {
    Logger.log('greenBeanFetchAllRows_: skipped ' + duplicatesSkipped +
      ' duplicate row(s) across pages (live-sheet offset shift) — totals kept exact');
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
  orderAppRunStart_('greenbean');
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
    orderAppRunSkipped_('greenbean');
    return { noToken: true };
  }

  var rows = greenBeanFetchAllRows_();
  if (rows === null) {
    return { apiFailed: true };
  }

  // Per-row flags mark values the API coerced (e.g. non-numeric PriceKg → $0
  // line). The lines still ingest (locked decision: never dropped), but the
  // count must be loud — a flagged line usually means an understated invoice.
  var flaggedRows = 0;
  for (var f = 0; f < rows.length; f++) {
    if (rows[f].flags && rows[f].flags.length) flaggedRows++;
  }
  if (flaggedRows > 0) {
    Logger.log('greenBeanPull: ' + flaggedRows + ' flagged intake row(s) (coerced values, likely $0 lines) — ' +
      'greenbean totals may be understated; fix the 06_Stock_Intake cells in the Order app');
    orderAppRaiseDataQualityAlert_('greenbean',
      flaggedRows + ' stock-intake row(s) carry coerced values (non-numeric price/kg read as $0) — ' +
      'the greenbean committed-spend figure is likely UNDERSTATED until the cells are fixed.');
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
    if (String(existingRow[5]) !== 'greenbean') continue;
    snapshot['greenbean||' + String(existingRow[3]).toLowerCase()] = {
      storedDate: coerceDateStr_(existingRow[0]),
      total: Number(existingRow[2])
    };
  }

  var ingestResult = ingestSupplierRows('greenbean', invoices, extractedAt, suppSheet);

  var currentWeekStart = weekStartForDate_(todayStr_());
  var affectedSet = {};
  var affected = [];
  function addAffectedWeek(weekStart) {
    if (weekStart >= currentWeekStart) return; // never resummarize/queue the current, incomplete week
    if (affectedSet[weekStart]) return;
    affectedSet[weekStart] = true;
    affected.push(weekStart);
  }

  for (var i = 0; i < invoices.length; i++) {
    var invoice = invoices[i];
    var snap = snapshot['greenbean||' + String(invoice.invoice_ref).toLowerCase()];
    if (!snap) {
      addAffectedWeek(weekStartForDate_(invoice.date));
      continue;
    }
    var newTotal = Math.round(Number(invoice.total) * 100) / 100;
    var oldTotal = Math.round(Number(snap.total) * 100) / 100;
    if (newTotal !== oldTotal) {
      addAffectedWeek(weekStartForDate_(snap.storedDate));
    }
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
  var remaining = mergedUnique.slice(GREENBEAN_RESUM_CAP);

  // Crash safety: Suppliers already holds the new totals, so the snapshot
  // diff above can never be re-derived. Persist the FULL affected list BEFORE
  // the resummarize loop — if the run dies mid-loop (throw, 6-min limit), the
  // next run drains every week from the property; an already-summarized week
  // re-runs idempotently. Only after the loop finishes does the property
  // shrink to the true remainder.
  greenBeanWriteQueue_(mergedUnique);
  for (var s = 0; s < toSummarize.length; s++) {
    weeklySummarize(toSummarize[s]);
  }
  greenBeanWriteQueue_(remaining);

  // A live roastery with ZERO intake rows across a rolling quarter almost
  // certainly means a broken feed (renamed 06_Stock_Intake columns that still
  // resolve, a from/to mismatch), not real zero spend — say so loudly. Still
  // counted as a completed run (no alert spam if the quarter is genuinely
  // quiet), but the log makes the probe-worthy state visible.
  if (rows.length === 0) {
    Logger.log('greenBeanPull: WARNING — 0 intake rows across the entire 3-month window; ' +
      'verify 06_Stock_Intake in the Order app before trusting this as real zero spend');
  }

  orderAppRunSuccess_('greenbean');

  return {
    rowsFetched: rows.length,
    invoices: invoices,
    flaggedRows: flaggedRows,
    rowsAdded: ingestResult.rowsAdded,
    rowsUpdated: ingestResult.rowsUpdated,
    duplicatesSkipped: ingestResult.duplicatesSkipped,
    weeksResummarized: toSummarize.length,
    weeksQueued: remaining.length
  };
}

/* ------------------------------------------------------------------ *
 * Triggers
 * ------------------------------------------------------------------ */

/**
 * shopifyWeeklyPull: Monday 05:00 Sydney — one hour after the 04:00
 * weeklySummarize, so a lock collision is rare; if it happens it's
 * loud-logged, counted, and self-heals next run via the 4-week repull
 * window. greenBeanPull: Tuesday 05:00 Sydney. Idempotent: deletes only
 * triggers for these two handler names before recreating them, mirroring
 * installShopSpendWatchdogTrigger_ (shopspend.gs) — never sweeps unrelated
 * triggers.
 */
function installOrderAppTriggers() {
  var handlers = ['shopifyWeeklyPull', 'greenBeanPull'];
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
  Logger.log('installOrderAppTriggers: shopifyWeeklyPull Monday 05:00 + greenBeanPull Tuesday 05:00 (Australia/Sydney) installed');
}
