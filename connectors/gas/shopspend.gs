/**
 * shopspend.gs — shopSpend silo.
 *
 * Separate from the Suppliers/Sales/Revenue/Summary ingest contract: ShopSpend
 * is an append-only snapshot store (never routed through upsertRows_), backed
 * by ShopSpendPulls (one row per pull attempt) and ShopSpend Report (derived,
 * rebuilt in place). See docs/schema.md for the full tab specs.
 *
 * Loaded by connectors/gas/test_code.js under the Node mock of SpreadsheetApp.
 */

/**
 * Ensure the three shopSpend tabs exist with their header rows.
 * @returns {{ data: Sheet, pulls: Sheet, report: Sheet }}
 */
function ensureShopSpendTabs_(ss) {
  return {
    data: ensureSheet(ss, SHOPSPEND_TAB, SHOPSPEND_HEADERS),
    pulls: ensureSheet(ss, SHOPSPEND_PULLS_TAB, SHOPSPEND_PULLS_HEADERS),
    report: ensureSheet(ss, SHOPSPEND_REPORT_TAB, [])
  };
}

// Below this many present shop-weeks in a declared-complete week, the
// blast-radius breaker never applies — a 2-of-3-shop closure is ordinary,
// not a signal of a client/scoping bug. See docs/schema.md and the step 1
// task file for the full rationale (a wrong tombstone self-heals, a
// suppressed one does not — so the floor exists to keep small, normal
// closures from being permanently held back by the breaker below).
var SHOPSPEND_TOMBSTONE_BREAKER_FLOOR_ = 5;

/**
 * Normalize + ingest a batch of ShopSpend rows with change detection.
 * Append-only: a row is written only when a figure changed.
 *
 * Tombstoning is scoped to `weeksComplete` (array of ISO week labels the
 * caller declares it carries IN FULL in this request) — never to "weeks seen
 * in rows". A week absent from `weeksComplete` is never tombstoned, however
 * many of its rows this payload carries; this is what makes a chunked pull
 * safe to split (see docs/schema.md "shopSpend tabs" and the step 1 task
 * file's C1 repro). Exact hash-set membership only — never substring/indexOf,
 * which would let a truncated label match a longer one.
 *
 * A week whose tombstone candidates exceed both the floor
 * (SHOPSPEND_TOMBSTONE_BREAKER_FLOOR_ present shop-weeks) and half of that
 * week's present shop-weeks is SKIPPED rather than written, unless the week
 * is also named in `weeksVerifiedEmpty` (the caller asserting it positively
 * confirmed the week is empty upstream, not merely "I saw fewer rows than
 * before"). A skip is sticky — it recomputes from the same sheet state every
 * pull and never self-heals — so it is reported back on every response via
 * tombstonesSkipped, not just logged.
 *
 * If `pull` is present, one metadata row is appended to ShopSpendPulls LAST,
 * after the data rows, as the commit marker for a chunked pull.
 * @returns {{rowsAdded:number, rowsUpdated:number, duplicatesSkipped:number,
 *   tombstonesWritten:number, tombstonesSkipped:Array<{week:string,wouldHaveWritten:number,present:number}>}}
 */
