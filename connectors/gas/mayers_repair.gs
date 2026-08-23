/**
 * mayers_repair.gs — one-off repair of four misfiled Mayers `location` values.
 *
 * TEMPORARY. Deleted in the cleanup step once the repair is verified. The
 * rollback path deliberately does NOT live here — restoreMayersLocationSnapshot
 * and the artifact constants are in mayers.gs, which survives this file.
 *
 * WHAT IS BROKEN. Four rows in the production `Suppliers` tab carry a wrong
 * `location`, so their spend buckets to `Other` in every consumer of the
 * `Summary` tab (including the weekly LEIBLE_GM_COST_MONITOR read):
 *
 *   2026-07-06  3437634  $703.75  'UNMAPPED: …5 BLUES ST…'  →  Leible North
 *   2026-07-20  3442003  $703.00  'UNMAPPED: …5 BLUES ST…'  →  Leible North
 *   2026-07-27  3446281  $570.15  'UNMAPPED: …5 BLUES ST…'  →  Leible North
 *   2026-06-15  3429816  $736.74  ''         (blank)        →  Leible York
 *
 * WHY A REWRITE ALONE IS NOT ENOUGH. SUMMARY_KEY_COLS includes `location`
 * (Code.gs:65) and upsertRows_ has NO delete path (Code.gs:565-605). Rewriting
 * `Suppliers` and re-summarizing therefore ADDS a row at the new location and
 * ORPHANS the old one — doGet then serves the same money twice. The stale row
 * has to be deleted explicitly, by its full key tuple.
 *
 * RUN ORDER (all from the editor Run button, which passes no arguments):
 *   1. runMayersLocationRepairDryRun()      — writes nothing; Jake approves the key list
 *   2. runMayersRepairApply_2026_06_15()    — one week per invocation, in any order
 *      runMayersRepairApply_2026_07_06()
 *      runMayersRepairApply_2026_07_20()
 *      runMayersRepairApply_2026_07_27()
 *   3. restoreMayersLocationSnapshot()      — mayers.gs; rolls back everything
 *
 * Schedule away from the 6am Australia/Sydney mayersDailyPull window: this
 * holds the script lock, and withScriptLock_ returns a sentinel rather than
 * throwing when it cannot get it.
 */

/* The exact stored literal, reproduced from the real Drive-OCR text (harvest
 * Doc 1sbid-4-Vn…, 2026-08-20). The hint is EXACTLY 60 characters after the
 * 'UNMAPPED: ' prefix, including its trailing space — slice(0,60) lands on the
 * boundary. Any `hint.length >= 60 → suspicious` gate would quarantine all
 * three North rows and turn the whole repair into a silent no-op. There is no
 * such gate here, on purpose. */
var MAYERS_UNMAPPED_NORTH_ =
  'UNMAPPED: LEIBLE COFFEE NORTH SYDNEY 5 BLUES ST NORTH SYDNEY NSW 2060 ';

/**
 * THE FROZEN WHITELIST. Approved by Jake 2026-08-20, four rows, $2,713.64.
 * Nothing outside this list is ever mutated — the tab-wide sweep below is
 * report-only (decision 5).
 */
var MAYERS_REPAIR_SET_ = [
  {
    week: '2026-06-15', ref: '3429816', total: 736.74,
    expectedLocation: '', target: 'Leible York',
    /* NOT a BLUES ST row, and the widened regex does not reach it. This
     * invoice is York: 'Deliver To: 89 YORK ST', account LEI05D — the same
     * account code as 3434688, which maps to Leible York correctly. It is
     * blank because it was ingested 2026-06-17, five days before
     * mayersShopFromText_ existed at all (ff51fab, 2026-06-22): there was no
     * location logic to run. A ref-matched exception, so its total is asserted
     * before the rewrite. An earlier read guessed this row was North; that
     * would have moved $736.74 to the wrong shop. */
    note: 'ref-matched exception — pre-dates shop attribution; York per harvest read'
  },
  { week: '2026-07-06', ref: '3437634', total: 703.75, expectedLocation: MAYERS_UNMAPPED_NORTH_, target: 'Leible North' },
  { week: '2026-07-20', ref: '3442003', total: 703.00, expectedLocation: MAYERS_UNMAPPED_NORTH_, target: 'Leible North' },
  /* Week 2026-07-27 legitimately holds a SECOND Mayers row of exactly $570.15
   * (ref 3449495 → Leible Crowsnest): identical standing orders to two shops,
   * forwarded 15 seconds apart. Nothing is double-counted today, and any
   * "no duplicate rows" check false-positives here. Assert on invoice_ref. */
  { week: '2026-07-27', ref: '3446281', total: 570.15, expectedLocation: MAYERS_UNMAPPED_NORTH_, target: 'Leible North' }
];

var MAYERS_REPAIR_KIND_ = 'spend';

