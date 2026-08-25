/**
 * summary_drift_repair.gs — close the Summary drift for the weeks a
 * re-summarize can still safely rebuild (2026-08-24).
 *
 * TEMPORARY. Delete once the repaired weeks are verified, like
 * backfill_resummarize.gs before it.
 *
 * WHY THIS EXISTS. `Summary` is written once per week and never revisited, so
 * anything landing in `Suppliers` after a week was summarized never reaches it
 * — and `Summary` is what doGet serves and every report reads.
 * auditSummaryDrift() measured the damage on 2026-08-24: $148,214.34 missing
 * across 41 of 50 completed weeks, 205 rows absent, 0 stale. Those rows read
 * $0 in every report.
 *
 * SCOPE (Jake, 2026-08-24): the weeks still rebuildable from `Suppliers` only.
 * The weeks whose source has been purged to `_archive` are deliberately left
 * alone — they need a repair that aggregates from `_archive`, which is a
 * separate decision.
 *
 * The Apps Script Run button passes NO arguments, so weeklySummarize('2026-02-23')
 * is unreachable from the editor: called unwrapped it silently summarizes last
 * week instead of the week asked for. Hence the zero-arg wrappers below.
 *
 *   Run:  runSummaryDriftRepairDryRun()   — read-only, decides and explains
 *         runSummaryDriftRepair()         — applies it
 *         auditSummaryDrift()             — the independent verdict, after
 *
 * SELF-TARGETING, NOT A HARDCODED LIST. The set of repairable weeks changes
 * every time archiveAndPurge_ runs, so a week list copied into this file would
 * start decaying the day it was written. The plan is recomputed from the live
 * audit on every call.
 *
 * Idempotent for the totals it writes — upsertRows_ updates a changed total and
 * counts an unchanged one as duplicatesSkipped, so a second run recomputes the
 * same numbers. But every run also writes a SNAPSHOT-ONCE backup (healWeek_):
 * only the FIRST heal of a given week is captured, so re-running this can never
 * poison the undo with a post-heal value — the backup always stays the true
 * pre-heal baseline. Re-run freely; just don't expect a second backup snapshot.
 */

/* The single most important rule in this file.
 *
 * A week can have rows in BOTH `Suppliers` and `_archive` — archiveAndPurge_
 * purges by ROW DATE against a 183-day cutoff, and a week spans seven days, so
 * the cutoff falls mid-week for exactly one week at any moment. Re-ingestion
 * after an archive run does it too (see the 2026-07-20 _archive double-count).
 *
 * weeklySummarize_impl_ recomputes from `Suppliers` ONLY (Code.gs: `var allData
 * = suppSheet.getDataRange().getValues()`), and Summary now UPSERTS. So on a
 * split week, a supplier@shop group loses its archived invoices, and the upsert
 * OVERWRITES the live Summary row with the partial total.
 *
 * That turns missing money into UNDERSTATED money, which is strictly worse: a
 * missing row is visibly $0 and shows up in this very audit, while a quietly
 * reduced row looks like a real figure. A fully-archived week is harmless by
 * comparison — it recomputes an empty set and writes nothing.
 *
 * Therefore the predicate is NOT the audit's `sourceRowsStillPresent` (which
 * only asks whether ANY row survives in Suppliers). It is: the week has NO rows
 * in `_archive` at all. */
/* The oldest week this repair is authorised to touch (Jake, 2026-08-25).
 *
 * The approved scope is the post-purge-line block 2026-02-23 → 2026-06-22: the
 * weeks that were drifting on their own merits, before the accidental backfill.
 *
 * Everything older is three years of Ordermentum invoice history that arrived
 * on 2026-08-25 via a POST the connector reported as FAILED (see 0bd2521), was
 * only completed by a manual re-run, and that nobody has reviewed. It is very
 * likely real and worth ~$163k more — but "probably real" is not the standard
 * for writing figures into the tab every report reads. Widening this constant
 * is a deliberate decision, not a default.
 *
 * Its old end is also knowingly truncated: INVOICE_PAGE_LIMIT=40 cut one
 * supplier off mid-history, so the earliest weeks would be written looking
 * complete while missing invoices nobody has counted. */
var SUMMARY_REPAIR_MIN_WEEK_ = '2026-02-23';

function summaryRepairWeekPresence_(rows) {
  var present = {};
  for (var i = 0; i < rows.length; i++) {
    var d = coerceDateStr_(rows[i][0]);
    if (!DATE_ARG_RE.test(d)) continue;
    present[weekStartForDate_(d)] = true;
  }
  return present;
}

/**
 * Decide, per drifted week, whether a re-summarize can safely close it.
 * Read-only — runs the audit and reads two tabs, writes nothing.
 *
 * @returns {Object} plan
 */