function ingestShopSpendRows(source, rows, extractedAt, sheet, pullsSheet, pull, weeksComplete, weeksVerifiedEmpty) {
  var normalizedRows = [];
  for (var i = 0; i < rows.length; i++) {
    normalizedRows.push(normalizeShopSpendRow(rows[i], source, extractedAt));
  }

  var completeSet = {};
  var completeList = Array.isArray(weeksComplete) ? weeksComplete : [];
  for (var wc = 0; wc < completeList.length; wc++) completeSet[completeList[wc]] = true;

  // Belt-and-braces: a week is exempt from the breaker only if it is BOTH
  // declared verified-empty AND actually carries no rows in this payload.
  // validateIngest_ already rejects a payload where a verified-empty week has
  // rows, but this function must not trust that flag blindly on its own.
  var verifiedEmptySet = {};
  var verifiedEmptyList = Array.isArray(weeksVerifiedEmpty) ? weeksVerifiedEmpty : [];
  for (var ve = 0; ve < verifiedEmptyList.length; ve++) verifiedEmptySet[verifiedEmptyList[ve]] = true;

  var weeksWithRowsThisPayload = {};
  for (var wi = 0; wi < normalizedRows.length; wi++) weeksWithRowsThisPayload[normalizedRows[wi][1]] = true;
  for (var week in weeksWithRowsThisPayload) {
    if (Object.prototype.hasOwnProperty.call(weeksWithRowsThisPayload, week) && verifiedEmptySet[week]) {
      delete verifiedEmptySet[week];
    }
  }

  if (!Array.isArray(weeksComplete) && normalizedRows.length > 0) {
    Logger.log('ingestShopSpendRows: weeks_complete absent — tombstoning skipped entirely for this pull (source=' + source + ')');
  }

  // 1. Build latest-snapshot index: for each (shop_id, week_label) key,
  // keep LAST row encountered (append order).
  var allValues = sheet.getDataRange().getValues();
  var latestIndex = {}; // key -> row array
  for (var r = 1; r < allValues.length; r++) { // skip header
    var row = allValues[r];
    var key = rowKey_(row, [0, 1]); // shop_id, week_label
    latestIndex[key] = row;
  }

  // 2. Change detection: collect rows to append.
  var toAppend = [];
  var duplicatesSkipped = 0;
  var incomingKeys = {}; // keys present in this payload

  for (var i = 0; i < normalizedRows.length; i++) {
    var row = normalizedRows[i];
    var key = rowKey_(row, [0, 1]); // shop_id, week_label
    incomingKeys[key] = true;

    var latest = latestIndex[key];
    var isNew = latest === undefined;

    if (isNew) {
      toAppend.push(row);
    } else {
      // Compare the five numeric figures: order_count (4), amended_count (5),
      // total_ex_gst (6), gst (7), total_inc_gst (8).
      var figureChanged = false;
      for (var fIdx = 4; fIdx <= 8; fIdx++) {
        if (Number(row[fIdx]) !== Number(latest[fIdx])) {
          figureChanged = true;
          break;
        }
      }

      // A latest snapshot with presence='absent' counts as a difference —
      // the shop-week reappearing is a real change.
      var wasAbsent = latest[13] === 'absent'; // presence at index 13

      if (figureChanged || wasAbsent) {
        toAppend.push(row);
        latestIndex[key] = row; // update the latest snapshot for future tombstone checks
      } else {
        duplicatesSkipped++;
      }
    }
  }

  // 3. Tombstone candidates, scoped strictly to weeks in `completeSet`
  // (exact hash-set membership, never indexOf/substring). Group by week so
  // the blast-radius breaker can be evaluated per week.
  var candidatesByWeek = {}; // week -> [existingRow, ...] present + missing from incoming
  var presentCountByWeek = {}; // week -> count of ALL currently-present shop-weeks (not just candidates)

  for (var existingKey in latestIndex) {
    if (!Object.prototype.hasOwnProperty.call(latestIndex, existingKey)) continue;
    var existingRow = latestIndex[existingKey];
    var existingWeek = existingRow[1]; // week_label
    var existingPresence = existingRow[13]; // presence

    if (!completeSet[existingWeek]) continue; // not declared complete — never a tombstone candidate
    if (existingPresence !== 'present') continue;

    presentCountByWeek[existingWeek] = (presentCountByWeek[existingWeek] || 0) + 1;

    if (!incomingKeys[existingKey]) {
      if (!candidatesByWeek[existingWeek]) candidatesByWeek[existingWeek] = [];
      candidatesByWeek[existingWeek].push(existingRow);
    }
  }

  var tombstones = [];
  var tombstonesSkipped = [];

  for (var candWeek in candidatesByWeek) {
    if (!Object.prototype.hasOwnProperty.call(candidatesByWeek, candWeek)) continue;
    var candidates = candidatesByWeek[candWeek];
    var presentCount = presentCountByWeek[candWeek] || 0;
    var wouldHaveWritten = candidates.length;

    var meetsFloor = presentCount >= SHOPSPEND_TOMBSTONE_BREAKER_FLOOR_;
    var exceedsHalf = wouldHaveWritten > presentCount / 2;
    var isVerifiedEmpty = !!verifiedEmptySet[candWeek];

    var skip = !isVerifiedEmpty && meetsFloor && exceedsHalf;

    if (skip) {
      tombstonesSkipped.push({ week: candWeek, wouldHaveWritten: wouldHaveWritten, present: presentCount });
      // Durable server-side record. The skip is STICKY — it recomputes from the
      // same sheet state every pull, so it stays suppressed until a human
      // confirms it (docs/api.md). The wire field alone is not enough: the
      // weekly task runs unattended and its stderr goes to a gitignored log,
      // and the watchdog still reports healthy because a ShopSpendPulls row
      // was written. Without this line nobody is ever told.
      Logger.log('ingestShopSpendRows: tombstoning SKIPPED for week ' + candWeek +
        ' — would have written ' + wouldHaveWritten + ' of ' + presentCount +
        ' present shop-week(s); suppressed until a human confirms (source=' + source + ')');
      continue;
    }

    for (var ci = 0; ci < candidates.length; ci++) {
      var srcRow = candidates[ci];
      // Build tombstone row: same shop_id/week_label/week_start/week_end,
      // zeros for figures, presence='absent', current fetched_at.
      var tombstone = [];
      for (var c = 0; c < SHOPSPEND_HEADERS.length; c++) {
        if (c === 0 || c === 1 || c === 2 || c === 3) {
          // shop_id, week_label, week_start, week_end
          tombstone.push(srcRow[c]);
        } else if (c >= 4 && c <= 8) {
          // order_count, amended_count, total_ex_gst, gst, total_inc_gst
          tombstone.push(0);
        } else if (c === 9) {
          // gst_treatment
          tombstone.push(srcRow[c]);
        } else if (c === 10) {
          // environment
          tombstone.push(srcRow[c]);
        } else if (c === 11) {
          // fetched_at — the extractedAt PARAMETER, never normalizedRows[0]:
          // tombstoning is no longer gated on the payload having rows, so
          // normalizedRows[0] is reachable-undefined for a rows:[] pull.
          tombstone.push(extractedAt);
        } else if (c === 12) {
          // source
          tombstone.push(source);
        } else if (c === 13) {
          // presence
          tombstone.push('absent');
        } else {
          tombstone.push(srcRow[c]);
        }
      }
      tombstones.push(tombstone);
    }
  }

  // 4. Block write: collect all rows to append and write once.
  var block = toAppend.concat(tombstones);
  if (block.length > 0) {
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, block.length, SHOPSPEND_HEADERS.length).setValues(block);
  }

  // Write ShopSpendPulls row as commit marker.
  if (pull) {
    appendNewRows_(pullsSheet, [normalizePullMetadataRow_(pull)]);
  }

  return {
    rowsAdded: toAppend.length + tombstones.length,
    rowsUpdated: 0,
    duplicatesSkipped: duplicatesSkipped,
    tombstonesWritten: tombstones.length,
    tombstonesSkipped: tombstonesSkipped
  };
}