/** Script-property value cap is 9KB; stay clear of it. */
var MAYERS_SNAPSHOT_MAX_CHARS_ = 8000;

/** The four weeks, oldest first. Derived, never re-typed. */
function mayersRepairWeeks_() {
  var seen = {};
  for (var i = 0; i < MAYERS_REPAIR_SET_.length; i++) seen[MAYERS_REPAIR_SET_[i].week] = true;
  return Object.keys(seen).sort();
}

/* ------------------------------------------------------------------ *
 * Entry point — ONE function, dry-run and apply behind a mode flag
 * ------------------------------------------------------------------ */

/**
 * @param {boolean} [isDryRun=true] pass exactly `false` to mutate
 *   (mirrors cleanupOnlineRevenueSummaryRows at Code.gs:1245)
 * @param {string}  [weekStart]     'yyyy-MM-dd'; REQUIRED to apply, optional
 *   to dry-run (omitted = report on all four weeks)
 * @returns {Object} report
 */
function mayersLocationRepair_(isDryRun, weekStart) {
  var dry = (isDryRun !== false);
  // resolveDateArg_ rejects anything that is not a real yyyy-MM-dd string,
  // including the event object a time-based trigger would pass as arg 1.
  var week = resolveDateArg_(weekStart, null);

  if (!dry && !week) {
    Logger.log('mayersLocationRepair_: APPLY requires an explicit week — refusing. ' +
      'Use one of the runMayersRepairApply_<week>() wrappers.');
    return { refused: 'apply-requires-week' };
  }
  if (week && mayersRepairWeeks_().indexOf(week) === -1) {
    Logger.log('mayersLocationRepair_: ' + week + ' is not one of the four approved weeks (' +
      mayersRepairWeeks_().join(', ') + ') — refusing.');
    return { refused: 'unknown-week', week: week };
  }

  var res = withScriptLock_(function () {
    return dry ? mayersRepairDryRun_(week) : mayersRepairApplyWeek_(week);
  });

  // withScriptLock_ RETURNS LOCK_TIMEOUT_ instead of throwing (Code.gs:115).
  // Unchecked, an apply that never acquired the lock reads as a clean no-op.
  if (res === LOCK_TIMEOUT_) {
    Logger.log('mayersLocationRepair_: could not acquire the script lock — NOTHING ran. ' +
      'The 6am mayersDailyPull is the likely holder; re-run outside that window.');
    return { refused: 'locked', mode: dry ? 'dryRun' : 'apply', week: week };
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * Shared assessment — ONE matcher, used by the dry run AND the apply
 * preflight. If these two ever diverge, Jake approves one thing and the
 * apply does another.
 * ------------------------------------------------------------------ */

/**
 * @returns {{week:string, rows:Object[], staleKeys:Object[], targetKeys:Object[],
 *            ok:boolean, problems:string[]}}
 */
function mayersRepairAssessWeek_(suppData, summData, week) {
  var problems = [];
  var rows = [];
  var snap = mayersRepairLoadSnapshot_(week);

  if (snap && snap.corrupt) {
    problems.push('snapshot ' + mayersRepairSnapshotKey_(week) + ' is CORRUPT — ' +
      'an absent snapshot means "safe first run" and this is the opposite of that');
  }

  for (var i = 0; i < MAYERS_REPAIR_SET_.length; i++) {
    var entry = MAYERS_REPAIR_SET_[i];
    if (entry.week !== week) continue;

    var found = null;
    for (var r = 1; r < suppData.length; r++) {
      if (mayersNorm_(suppData[r][5]) !== 'mayers') continue;
      if (mayersNorm_(suppData[r][3]) !== mayersNorm_(entry.ref)) continue;
      found = { rowNumber: r + 1, values: suppData[r] };
      break;
    }

    if (!found) {
      problems.push('ref ' + entry.ref + ': no mayers row found in ' + SUPPLIERS_TAB);
      rows.push({ ref: entry.ref, found: false, state: 'missing' });
      continue;
    }

    var liveLocation = String(found.values[4]);
    var liveTotal = Number(found.values[2]);
    var liveDate = coerceDateStr_(found.values[0]);
    var liveWeek = weekStartForDate_(liveDate);
    var department = found.values[7] ? String(found.values[7]) : DEFAULT_DEPARTMENT;
    var supplier = String(found.values[1]);

    /* Three legal states, and nothing else:
     *   pending  — live location is exactly the approved stale value (first run)
     *   repaired — live location is the target AND a snapshot records the
     *              original, i.e. this week is being resumed
     *   mismatch — anything else. Someone or something moved this row since the
     *              dry run Jake approved; stop rather than guess. */
    var state;
    if (mayersNorm_(liveLocation) === mayersNorm_(entry.expectedLocation)) {
      state = 'pending';
    } else if (mayersNorm_(liveLocation) === mayersNorm_(entry.target) &&
               mayersSnapshotHasRef_(snap, entry.ref)) {
      state = 'repaired';
    } else {
      state = 'mismatch';
      problems.push('ref ' + entry.ref + ': location is ' + JSON.stringify(liveLocation) +
        ', expected ' + JSON.stringify(entry.expectedLocation) +
        (mayersNorm_(liveLocation) === mayersNorm_(entry.target)
          ? ' (it is already at the target, but no snapshot records the original — ' +
            'this was NOT repaired by this function)'
          : ''));
    }

    // The blank-location row carries no stored hint to identify it by, so its
    // amount is the only corroboration that we have the right row.
    if (liveTotal !== entry.total) {
      problems.push('ref ' + entry.ref + ': total is ' + liveTotal + ', expected ' + entry.total);
    }
    if (liveWeek !== entry.week) {
      problems.push('ref ' + entry.ref + ': date ' + liveDate + ' falls in week ' + liveWeek +
        ', expected ' + entry.week);
    }

    rows.push({
      ref: entry.ref, found: true, state: state, rowNumber: found.rowNumber,
      date: liveDate, weekOfRow: liveWeek,
      liveLocation: liveLocation, liveLocationLength: liveLocation.length,
      expectedLocation: entry.expectedLocation, target: entry.target,
      liveTotal: liveTotal, expectedTotal: entry.total,
      supplier: supplier, department: department,
      note: entry.note || ''
    });
  }

  if (!rows.length) problems.push('week ' + week + ' matched no whitelist entries');

  return {
    week: week,
    rows: rows,
    staleKeys: mayersRepairKeys_(week, rows, 'expectedLocation'),
    targetKeys: mayersRepairKeys_(week, rows, 'target'),
    ok: problems.length === 0,
    problems: problems
  };
}

/** Did the snapshot capture this invoice_ref? (i.e. is this a genuine resume) */
function mayersSnapshotHasRef_(snap, ref) {
  if (!snap || !snap.rows) return false;
  for (var i = 0; i < snap.rows.length; i++) {
    if (mayersNorm_(snap.rows[i].invoice_ref) === mayersNorm_(ref)) return true;
  }
  return false;
}

/**
 * Collapse the week's rows into DISTINCT Summary key tuples on `which`
 * location field. Grouping mirrors aggregateSupplierRows_ (Code.gs:1685):
 * department || kind || supplier || location, with department defaulting to
 * DEFAULT_DEPARTMENT on a blank cell exactly as it does there.
 */
function mayersRepairKeys_(week, rows, which) {
  var byKey = {};
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i].found) continue;
    var location = rows[i][which];
    var k = rows[i].department + '||' + MAYERS_REPAIR_KIND_ + '||' + rows[i].supplier + '||' + location;
    if (byKey[k]) { byKey[k].refs.push(rows[i].ref); continue; }
    byKey[k] = {
      week_start: week,
      department: rows[i].department,
      kind: MAYERS_REPAIR_KIND_,
      supplier: rows[i].supplier,
      location: location,
      refs: [rows[i].ref]
    };
    out.push(byKey[k]);
  }
  return out;
}