function summaryDriftRepairPlan_() {
  var ss = getHubSpreadsheet_();
  var suppSheet = ss.getSheetByName(SUPPLIERS_TAB);
  var archSheet = ss.getSheetByName(ARCHIVE_TAB);

  var inSuppliers = summaryRepairWeekPresence_(
    suppSheet ? suppSheet.getDataRange().getValues().slice(1) : []);
  var inArchive = summaryRepairWeekPresence_(
    archSheet ? archSheet.getDataRange().getValues().slice(1) : []);

  var report = auditSummaryDrift_(false);
  if (report.error) return { error: report.error };

  var plan = {
    generatedAt: Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    audited: report.weeksAudited,
    drifted: report.weeksDrifted,
    totalDrift: report.netUnderreported,
    repair: [],
    skipped: [],
    repairMoney: 0,
    skippedMoney: 0
  };

  for (var i = 0; i < report.weeks.length; i++) {
    var w = report.weeks[i];
    var entry = {
      week: w.week, net: w.net,
      missing: w.missing, stale: w.stale, summaryOnly: w.summaryOnly,
      inSuppliers: inSuppliers[w.week] === true,
      inArchive: inArchive[w.week] === true
    };

    /* A recompute can add a missing row and correct a stale one. It has NO
     * delete path, so a week whose only finding is a Summary-side orphan is
     * untouchable here — calling weeklySummarize on it would report success
     * having changed nothing, which reads as "orphan fixed". */
    if (w.missing + w.stale === 0) {
      entry.reason = 'orphan-only — a recompute has no delete path, nothing to rebuild';
      plan.skipped.push(entry);
      plan.skippedMoney += w.net;
      continue;
    }

    // THE GUARD. See the block comment above.
    if (entry.inArchive && entry.inSuppliers) {
      entry.reason = 'SPLIT across Suppliers and _archive — a recompute would UNDERSTATE the week';
      plan.skipped.push(entry);
      plan.skippedMoney += w.net;
      continue;
    }

    if (entry.inArchive) {
      entry.reason = 'past the purge line — source is in _archive, a recompute reads an empty set';
      plan.skipped.push(entry);
      plan.skippedMoney += w.net;
      continue;
    }

    /* THE APPROVED WINDOW. Checked LAST, so the safety classifications above
     * still get their accurate label on weeks outside it — a SPLIT week must
     * read as SPLIT in the log wherever it falls. */
    if (w.week < SUMMARY_REPAIR_MIN_WEEK_) {
      entry.reason = 'outside the approved window (older than ' + SUMMARY_REPAIR_MIN_WEEK_ + ')';
      plan.skipped.push(entry);
      plan.skippedMoney += w.net;
      continue;
    }

    entry.reason = 'rebuildable — every source row for this week is still in Suppliers';
    plan.repair.push(entry);
    plan.repairMoney += w.net;
  }

  plan.repair.sort(function (a, b) { return a.week < b.week ? -1 : 1; });   // oldest first
  plan.repairMoney = Math.round(plan.repairMoney * 100) / 100;
  plan.skippedMoney = Math.round(plan.skippedMoney * 100) / 100;
  return plan;
}

/** One line per week — a single big Logger.log gets truncated by the editor,
 *  and an approval gate nobody can read is not a gate. */
function summaryRepairLogPlan_(plan) {
  Logger.log('=== SUMMARY DRIFT REPAIR PLAN (read-only, nothing written) ===');
  Logger.log('generated ' + plan.generatedAt);
  Logger.log('weeks audited ' + plan.audited + ', drifted ' + plan.drifted +
    ', total drift $' + plan.totalDrift.toFixed(2));
  Logger.log('--- WILL REPAIR: ' + plan.repair.length + ' week(s), $' + plan.repairMoney.toFixed(2) + ' ---');
  for (var i = 0; i < plan.repair.length; i++) {
    var r = plan.repair[i];
    Logger.log('  REPAIR ' + r.week + '  $' + r.net.toFixed(2) +
      '  missing=' + r.missing + ' stale=' + r.stale);
  }
  Logger.log('--- WILL SKIP: ' + plan.skipped.length + ' week(s), $' + plan.skippedMoney.toFixed(2) + ' ---');

  /* Tally first. The window skips run to three figures after the 2026-08-25
   * backfill, and a wall of them buries the SPLIT lines — which are the ones
   * that carry a live data hazard. */
  var tally = {}, tallyMoney = {};
  for (var t = 0; t < plan.skipped.length; t++) {
    var key = plan.skipped[t].reason.split(' (')[0].split(' —')[0];
    tally[key] = (tally[key] || 0) + 1;
    tallyMoney[key] = (tallyMoney[key] || 0) + plan.skipped[t].net;
  }
  var reasons = Object.keys(tally);
  for (var q = 0; q < reasons.length; q++) {
    Logger.log('  ' + tally[reasons[q]] + ' week(s), $' + tallyMoney[reasons[q]].toFixed(2) +
      '  — ' + reasons[q]);
  }

  // Then every skip that is NOT simply "out of scope" — those are hazards.
  Logger.log('  (weeks skipped for a reason other than the approved window:)');
  var listed = 0;
  for (var j = 0; j < plan.skipped.length; j++) {
    var s = plan.skipped[j];
    if (s.reason.indexOf('outside the approved window') === 0) continue;
    Logger.log('  SKIP   ' + s.week + '  $' + s.net.toFixed(2) + '  ' + s.reason);
    listed++;
  }
  if (!listed) Logger.log('    none');
}