/* ------------------------------------------------------------------ *
 * Report builder (step 6) — rebuilt in place from the snapshot store.
 * See docs/schema.md "Tab `ShopSpend Report`" for the full banner spec.
 * ------------------------------------------------------------------ */

/**
 * Parse a 'YYYY-Www' label (1 or 2 digit week number) for numeric sort.
 * Never sort week labels lexicographically — '2026-W10' < '2026-W9' as
 * strings, which is wrong.
 */
function parseShopSpendWeekLabel_(label) {
  var m = /^(\d{4})-W(\d{1,2})$/.exec(String(label));
  if (!m) return { year: 0, week: 0 };
  return { year: Number(m[1]), week: Number(m[2]) };
}

function compareShopSpendWeekLabels_(a, b) {
  var pa = parseShopSpendWeekLabel_(a);
  var pb = parseShopSpendWeekLabel_(b);
  if (pa.year !== pb.year) return pa.year - pb.year;
  return pa.week - pb.week;
}

function safeJsonArray_(v) {
  try {
    var parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/** Render one grid cell from its latest snapshot row (or undefined). */
function shopSpendReportCell_(latestRow, pullUnpricedSkuCount, pullEmptyRangeInvalid) {
  if (!latestRow) {
    return pullEmptyRangeInvalid ? 'unconfirmed' : '';
  }
  if (latestRow[13] === 'absent') return 'stale'; // presence
  var cell = (pullUnpricedSkuCount > 0 ? '~' : '') + latestRow[8]; // total_inc_gst
  if (Number(latestRow[5]) > 0) cell += ' amended'; // amended_count
  return cell;
}

/**
 * Pure: (snapshotRows, latestPullRow) -> 2D array ready for a single
 * setValues(). snapshotRows is the ShopSpend data range with the header
 * row excluded, in append order. latestPullRow is the single most-recent
 * ShopSpendPulls row (SHOPSPEND_PULLS_HEADERS order).
 */
function shopSpendReportBlock_(snapshotRows, latestPullRow) {
  var pull = latestPullRow || [];

  // Latest-snapshot index: (shop_id, week_label) -> row. Overwriting on
  // every iteration means the LAST row in append order always wins — never
  // resolved by comparing fetched_at (see docs/schema.md DST rule).
  var latestIndex = {};
  var shopOrder = [];
  var weekSet = {};
  for (var i = 0; i < snapshotRows.length; i++) {
    var row = snapshotRows[i];
    var shopId = row[0];
    var weekLabel = row[1];
    var key = shopId + '||' + weekLabel;
    latestIndex[key] = row;
    weekSet[weekLabel] = true;
    if (shopOrder.indexOf(shopId) === -1) shopOrder.push(shopId);
  }

  var weeks = Object.keys(weekSet).sort(compareShopSpendWeekLabels_);

  var pullUnpricedSkuCount = Number(pull[9]) || 0; // unpriced_sku_count
  var pullEmptyRangeInvalid = pull[13] === true; // empty_range_with_invalid_labels
  var pullGstTreatment = pull[15]; // gst_treatment
  var pullDivergesRaw = pull[16]; // diverges_from_live_pricing: true/false/''/undefined
  var pullFetchedAt = pull[0]; // fetched_at
  var pullWarnings = safeJsonArray_(pull[8]); // warnings
  var pullDuplicateShopNames = safeJsonArray_(pull[12]); // possible_duplicate_shop_names

  var amendedShopWeekCount = 0;
  var absentShopWeekCount = 0;
  for (var k in latestIndex) {
    if (!Object.prototype.hasOwnProperty.call(latestIndex, k)) continue;
    var latestRow = latestIndex[k];
    if (Number(latestRow[5]) > 0) amendedShopWeekCount++; // amended_count
    if (latestRow[13] === 'absent') absentShopWeekCount++; // presence
  }

  var banners = [];

  for (var w = 0; w < pullWarnings.length; w++) {
    banners.push(['⚠ WARNING: ' + pullWarnings[w]]);
  }

  if (pullUnpricedSkuCount > 0) {
    banners.push(['⚠ TOTALS ARE APPROXIMATE — ' + pullUnpricedSkuCount +
      ' SKUs unpriced; those line items were skipped entirely.']);
  }

  if (amendedShopWeekCount > 0) {
    banners.push([amendedShopWeekCount +
      ' shop-weeks contain amended orders — provisional, may change.']);
  }

  if (pullDuplicateShopNames.length > 0) {
    banners.push(['Possible duplicate shop names — fix upstream. NOT merged automatically: ' +
      pullDuplicateShopNames.join(', ')]);
  }

  if (pullEmptyRangeInvalid) {
    banners.push(['Empty range with invalid week labels — affected cells show "unconfirmed", never a zero total.']);
  }

  if (absentShopWeekCount > 0) {
    banners.push([absentShopWeekCount +
      ' shop-weeks present in a prior pull are absent from the latest pull — values shown are stale.']);
  }

  banners.push(['GST treatment: ' + pullGstTreatment +
    ' (gst: 0 is normal — many coffee SKUs are GST-free).']);
  // "Drift", never "stale pricing" — divergesFromLivePricing counts ordinary
  // post-invoice price changes too, so it is a drift signal, not provenance.
  // '' or undefined (the normal case since step 3 — the API exposes no
  // pricing-divergence signal) renders "not assessed", never a verdict.
  var pricingDriftText = pullDivergesRaw === true ? 'diverges' :
    (pullDivergesRaw === false ? 'matches' : 'not assessed');
  banners.push(['Pricing drift vs current live pricing: ' + pricingDriftText + '.']);
  banners.push(['Confirmed orders only; excludes Shopify/online shops. Last fetched: ' + pullFetchedAt]);

  var header = ['Shop'].concat(weeks);
  var grid = [header];
  for (var s = 0; s < shopOrder.length; s++) {
    var gridShopId = shopOrder[s];
    var gridRow = [gridShopId];
    for (var wi = 0; wi < weeks.length; wi++) {
      var cellKey = gridShopId + '||' + weeks[wi];
      gridRow.push(shopSpendReportCell_(latestIndex[cellKey], pullUnpricedSkuCount, pullEmptyRangeInvalid));
    }
    grid.push(gridRow);
  }

  // Rectangular block: pad every banner row to the grid width so a single
  // setValues() call is valid.
  var maxCols = header.length;
  var paddedBanners = banners.map(function (bannerRow) {
    var padded = bannerRow.slice();
    while (padded.length < maxCols) padded.push('');
    return padded;
  });

  return paddedBanners.concat(grid);
}

function buildShopSpendReport_impl_() {
  var ss = getHubSpreadsheet_();
  var tabs = ensureShopSpendTabs_(ss);

  var snapshotRows = tabs.data.getDataRange().getValues().slice(1); // drop header
  var pullsValues = tabs.pulls.getDataRange().getValues();
  var latestPullRow = pullsValues.length > 1 ? pullsValues[pullsValues.length - 1] : [];

  var block = shopSpendReportBlock_(snapshotRows, latestPullRow);

  // Read-modify-write, never a per-row write: a run that dies mid-rebuild
  // must not leave a visibly half-broken report.
  tabs.report.clearContents();
  if (block.length > 0) {
    tabs.report.getRange(1, 1, block.length, block[0].length).setValues(block);
  }

  return { rowsWritten: block.length };
}

/**
 * Entry point — wraps the rebuild in withScriptLock_, mirroring
 * weeklySummarize (Code.gs:1595-1606). Zero-arg safe. Never mutates
 * ShopSpend or ShopSpendPulls — read-only inputs to this report.
 */
function buildShopSpendReport() {
  var res = withScriptLock_(buildShopSpendReport_impl_);
  if (res === LOCK_TIMEOUT_) {
    Logger.log('buildShopSpendReport: could not acquire script lock — skipped this run');
    return { refused: 'locked' };
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * Watchdog (step 7) — weekly cadence, own trigger. See docs/schema.md
 * and the step 7 task file for why this cannot share STALENESS_SOURCES
 * (global 96h threshold vs a 168h cadence would false-alarm ~3 days in 7).
 * ------------------------------------------------------------------ */

/**
 * Parse a 'YYYY-Www' label strictly — unlike parseShopSpendWeekLabel_ (report
 * builder, tolerant, returns {year:0,week:0} on failure) this returns null so
 * callers can distinguish "malformed" from "week zero of year zero" and bail
 * out without walking a bogus multi-century span.
 */
function shopSpendParseWeekLabelStrict_(label) {
  var m = /^(\d{4})-W(\d{1,2})$/.exec(String(label));
  if (!m) return null;
  var week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  return { year: Number(m[1]), week: week };
}

/** ISO 8601 week label ('YYYY-Www') for a Date, via the Thursday-of-the-week rule. */
function shopSpendIsoWeekLabelForDate_(d) {
  var date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  var dayNum = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // Thursday of this ISO week
  var isoYear = date.getUTCFullYear();
  var yearStart = new Date(Date.UTC(isoYear, 0, 1));
  var weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  var weekStr = weekNo < 10 ? '0' + weekNo : String(weekNo);
  return isoYear + '-W' + weekStr;
}

/** The Monday (UTC) of a given ISO year+week. Inverse of shopSpendIsoWeekLabelForDate_. */
function shopSpendIsoWeekMonday_(isoYear, isoWeek) {
  var jan4 = new Date(Date.UTC(isoYear, 0, 4));
  var jan4Day = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  var week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  var monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (isoWeek - 1) * 7);
  return monday;
}

/**
 * Every ISO week label from fromWeek..toWeek inclusive. Recomputes the label
 * for each Monday via shopSpendIsoWeekLabelForDate_ rather than incrementing
 * the printed week number, so a span crossing a year (or W52/W53) boundary
 * still resolves correctly. Malformed/reversed input yields [], never throws.
 */
function shopSpendWeekSpan_(fromWeek, toWeek) {
  var fromParsed = shopSpendParseWeekLabelStrict_(fromWeek);
  var toParsed = shopSpendParseWeekLabelStrict_(toWeek);
  if (!fromParsed || !toParsed) return [];

  var cursor = shopSpendIsoWeekMonday_(fromParsed.year, fromParsed.week);
  var endMonday = shopSpendIsoWeekMonday_(toParsed.year, toParsed.week);
  if (isNaN(cursor.getTime()) || isNaN(endMonday.getTime()) || cursor.getTime() > endMonday.getTime()) {
    return [];
  }

  var labels = [];
  var guard = 0; // ~11.5 years of weeks — a sane upper bound, never a real span
  while (cursor.getTime() <= endMonday.getTime() && guard < 600) {
    labels.push(shopSpendIsoWeekLabelForDate_(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
    guard++;
  }
  return labels;
}

/**
 * Pure: (pullsRows) -> string[] — every ISO week label covered by any pulls
 * row, expanding each row's from_week..to_week span. Sorted, de-duplicated.
 * The ONE span parser: shopSpendWatchdogEvaluate_ and (step 8) the HTTP
 * coverage endpoint both call this rather than parsing spans themselves, so
 * they cannot drift apart on which weeks count as covered.
 */
function shopSpendCoveredWeeks_(pullsRows) {
  var rows = pullsRows || [];
  var set = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row) continue;
    var fromWeek = row[2]; // from_week
    var toWeek = row[3];   // to_week
    if (fromWeek === undefined || fromWeek === null || toWeek === undefined || toWeek === null) continue;
    var span = shopSpendWeekSpan_(fromWeek, toWeek);
    for (var j = 0; j < span.length; j++) set[span[j]] = true;
  }
  return Object.keys(set).sort(compareShopSpendWeekLabels_);
}

/** The ISO week that just closed as of nowMs — always one week back, mirroring runner.py's default_week_label. */
function shopSpendJustClosedWeekLabel_(nowMs) {
  return shopSpendIsoWeekLabelForDate_(new Date(nowMs - 7 * 86400000));
}

/**
 * Pure: (pullsRows, nowMs) -> {covered, weekLabel, lastPullMs}. Decides
 * coverage via shopSpendCoveredWeeks_ (see its comment on why); does its own
 * scan for lastPullMs, which the set helper does not carry.
 */
function shopSpendWatchdogEvaluate_(pullsRows, nowMs) {
  var rows = pullsRows || [];
  var weekLabel = shopSpendJustClosedWeekLabel_(nowMs);
  var coveredWeeks = shopSpendCoveredWeeks_(rows);
  var covered = coveredWeeks.indexOf(weekLabel) !== -1;

  var lastPullMs = null;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row) continue;
    var ms = stalenessParseTs_(row[0]); // fetched_at
    if (ms !== null && (lastPullMs === null || ms > lastPullMs)) lastPullMs = ms;
  }

  return { covered: covered, weekLabel: weekLabel, lastPullMs: lastPullMs };
}

function shopSpendWatchdogRun_(nowMs) {
  var pullsRows = [];
  try {
    var ss = getHubSpreadsheet_();
    var pullsSheet = ss.getSheetByName(SHOPSPEND_PULLS_TAB);
    if (pullsSheet) {
      pullsRows = pullsSheet.getDataRange().getValues().slice(1); // drop header
    }
  } catch (err) {
    Logger.log('shopSpendWatchdog: could not read ' + SHOPSPEND_PULLS_TAB + ' — ' + err.message);
  }

  var result = shopSpendWatchdogEvaluate_(pullsRows, nowMs);

  if (!result.covered) {
    var entry = {
      source: 'shopspend',
      ageHours: (result.lastPullMs === null) ? null : Math.round(((nowMs - result.lastPullMs) / 3600000) * 10) / 10,
      stale: true,
      lastSeenMs: result.lastPullMs
    };
    try {
      stalenessRaiseAlerts_([entry], nowMs);
    } catch (err2) {
      Logger.log('shopSpendWatchdog: stalenessRaiseAlerts_ failed — ' + err2.message);
    }
  }

  Logger.log('shopSpendWatchdog: weekLabel=' + result.weekLabel + ', covered=' + result.covered);
  return result;
}

/**
 * Trigger handler. Takes an OPTIONAL arg for testability only — guarded the
 * way resolveDateArg_ (Code.gs) guards its date arg: a time-based trigger
 * passes an event object as arg 1 (the fault that once corrupted the Sales
 * tab), so anything that isn't a plain number falls back to the real clock
 * rather than being mistaken for "now". Never throws.
 */
function shopSpendWatchdog(nowMsOverride) {
  try {
    var nowMs = (typeof nowMsOverride === 'number') ? nowMsOverride : Date.now();
    return shopSpendWatchdogRun_(nowMs);
  } catch (err) {
    Logger.log('shopSpendWatchdog: unexpected error — ' + (err && err.message));
    return { covered: null, weekLabel: null, lastPullMs: null };
  }
}

/**
 * Monday 14:00 Australia/Sydney — the afternoon after the Monday 05:00 pull,
 * so a failed pull is caught the same day. Run from the editor (Jake only);
 * never auto-installed.
 */
function installShopSpendWatchdogTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'shopSpendWatchdog') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('shopSpendWatchdog')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(14)
    .inTimezone('Australia/Sydney').create();
  Logger.log('installShopSpendWatchdogTrigger: Monday 14:00 Australia/Sydney trigger installed');
}