/** Attach live Summary state to a key list: which rows match it, and their totals. */
function mayersAnnotateKeys_(summData, keys) {
  var out = [];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var keyRow = mayersSummaryKeyRow_(k.week_start, k.department, k.kind, k.supplier, k.location);
    var hits = mayersFindSummaryRows_(summData, keyRow);
    var totals = [];
    for (var h = 0; h < hits.length; h++) totals.push(Number(summData[hits[h] - 1][SUMMARY_TOTAL_COL]));
    out.push({
      week_start: k.week_start, department: k.department, kind: k.kind,
      supplier: k.supplier, location: k.location, refs: k.refs,
      keyTuple: rowKey_(keyRow, SUMMARY_KEY_COLS),
      matchedRows: hits, matchedCount: hits.length, matchedTotals: totals
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Dry run — writes NOTHING
 * ------------------------------------------------------------------ */

function mayersRepairDryRun_(week) {
  var ss = getHubSpreadsheet_();
  var suppSheet = ss.getSheetByName(SUPPLIERS_TAB);
  var summSheet = ss.getSheetByName(SUMMARY_TAB);
  if (!suppSheet) return { refused: 'no-suppliers-tab' };
  if (!summSheet) return { refused: 'no-summary-tab' };

  var suppData = suppSheet.getDataRange().getValues();
  var summData = summSheet.getDataRange().getValues();
  var revSheet = ss.getSheetByName(REVENUE_TAB);
  var revData = revSheet ? revSheet.getDataRange().getValues() : [REVENUE_HEADERS];

  var weeks = week ? [week] : mayersRepairWeeks_();
  var report = {
    mode: 'dryRun',
    generatedAt: Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    weeks: [],
    sweep: mayersSweepUnresolved_(suppData),
    allOk: true
  };

  for (var i = 0; i < weeks.length; i++) {
    var w = weeks[i];
    var assess = mayersRepairAssessWeek_(suppData, summData, w);
    var stale = mayersAnnotateKeys_(summData, assess.staleKeys);
    var target = mayersAnnotateKeys_(summData, assess.targetKeys);

    /* Every approved stale key must match EXACTLY ONE Summary row. Zero means
     * the apply's count assertion will abort; two means an existing duplicate
     * that has to be understood before anything is deleted. */
    var staleCountOk = true;
    for (var s = 0; s < stale.length; s++) if (stale[s].matchedCount !== 1) staleCountOk = false;

    var weekReport = {
      week: w,
      rows: assess.rows,
      staleSummaryKeys: stale,
      staleSummaryRowsToDelete: stale.reduce(function (n, k) { return n + k.matchedCount; }, 0),
      staleCountOk: staleCountOk,
      /* Target-key PRE-STATE. upsertRows_ returns counts, not keys
       * (Code.gs:604), so at apply time the function cannot tell an add from an
       * update. The abort and rollback paths restore THIS recorded state rather
       * than assuming the target row was absent. */
      targetSummaryKeys: target,
      drift: mayersRepairDrift_(suppData, revData, summData, w),
      preflightOk: assess.ok && staleCountOk,
      problems: assess.problems
    };
    if (!weekReport.preflightOk) report.allOk = false;
    report.weeks.push(weekReport);
  }

  Logger.log('DRY RUN (nothing written): ' + JSON.stringify(report, null, 2));
  Logger.log('mayersRepairDryRun_: allOk=' + report.allOk +
    ' — Jake must approve the staleSummaryKeys[].keyTuple list above before any apply runs.');
  return report;
}

/**
 * Decision 5: scan the WHOLE Suppliers tab, every source, every week, for a
 * blank or 'UNMAPPED:' location. Scanning is read-only and near-free, and the
 * known rows came from a single two-week probe window — a figure from one
 * bounded window is a lower bound, never a census.
 *
 * REPORT-ONLY for anything outside the frozen whitelist.
 */
function mayersSweepUnresolved_(suppData) {
  var unresolved = [];
  for (var r = 1; r < suppData.length; r++) {
    var location = String(suppData[r][4]);
    var isBlank = location.trim() === '';
    var isUnmapped = location.indexOf('UNMAPPED:') === 0;
    if (!isBlank && !isUnmapped) continue;

    var ref = String(suppData[r][3]);
    var source = String(suppData[r][5]);
    var inSet = false;
    for (var i = 0; i < MAYERS_REPAIR_SET_.length; i++) {
      if (mayersNorm_(source) === 'mayers' && mayersNorm_(MAYERS_REPAIR_SET_[i].ref) === mayersNorm_(ref)) inSet = true;
    }

    unresolved.push({
      rowNumber: r + 1,
      date: coerceDateStr_(suppData[r][0]),
      week: weekStartForDate_(coerceDateStr_(suppData[r][0])),
      supplier: String(suppData[r][1]),
      total: Number(suppData[r][2]),
      invoice_ref: ref,
      source: source,
      location: location,
      kindOfGap: isBlank ? 'blank' : 'unmapped',
      inRepairSet: inSet,
      disposition: inSet ? 'REPAIR' : 'report-only'
    });
  }

  var reportOnly = unresolved.filter(function (u) { return !u.inRepairSet; });
  return {
    scannedRows: Math.max(0, suppData.length - 1),
    unresolvedCount: unresolved.length,
    inRepairSet: unresolved.length - reportOnly.length,
    reportOnlyCount: reportOnly.length,
    reportOnlyTotal: Math.round(reportOnly.reduce(function (n, u) { return n + u.total; }, 0) * 100) / 100,
    rows: unresolved
  };
}

/**
 * What the re-summarize would move that is NOT the Mayers repair, computed
 * read-only, so Jake sees it BEFORE approving instead of after it has landed.
 *
 * weeklySummarize('<week>') rebuilds the WHOLE week from Suppliers + Revenue
 * (Code.gs:1804-1824). upsertRows_ updates any existing row whose recomputed
 * total differs (Code.gs:595) and appends one for any group that has none
 * (Code.gs:583-585). These four historical weeks would otherwise never be
 * re-summarized, so any drift accumulated since they were first summarized
 * lands now — and Summary has a weekly external consumer.
 */
function mayersRepairDrift_(suppData, revData, summData, week) {
  var weekEnd = addDaysStr_(week, 6);
  var recomputed = aggregateSupplierRows_(suppData.slice(1), week, weekEnd, 'spend')
    .concat(aggregateSupplierRows_(revData.slice(1), week, weekEnd, 'revenue'));

  var liveByKey = {};
  for (var r = 1; r < summData.length; r++) {
    if (coerceDateStr_(summData[r][0]) !== week) continue;
    liveByKey[rowKey_(summData[r], SUMMARY_KEY_COLS)] = {
      supplier: String(summData[r][2]), location: String(summData[r][3]),
      department: String(summData[r][6]), kind: String(summData[r][7]),
      total: Number(summData[r][SUMMARY_TOTAL_COL]), rowNumber: r + 1
    };
  }

  var entries = [];
  var seen = {};
  for (var i = 0; i < recomputed.length; i++) {
    var g = recomputed[i];
    var keyRow = mayersSummaryKeyRow_(week, g.department, g.kind, g.supplier, g.location);
    var key = rowKey_(keyRow, SUMMARY_KEY_COLS);
    seen[key] = true;
    var live = liveByKey[key];
    var action;
    if (!live) action = 'will-be-ADDED';
    else if (Math.round(live.total * 100) !== Math.round(g.total * 100)) action = 'will-be-UPDATED';
    else action = 'unchanged';
    if (action === 'unchanged') continue;

    entries.push({
      keyTuple: key, supplier: g.supplier, location: g.location,
      department: g.department, kind: g.kind,
      liveTotal: live ? live.total : null, recomputedTotal: g.total,
      action: action, classification: mayersClassifyDrift_(g.supplier, g.location)
    });
  }

  /* Live rows with no recomputed counterpart are NOT touched by upsertRows_ —
   * it only ever adds or updates keys it computed. Reported so the Bennetts
   * $14,219 row at location='' is visibly accounted for rather than merely
   * absent from the diff. */
  var liveOnly = [];
  var liveKeys = Object.keys(liveByKey);
  for (var k = 0; k < liveKeys.length; k++) {
    if (seen[liveKeys[k]]) continue;
    var lo = liveByKey[liveKeys[k]];
    liveOnly.push({
      keyTuple: liveKeys[k], supplier: lo.supplier, location: lo.location,
      department: lo.department, kind: lo.kind, liveTotal: lo.total,
      action: 'untouched (pull-owned or historical — upsertRows_ never sees this key)',
      classification: mayersClassifyDrift_(lo.supplier, lo.location)
    });
  }

  var nonMayers = entries.filter(function (e) { return e.classification === 'NON-MAYERS DRIFT'; });
  return {
    week: week,
    changes: entries,
    liveOnly: liveOnly,
    nonMayersDriftCount: nonMayers.length,
    nonMayersDriftTotal: Math.round(nonMayers.reduce(function (n, e) {
      return n + ((e.recomputedTotal || 0) - (e.liveTotal || 0));
    }, 0) * 100) / 100
  };
}

/**
 * Labour is PRE-CLASSIFIED as expected drift: weeklySummarize re-runs
 * labourWeeklyPull_ on every override call (Code.gs:1828) against a live
 * external sheet, so it moves legitimately. Without this, the very first firing
 * of the "surface it to Jake" gate is a false alarm and desensitises it.
 */
function mayersClassifyDrift_(supplier, location) {
  var s = mayersNorm_(supplier);
  if (s === 'labour') return 'expected — labourWeeklyPull_ re-reads a live external sheet';
  if (s === 'mayers') return 'expected — this repair';
  if (s === 'shopify_orderapp') return 'pull-owned — written directly to Summary, not derived';
  return 'NON-MAYERS DRIFT';
}

/* ------------------------------------------------------------------ *
 * Apply — one week per invocation, steps 1-7 back to back
 *
 * The window between step 5 (re-summarize) and step 6 (delete) is a
 * deliberate, VISIBLE double-count: a crash there leaves money showing twice,
 * which is recoverable, rather than missing, which may not be. Never leave a
 * week half-done across a break.
 * ------------------------------------------------------------------ */

function mayersRepairApplyWeek_(week) {
  var ss = getHubSpreadsheet_();
  var suppSheet = ss.getSheetByName(SUPPLIERS_TAB);
  var summSheet = ss.getSheetByName(SUMMARY_TAB);
  if (!suppSheet || !summSheet) return { mode: 'apply', week: week, refused: 'missing-tab' };

  var revSheet = ss.getSheetByName(REVENUE_TAB);
  var suppData = suppSheet.getDataRange().getValues();
  var summData = summSheet.getDataRange().getValues();
  var revData = revSheet ? revSheet.getDataRange().getValues() : [REVENUE_HEADERS];

  /* --- step 2: preflight ------------------------------------------------ */
  var assess = mayersRepairAssessWeek_(suppData, summData, week);
  if (!assess.ok) {
    Logger.log('mayersRepairApplyWeek_: PREFLIGHT FAILED for ' + week + ' — ' +
      JSON.stringify(assess.problems) + '. Nothing written. Re-run the dry run and re-approve.');
    return { mode: 'apply', week: week, aborted: 'preflight', problems: assess.problems };
  }

  var stale = mayersAnnotateKeys_(summData, assess.staleKeys);
  var target = mayersAnnotateKeys_(summData, assess.targetKeys);

  /* --- step 3: snapshot, write-once per week ---------------------------- */
  var snapshot = {
    week: week,
    capturedAt: Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    rows: assess.rows.map(function (r) {
      return {
        invoice_ref: r.ref,
        // The ORIGINAL location, taken from the frozen whitelist rather than
        // from the live cell: on a resume the live cell already holds the
        // target, and a snapshot of that is not a rollback artifact.
        location: r.expectedLocation,
        total: r.expectedTotal, date: r.date,
        department: r.department, supplier: r.supplier
      };
    }),
    staleKeys: assess.staleKeys,
    targetKeys: target.map(function (t) {
      return {
        department: t.department, kind: t.kind, supplier: t.supplier, location: t.location,
        existedBefore: t.matchedCount > 0,
        totalBefore: t.matchedCount > 0 ? t.matchedTotals[0] : null
      };
    }),
    // Pre-mutation copy of the week's Summary rows, so step 7 can verify
    // non-Mayers money is untouched without reaching outside GAS. The Phase 5
    // check against downloads/mayers-repair-baseline-*.json is the independent
    // second opinion, not a substitute for this one.
    summaryBefore: mayersWeekSummaryRows_(summData, week)
  };

  var encoded = JSON.stringify(snapshot);
  if (encoded.length > MAYERS_SNAPSHOT_MAX_CHARS_) {
    Logger.log('mayersRepairApplyWeek_: WARNING snapshot for ' + week + ' is ' + encoded.length +
      ' chars, over the ' + MAYERS_SNAPSHOT_MAX_CHARS_ + ' guard — dropping summaryBefore to ' +
      'stay under the 9KB property cap. Step 7 will skip the non-Mayers check; verify ' +
      'against the Phase 3 baseline file instead.');
    snapshot.summaryBefore = null;
  }

  var saved = mayersRepairSaveSnapshot_(week, snapshot);
  // On a resume the ORIGINAL snapshot governs every later step — it is the one
  // that recorded the true pre-repair state.
  var governing = saved.written ? snapshot : mayersRepairLoadSnapshot_(week);
  if (!governing || governing.corrupt) {
    Logger.log('mayersRepairApplyWeek_: cannot read a usable snapshot for ' + week + ' — aborting ' +
      'BEFORE any mutation. There is no rollback artifact, so nothing may be changed.');
    return { mode: 'apply', week: week, aborted: 'snapshot-unusable' };
  }

  /* --- step 4: rewrite the Suppliers location cells --------------------- */
  var rewritten = 0;
  for (var i = 0; i < assess.rows.length; i++) {
    var row = assess.rows[i];
    if (row.state === 'repaired') continue;          // resume: already at target
    suppSheet.getRange(row.rowNumber, 5).setValue(row.target);
    rewritten++;
  }
  Logger.log('mayersRepairApplyWeek_: ' + week + ' step 4 — rewrote ' + rewritten + ' location cell(s)');

  /* --- step 5: re-summarize FIRST, so a crash leaves a VISIBLE double-count
   * rather than missing money. Override form: the bare form does only the last
   * completed week and fires archiveAndPurge_. -------------------------- */
  var res = weeklySummarize(week);
  if (!(res && !res.refused && res.weekStart === week)) {
    /* Deliberately NOT asserting on summariesAdded + summariesUpdated. Both
     * refusal paths make that sum NaN, and upsertRows_ counts an unchanged
     * amount as duplicatesSkipped — so a correct recovery re-run legitimately
     * returns 0/0 and would read as failure. */
    Logger.log('mayersRepairApplyWeek_: re-summarize did not succeed for ' + week + ' — ' +
      JSON.stringify(res) + '. Unwinding the whole week.');
    var unwound5 = mayersRestoreWeek_(week);
    return {
      mode: 'apply', week: week, aborted: 'resummarize',
      resummarizeResult: res, unwind: unwound5
    };
  }

  /* --- step 6: back up, then delete the stale rows ---------------------- */
  summData = summSheet.getDataRange().getValues();
  var staleNow = mayersAnnotateKeys_(summData, governing.staleKeys);
  var targetNow = mayersAnnotateKeys_(summData, assess.targetKeys);

  var totalStaleHits = 0, keysWithOne = 0, keysWithZero = 0;
  for (var k = 0; k < staleNow.length; k++) {
    totalStaleHits += staleNow[k].matchedCount;
    if (staleNow[k].matchedCount === 1) keysWithOne++;
    if (staleNow[k].matchedCount === 0) keysWithZero++;
  }
  var targetsPresent = targetNow.every(function (t) { return t.matchedCount === 1; });

  var deleted = 0;
  var backedUp = 0;
  var alreadyApplied = false;

  if (keysWithOne === staleNow.length) {
    // Back up EVERY matched row before the first deleteRow. A half-backed-up
    // delete is worse than no repair at all.
    var backup = ensureSheet(ss, MAYERS_REPAIR_BACKUP_TAB, SUMMARY_HEADERS);
    var toDelete = [];
    for (var b = 0; b < staleNow.length; b++) {
      for (var h = 0; h < staleNow[b].matchedRows.length; h++) {
        var rowNum = staleNow[b].matchedRows[h];
        backup.appendRow(summData[rowNum - 1]);
        backedUp++;
        toDelete.push(rowNum);
      }
    }
    Logger.log('mayersRepairApplyWeek_: ' + week + ' step 6 — backed up ' + backedUp +
      ' row(s) to ' + MAYERS_REPAIR_BACKUP_TAB + ' before deleting anything');

    toDelete.sort(function (a, b2) { return a - b2; });
    for (var d = toDelete.length - 1; d >= 0; d--) { summSheet.deleteRow(toDelete[d]); deleted++; }

  } else if (keysWithZero === staleNow.length && targetsPresent) {
    // Resume of a week whose delete already succeeded. Aborting here would
    // unwind a CORRECT repair, which is the worst outcome available.
    alreadyApplied = true;
    Logger.log('mayersRepairApplyWeek_: ' + week + ' step 6 — stale rows already gone and every ' +
      'target row present. This week was already applied; skipping to verification.');

  } else {
    Logger.log('mayersRepairApplyWeek_: ' + week + ' step 6 ABORT — matched ' + totalStaleHits +
      ' stale Summary row(s) across ' + staleNow.length + ' approved key(s), expected exactly one ' +
      'each. NOT adjusting the count to match. Unwinding the whole week; re-run the dry run and ' +
      're-approve.');
    var unwound6 = mayersRestoreWeek_(week);
    return {
      mode: 'apply', week: week, aborted: 'stale-count-mismatch',
      staleKeys: staleNow, unwind: unwound6
    };
  }

  /* --- step 7: verify --------------------------------------------------- */
  summData = summSheet.getDataRange().getValues();
  var verification = mayersRepairVerifyWeek_(summData, governing, assess, week);

  var result = {
    mode: 'apply', week: week,
    locationsRewritten: rewritten,
    resummarize: res,
    summaryRowsBackedUp: backedUp,
    summaryRowsDeleted: deleted,
    alreadyApplied: alreadyApplied,
    verification: verification
  };

  if (!verification.ok) {
    Logger.log('mayersRepairApplyWeek_: ' + week + ' VERIFICATION FAILED — ' +
      JSON.stringify(verification, null, 2) +
      '\nNOT auto-unwinding: look first. To roll this week back run ' +
      "restoreMayersLocationSnapshot('" + week + "').");
  } else {
    Logger.log('mayersRepairApplyWeek_: ' + week + ' OK — ' + JSON.stringify(result, null, 2));
  }
  return result;
}

/** The week's Summary rows in a compact form, for the snapshot. */
function mayersWeekSummaryRows_(summData, week) {
  var out = [];
  for (var r = 1; r < summData.length; r++) {
    if (coerceDateStr_(summData[r][0]) !== week) continue;
    out.push([String(summData[r][2]), String(summData[r][3]),
      Number(summData[r][SUMMARY_TOTAL_COL]), String(summData[r][6]), String(summData[r][7])]);
  }
  return out;
}

/**
 * Post-conditions for one applied week.
 *
 * SUM the target-location Mayers rows — never assume one. Week 2026-07-27
 * legitimately carries two Mayers rows of $570.15 at different shops.
 * Compare Mayers-only week totals, never week GRAND totals: weeklySummarize
 * re-runs labourWeeklyPull_ against a live external sheet, so the grand total
 * moves legitimately and would false-alarm every time.
 */
function mayersRepairVerifyWeek_(summData, governing, assess, week) {
  var problems = [];

  // 1. Every target key holds exactly one row, summing to the expected amount.
  var target = mayersAnnotateKeys_(summData, assess.targetKeys);
  var targetChecks = [];
  for (var t = 0; t < target.length; t++) {
    var expected = 0;
    for (var i = 0; i < assess.rows.length; i++) {
      if (assess.rows[i].target === target[t].location) expected += assess.rows[i].expectedTotal;
    }
    var got = target[t].matchedTotals.reduce(function (n, v) { return n + v; }, 0);
    var ok = target[t].matchedCount === 1 && Math.round(got * 100) === Math.round(expected * 100);
    if (!ok) {
      problems.push('target ' + target[t].location + ': ' + target[t].matchedCount +
        ' row(s) totalling ' + got + ', expected 1 row totalling ' + expected);
    }
    targetChecks.push({ location: target[t].location, rows: target[t].matchedCount, total: got, expected: expected, ok: ok });
  }

  // 2. Nothing left at the old locations.
  var stale = mayersAnnotateKeys_(summData, governing.staleKeys);
  var staleRemaining = 0;
  for (var s = 0; s < stale.length; s++) staleRemaining += stale[s].matchedCount;
  if (staleRemaining !== 0) problems.push(staleRemaining + ' stale Summary row(s) still present');

  // 3. Mayers money for the week is unchanged — moved, not created or lost.
  var before = null, after = 0;
  if (governing.summaryBefore) {
    before = 0;
    for (var b = 0; b < governing.summaryBefore.length; b++) {
      if (mayersNorm_(governing.summaryBefore[b][0]) === 'mayers') before += Number(governing.summaryBefore[b][2]);
    }
  }
  var nowRows = mayersWeekSummaryRows_(summData, week);
  for (var n = 0; n < nowRows.length; n++) {
    if (mayersNorm_(nowRows[n][0]) === 'mayers') after += Number(nowRows[n][2]);
  }
  var mayersTotalOk = (before === null) || Math.round(before * 100) === Math.round(after * 100);
  if (!mayersTotalOk) problems.push('Mayers week total moved: ' + before + ' → ' + after);

  // 4. Every NON-Mayers row still matches the pre-mutation snapshot.
  var nonMayersDiffs = [];
  if (governing.summaryBefore) {
    var beforeMap = {};
    for (var x = 0; x < governing.summaryBefore.length; x++) {
      var rb = governing.summaryBefore[x];
      if (mayersNorm_(rb[0]) === 'mayers') continue;
      beforeMap[mayersNorm_(rb[0]) + '||' + mayersNorm_(rb[1]) + '||' + mayersNorm_(rb[3]) + '||' + mayersNorm_(rb[4])] = Number(rb[2]);
    }
    var afterMap = {};
    for (var y = 0; y < nowRows.length; y++) {
      var ra = nowRows[y];
      if (mayersNorm_(ra[0]) === 'mayers') continue;
      afterMap[mayersNorm_(ra[0]) + '||' + mayersNorm_(ra[1]) + '||' + mayersNorm_(ra[3]) + '||' + mayersNorm_(ra[4])] = Number(ra[2]);
    }
    var allKeys = Object.keys(beforeMap);
    for (var z = 0; z < Object.keys(afterMap).length; z++) {
      var ak = Object.keys(afterMap)[z];
      if (allKeys.indexOf(ak) === -1) allKeys.push(ak);
    }
    for (var q = 0; q < allKeys.length; q++) {
      var kk = allKeys[q];
      var bv = beforeMap[kk] === undefined ? null : beforeMap[kk];
      var av = afterMap[kk] === undefined ? null : afterMap[kk];
      if (bv !== null && av !== null && Math.round(bv * 100) === Math.round(av * 100)) continue;
      nonMayersDiffs.push({ key: kk, before: bv, after: av });
    }
    if (nonMayersDiffs.length) {
      /* Drift the re-summarize surfaced. Report it for explicit sign-off — do
       * NOT accept it silently, and do NOT auto-unwind: Labour moves
       * legitimately on every override call. */
      problems.push(nonMayersDiffs.length + ' non-Mayers Summary row(s) changed — needs sign-off');
    }
  }

  return {
    ok: problems.length === 0,
    targetChecks: targetChecks,
    staleRowsRemaining: staleRemaining,
    mayersWeekTotalBefore: before,
    mayersWeekTotalAfter: Math.round(after * 100) / 100,
    mayersWeekTotalOk: mayersTotalOk,
    nonMayersDiffs: nonMayersDiffs,
    problems: problems
  };
}

/* ------------------------------------------------------------------ *
 * Zero-arg editor wrappers.
 *
 * The Apps Script Run button passes NO arguments, so mayersLocationRepair_(
 * false, '2026-07-06') is unreachable from the editor without one of these —
 * an unwrapped call would silently dry-run. They also Logger.log their report,
 * because the editor shows log output but NOT return values.
 *
 * Explicit per-week wrappers rather than a cursor property: the week being
 * mutated is visible in the name Jake clicks, and a mis-click repeats a week
 * (idempotent) instead of silently advancing past one.
 * ------------------------------------------------------------------ */

function runMayersLocationRepairDryRun() {
  var report = mayersLocationRepair_();
  Logger.log('DRY RUN COMPLETE (nothing written). allOk=' + report.allOk);
  return report;
}

function runMayersRepairApply_2026_06_15() { return mayersRepairApplyWrapper_('2026-06-15'); }
function runMayersRepairApply_2026_07_06() { return mayersRepairApplyWrapper_('2026-07-06'); }
function runMayersRepairApply_2026_07_20() { return mayersRepairApplyWrapper_('2026-07-20'); }
function runMayersRepairApply_2026_07_27() { return mayersRepairApplyWrapper_('2026-07-27'); }

function mayersRepairApplyWrapper_(week) {
  var report = mayersLocationRepair_(false, week);
  Logger.log('APPLY ' + week + ': ' + JSON.stringify(report, null, 2));
  return report;
}