/**
 * Read-only. Show exactly which weeks would be re-summarized and which would
 * not, and why. Zero-arg for the Run button. Writes NOTHING.
 */
function runSummaryDriftRepairDryRun() {
  var plan = summaryDriftRepairPlan_();
  if (plan.error) { Logger.log('runSummaryDriftRepairDryRun: ' + plan.error); return plan; }
  summaryRepairLogPlan_(plan);
  Logger.log('DRY RUN — nothing was written. Run runSummaryDriftRepair() to apply.');
  return plan;
}

/* weeklySummarize re-reads Suppliers, Revenue and Summary and pulls Labour off
 * an external sheet on every call, so a long repair can walk into the 6-minute
 * execution limit. Stopping cleanly and reporting what remains beats dying
 * mid-loop: the run is idempotent and self-targeting, so a re-run finishes the
 * rest. Budget is deliberately well under 360s to leave room for the call in
 * flight plus the final logging. */
var SUMMARY_REPAIR_TIME_BUDGET_MS_ = 240000;   // 4 minutes

/**
 * Re-summarize every safely-rebuildable drifted week, oldest first.
 * Zero-arg for the Run button. Idempotent — safe to re-run.
 *
 * @returns {Object} result
 */
function runSummaryDriftRepair() {
  var plan = summaryDriftRepairPlan_();
  if (plan.error) { Logger.log('runSummaryDriftRepair: ' + plan.error); return plan; }

  summaryRepairLogPlan_(plan);
  Logger.log('=== APPLYING ===');

  var started = Date.now();
  var results = [];
  var ok = 0;
  var stoppedEarly = false;

  for (var i = 0; i < plan.repair.length; i++) {
    if (Date.now() - started > SUMMARY_REPAIR_TIME_BUDGET_MS_) {
      stoppedEarly = true;
      Logger.log('runSummaryDriftRepair: time budget reached after ' + i + ' week(s) — ' +
        'stopping cleanly. This function is idempotent and re-derives its own plan, ' +
        'so simply RUN IT AGAIN to continue with the remaining ' +
        (plan.repair.length - i) + ' week(s).');
      break;
    }

    var week = plan.repair[i].week;
    var res = weeklySummarize(week);

    /* "No error" is NOT success. weeklySummarize returns {refused:…} WITHOUT
     * throwing, on lock contention and on an incomplete week. And do NOT assert
     * on summariesAdded + summariesUpdated: both refusal paths make that sum
     * NaN, and upsertRows_ counts an unchanged amount as duplicatesSkipped, so
     * a correct idempotent re-run legitimately returns 0/0 and would read as a
     * failure. Assert the SHAPE, then re-audit to confirm the money moved. */
    var good = !!(res && !res.refused && res.weekStart === week);
    if (good) ok++;

    results.push({
      week: week,
      ok: good,
      expected: plan.repair[i].net,
      refused: res && res.refused ? res.refused : null,
      summariesAdded: res ? res.summariesAdded : null,
      summariesUpdated: res ? res.summariesUpdated : null
    });
    Logger.log('  ' + (good ? 'OK    ' : 'FAILED') + ' ' + week +
      '  expected $' + plan.repair[i].net.toFixed(2) +
      '  added=' + (res ? res.summariesAdded : '?') +
      ' updated=' + (res ? res.summariesUpdated : '?') +
      (res && res.refused ? '  refused=' + res.refused : ''));
  }

  var out = {
    weeks: plan.repair.length,
    attempted: results.length,
    ok: ok,
    failed: results.length - ok,
    remaining: plan.repair.length - results.length,
    stoppedEarly: stoppedEarly,
    results: results
  };

  Logger.log('=== REPAIR COMPLETE: ' + ok + ' ok, ' + out.failed + ' failed, ' +
    out.remaining + ' not attempted ===');
  if (out.failed > 0) {
    Logger.log('runSummaryDriftRepair: ' + out.failed + ' week(s) did NOT succeed. ' +
      'Check each result\'s reason. A "locked" refusal just means something else held ' +
      'the script lock — re-run this, it is idempotent for that case. A ' +
      '"refuse-duplicate-keys" refusal is NOT transient — it will refuse on every ' +
      're-run until you fix the live duplicate keys with ' +
      'cleanupDuplicateSummaryRows(false), then re-run this.');
  }
  Logger.log('Now run auditSummaryDrift() — the drift should have dropped by about $' +
    plan.repairMoney.toFixed(2) + '. Labour moves legitimately on every re-summarize ' +
    '(labourWeeklyPull_ re-reads a live external sheet).');
  return out;
}
