/**
 * summary_audit.gs — READ-ONLY audit: how far has `Summary` drifted from
 * `Suppliers` + `Revenue`?
 *
 * WHY. `Summary` is written once per week and never revisited. The weekly
 * trigger summarizes the last completed week only, so anything that lands in
 * `Suppliers` AFTER a week was summarized never reaches `Summary` — and
 * `Summary` is what `doGet` serves and every report reads, including the weekly
 * LEIBLE_GM_COST_MONITOR pull. A closed week can under-report indefinitely.
 *
 * Found 2026-08-24 while repairing the Mayers locations: week `2026-06-15` was
 * short **$3,176.95**, with three shop/supplier combinations missing from
 * `Summary` entirely (reading $0 in every report). That was discovered by
 * accident. This function looks for the rest on purpose.
 *
 * THE CLOCK. `archiveAndPurge_` moves `Suppliers` rows older than
 * ARCHIVE_RETENTION_DAYS (183) into `_archive` and DELETES them from
 * `Suppliers`. A stale week stays repairable only while its source rows are
 * still reachable — so this audit reads `_archive` too, and flags which weeks
 * are past the purge line.
 *
 * WRITES NOTHING. No Sheet writes, no properties, no re-summarize. Reading the
 * gap is safe; closing it is a separate, deliberate act (`weeklySummarize('<week>')`),
 * because re-summarizing lands EVERY accumulated change at once.
 *
 *   Run:  auditSummaryDrift()          — every week, compact report
 *         auditSummaryDriftDetail()    — same, plus every drifted row
 */

/* Suppliers that legitimately exist in `Summary` with NO derivable source row,
 * so their absence from a recompute is expected and must not read as drift:
 *
 *  - Labour            — labourWeeklyPull_ writes it from an external sheet.
 *  - shopify_orderapp  — the order-app pull writes Summary directly (PRD-10).
 *  - Bennetts, greenbean — order-app vendor rows, also written straight to
 *    Summary (orderapp.gs), and NOT rebuildable by weeklySummarize.
 *
 * Anything else appearing only in Summary is a genuine finding: either a source
 * row was deleted, or a supplier was renamed and the old row orphaned. */
var SUMMARY_AUDIT_PULL_OWNED_ = ['labour', 'shopify_orderapp', 'bennetts', 'greenbean'];

/** Cents-safe compare — 0.1 + 0.2 style float noise must not read as drift. */
function auditCents_(v) {
  return Math.round((Number(v) || 0) * 100);
}

/**
 * @param {boolean} [detail=false] also log every drifted row
 * @param {?string} [minWeek] 'YYYY-MM-DD' week_start — when supplied, weeks
 *   before it are skipped entirely (not counted, not logged). null/absent
 *   audits every week exactly as before minWeek existed — the 14 pre-existing
 *   tests and the manual auditSummaryDrift() entry point depend on that.
 * @returns {Object} audit report
 */
function auditSummaryDrift_(detail, minWeek) {
  var ss = getHubSpreadsheet_();
  var summSheet = ss.getSheetByName(SUMMARY_TAB);
  if (!summSheet) return { error: 'no Summary tab' };

  var suppSheet = ss.getSheetByName(SUPPLIERS_TAB);
  var archSheet = ss.getSheetByName(ARCHIVE_TAB);
  var revSheet = ss.getSheetByName(REVENUE_TAB);

  /* Suppliers ALONE is not the source of truth for an old week — archiveAndPurge_
   * has moved those rows to _archive. Auditing against Suppliers only would
   * report every archived week as "Summary has rows that no longer exist",
   * which is the exact opposite of the problem being looked for. */
  var suppRows = suppSheet ? suppSheet.getDataRange().getValues().slice(1) : [];
  var archRows = archSheet ? archSheet.getDataRange().getValues().slice(1) : [];
  var sourceRows = auditDedupeSourceRows_(suppRows, archRows);
  var revRows = revSheet ? revSheet.getDataRange().getValues().slice(1) : [];
  var summData = summSheet.getDataRange().getValues();

  var today = todayStr_();
  var purgeCutoff = auditPurgeCutoff_(today);

  // Every week that either side knows about.
  var weeks = {};
  function noteWeek(dateStr) {
    if (!DATE_ARG_RE.test(dateStr)) return;
    weeks[weekStartForDate_(dateStr)] = true;
  }
  for (var i = 0; i < sourceRows.length; i++) noteWeek(coerceDateStr_(sourceRows[i][0]));
  for (var j = 0; j < revRows.length; j++) noteWeek(coerceDateStr_(revRows[j][0]));
  for (var r = 1; r < summData.length; r++) noteWeek(coerceDateStr_(summData[r][0]));

  var weekList = Object.keys(weeks).sort();
  var report = {
    generatedAt: Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    weeksAudited: 0,
    weeksClean: 0,
    weeksDrifted: 0,
    missingRows: 0,
    staleRows: 0,
    netUnderreported: 0,
    pastPurgeLine: 0,
    weeks: [],
    skipped: []
  };

  for (var w = 0; w < weekList.length; w++) {
    var week = weekList[w];
    if (minWeek && week < minWeek) continue;
    var weekEnd = addDaysStr_(week, 6);

    // An unfinished week has no business being in Summary — weeklySummarize
    // refuses it by design, so "missing" there is correct, not drift.
    if (weekEnd >= today) {
      report.skipped.push({ week: week, reason: 'incomplete week — weeklySummarize refuses it' });
      continue;
    }
    report.weeksAudited++;

    var recomputed = aggregateSupplierRows_(sourceRows, week, weekEnd, 'spend')
      .concat(aggregateSupplierRows_(revRows, week, weekEnd, 'revenue'));

    var live = {};
    for (var s = 1; s < summData.length; s++) {
      if (coerceDateStr_(summData[s][0]) !== week) continue;
      live[rowKey_(summData[s], SUMMARY_KEY_COLS)] = {
        supplier: String(summData[s][2]), location: String(summData[s][3]),
        total: Number(summData[s][SUMMARY_TOTAL_COL])
      };
    }

    var missing = [], stale = [], seen = {}, net = 0;
    for (var g = 0; g < recomputed.length; g++) {
      var grp = recomputed[g];
      var keyRow = mayersSummaryKeyRow_(week, grp.department, grp.kind, grp.supplier, grp.location);
      var key = rowKey_(keyRow, SUMMARY_KEY_COLS);
      seen[key] = true;
      var hit = live[key];
      if (!hit) {
        missing.push({ supplier: grp.supplier, location: grp.location, amount: grp.total });
        net += grp.total;
      } else if (auditCents_(hit.total) !== auditCents_(grp.total)) {
        stale.push({ supplier: grp.supplier, location: grp.location, live: hit.total, actual: grp.total });
        net += grp.total - hit.total;
      }
    }

    // Rows only Summary knows about. Pull-owned ones are expected; the rest are
    // a real finding and are counted separately, never netted into the money
    // figure — an orphan is not "missing money", it may be double-counted money.
    var summaryOnly = [], pullOwned = 0;
    var liveKeys = Object.keys(live);
    for (var k = 0; k < liveKeys.length; k++) {
      if (seen[liveKeys[k]]) continue;
      var lo = live[liveKeys[k]];
      if (SUMMARY_AUDIT_PULL_OWNED_.indexOf(mayersNorm_(lo.supplier)) !== -1) { pullOwned++; continue; }
      summaryOnly.push({ supplier: lo.supplier, location: lo.location, total: lo.total });
    }

    var drifted = missing.length + stale.length + summaryOnly.length;
    if (!drifted) { report.weeksClean++; continue; }

    report.weeksDrifted++;
    report.missingRows += missing.length;
    report.staleRows += stale.length;
    report.netUnderreported += net;

    var pastPurge = week < purgeCutoff;
    if (pastPurge) report.pastPurgeLine++;

    report.weeks.push({
      week: week,
      missing: missing.length,
      stale: stale.length,
      summaryOnly: summaryOnly.length,
      pullOwnedIgnored: pullOwned,
      net: Math.round(net * 100) / 100,
      sourceRowsStillPresent: auditWeekHasSuppliersRows_(suppRows, week, weekEnd),
      pastPurgeLine: pastPurge,
      detail: { missing: missing, stale: stale, summaryOnly: summaryOnly }
    });
  }

  report.netUnderreported = Math.round(report.netUnderreported * 100) / 100;
  auditLogReport_(report, detail === true, purgeCutoff);
  return report;
}

/**
 * Suppliers ++ _archive, with any invoice present in BOTH counted once.
 *
 * A plain concat double-counts. archiveAndPurge_ moves rows out of Suppliers
 * but upsertRows_ only ever sees the tab it writes to, so a re-ingest appends
 * the same invoice_ref back into Suppliers while its archived copy remains —
 * and this audit sums both. That inflated the reported drift on all 24 SPLIT
 * weeks after the 2026-08-25 Ordermentum backfill, which is the opposite of
 * what an instrument is for.
 *
 * The Suppliers copy wins: it is the one a repair would rebuild from, and it
 * carries the fresher extracted_at.
 *
 * A row with an EMPTY key (no source and no invoice_ref) is never deduped —
 * every such row would collapse onto the single key '||' and silently delete
 * real money from the recomputed total.
 */
function auditDedupeSourceRows_(suppRows, archRows) {
  var out = [];
  var seen = {};
  var i;

  for (i = 0; i < suppRows.length; i++) {
    var sk = rowKey_(suppRows[i], SUPPLIERS_KEY_COLS);
    if (sk !== '||') seen[sk] = true;
    out.push(suppRows[i]);
  }

  for (i = 0; i < archRows.length; i++) {
    var ak = rowKey_(archRows[i], SUPPLIERS_KEY_COLS);
    if (ak !== '||' && seen[ak] === true) continue;
    /* Mark it seen HERE too, not just in the Suppliers loop. `_archive` holds
     * repeated copies of the SAME invoice (archiveAndPurge_ appended without
     * deduping), so an invoice that never made it back into Suppliers appears
     * N times in archRows alone. Without this line every one of those copies
     * survived and the audit still over-reported — measured 2026-08-25 at
     * $32,747.64 across the weeks whose duplicates are archive-only, which is
     * why their drift did not move when the Suppliers-side dedup landed. */
    if (ak !== '||') seen[ak] = true;
    out.push(archRows[i]);
  }

  return out;
}

/**
 * READ-ONLY. How many invoices are sitting in BOTH `Suppliers` and `_archive`,
 * and what are they worth? This is the size of the cleanup job, and the exact
 * amount by which a non-deduping reader over-reports.
 *
 * Zero-arg for the Run button. Writes nothing.
 */
function auditArchiveDuplicates() {
  var ss = getHubSpreadsheet_();
  var suppSheet = ss.getSheetByName(SUPPLIERS_TAB);
  var archSheet = ss.getSheetByName(ARCHIVE_TAB);
  if (!suppSheet || !archSheet) return { error: 'missing Suppliers or _archive tab' };

  var suppRows = suppSheet.getDataRange().getValues().slice(1);
  var archRows = archSheet.getDataRange().getValues().slice(1);

  /* COUNT EVERY COPY, not just the Suppliers-side one.
   *
   * The first version of this census counted one row per Suppliers invoice that
   * had an archived twin, and reported that sum as the over-count. It was
   * wrong by 4.5×: on 2026-08-25 it said $4,520.34 while the true over-report
   * was $20,624.23.
   *
   * The reason is a second defect. archiveAndPurge_ appends to `_archive` with
   * NO dedup check, so every re-ingest-then-purge cycle adds ANOTHER copy of
   * the same invoice. Nine of the affected weeks had SIX archive copies each —
   * fourteen months of cycles. A reader that sums both tabs counts an invoice
   * once per copy, so the over-count is (copies − 1) × amount, not 1 × amount.
   *
   * So this walks BOTH tabs and prices every copy beyond the first. */
  var copies = {};   // key -> { amounts: [], supp: n, arch: n, date: 'YYYY-MM-DD' }
  function note(row, which) {
    var key = rowKey_(row, SUPPLIERS_KEY_COLS);
    if (key === '||') return;                 // never collapse empty keys
    if (!copies[key]) copies[key] = { amounts: [], supp: 0, arch: 0, date: '' };
    var c = copies[key];
    c.amounts.push(Number(row[2]) || 0);
    c[which]++;
    var d = coerceDateStr_(row[0]);
    if (!c.date && DATE_ARG_RE.test(d)) c.date = d;
  }
  var i;
  for (i = 0; i < suppRows.length; i++) note(suppRows[i], 'supp');
  for (i = 0; i < archRows.length; i++) note(archRows[i], 'arch');

  var byWeek = {};
  var dupInvoices = 0, excessRows = 0, overCount = 0, maxCopies = 0;
  var keys = Object.keys(copies);

  for (i = 0; i < keys.length; i++) {
    var c = copies[keys[i]];
    var total = c.supp + c.arch;
    if (total < 2) continue;                  // stored once — correct
    if (!DATE_ARG_RE.test(c.date)) continue;

    // What a non-deduping reader over-reports: every copy past the first.
    var sum = 0;
    for (var m = 0; m < c.amounts.length; m++) sum += c.amounts[m];
    var over = sum - c.amounts[0];

    var wk = weekStartForDate_(c.date);
    if (!byWeek[wk]) byWeek[wk] = { invoices: 0, excess: 0, over: 0 };
    byWeek[wk].invoices++;
    byWeek[wk].excess += total - 1;
    byWeek[wk].over += over;

    dupInvoices++;
    excessRows += total - 1;
    overCount += over;
    if (total > maxCopies) maxCopies = total;
  }

  var weeks = Object.keys(byWeek).sort();
  Logger.log('=== _archive DUPLICATE AUDIT (read-only, nothing written) ===');
  Logger.log('Suppliers rows ' + suppRows.length + ' | _archive rows ' + archRows.length);
  Logger.log('invoices stored more than once: ' + dupInvoices);
  Logger.log('redundant rows (copies beyond the first): ' + excessRows);
  Logger.log('most copies of a single invoice: ' + maxCopies);
  Logger.log('OVER-COUNT by a reader that sums both tabs: $' + overCount.toFixed(2));
  Logger.log('affected weeks: ' + weeks.length);
  Logger.log('');
  Logger.log('week          inv   excess    over$');
  for (var w = 0; w < weeks.length; w++) {
    var b = byWeek[weeks[w]];
    Logger.log('  ' + weeks[w] + auditPad_(b.invoices, 6) + auditPad_(b.excess, 9) +
      auditPad_(b.over.toFixed(2), 10));
  }
  Logger.log('');
  Logger.log('auditSummaryDrift() is immune to this — it keeps one copy per key.');
  Logger.log('Cleanup = delete the ' + excessRows + ' redundant row(s), keeping one of each.');

  return {
    suppliersRows: suppRows.length,
    archiveRows: archRows.length,
    duplicateInvoices: dupInvoices,
    excessRows: excessRows,
    maxCopies: maxCopies,
    overCount: Math.round(overCount * 100) / 100,
    weeksAffected: weeks.length,
    byWeek: byWeek
  };
}

/** Are this week's rows still in Suppliers, or only in _archive? Decides
 *  whether a re-summarize can still rebuild the week. */
function auditWeekHasSuppliersRows_(suppRows, week, weekEnd) {
  for (var i = 0; i < suppRows.length; i++) {
    var d = coerceDateStr_(suppRows[i][0]);
    if (d >= week && d <= weekEnd) return true;
  }
  return false;
}

/** The date archiveAndPurge_ is currently purging back to. */
function auditPurgeCutoff_(today) {
  var d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ARCHIVE_RETENTION_DAYS);
  return d.toISOString().slice(0, 10);
}

/** Compact, line-by-line. One huge Logger.log entry gets truncated by the
 *  editor — learned the hard way on the Mayers dry run. */
function auditLogReport_(report, detail, purgeCutoff) {
  var out = [];
  out.push('=== SUMMARY DRIFT AUDIT (read-only, nothing written) ===');
  out.push('weeks audited ' + report.weeksAudited +
    ' | clean ' + report.weeksClean +
    ' | DRIFTED ' + report.weeksDrifted);
  out.push('rows missing from Summary: ' + report.missingRows +
    ' | rows with a stale amount: ' + report.staleRows);
  out.push('NET UNDER-REPORTED: $' + report.netUnderreported);
  out.push('purge line (ARCHIVE_RETENTION_DAYS=' + ARCHIVE_RETENTION_DAYS + '): ' + purgeCutoff +
    ' — ' + report.pastPurgeLine + ' drifted week(s) are older than this');
  out.push('');

  if (!report.weeks.length) {
    out.push('No drift found. Every completed week matches Suppliers + Revenue.');
  } else {
    out.push('week         miss stale sOnly       net$  srcInSuppliers');
    for (var i = 0; i < report.weeks.length; i++) {
      var w = report.weeks[i];
      out.push(w.week + '   ' +
        auditPad_(w.missing, 4) + ' ' + auditPad_(w.stale, 5) + ' ' + auditPad_(w.summaryOnly, 5) +
        ' ' + auditPad_(w.net, 10) + '  ' + (w.sourceRowsStillPresent ? 'yes' : 'NO — archived only') +
        (w.pastPurgeLine ? '  [past purge line]' : ''));
    }
  }

  if (detail) {
    out.push('');
    out.push('--- detail ---');
    for (var d = 0; d < report.weeks.length; d++) {
      var wk = report.weeks[d];
      out.push(wk.week + ':');
      for (var m = 0; m < wk.detail.missing.length; m++) {
        var mi = wk.detail.missing[m];
        out.push('   MISSING  ' + mi.supplier + ' @ ' + (mi.location || "''") + '  $' + mi.amount);
      }
      for (var s = 0; s < wk.detail.stale.length; s++) {
        var st = wk.detail.stale[s];
        out.push('   STALE    ' + st.supplier + ' @ ' + (st.location || "''") +
          '  $' + st.live + ' -> $' + st.actual);
      }
      for (var o = 0; o < wk.detail.summaryOnly.length; o++) {
        var so = wk.detail.summaryOnly[o];
        out.push('   ORPHAN?  ' + so.supplier + ' @ ' + (so.location || "''") +
          '  $' + so.total + '  (in Summary, no source row)');
      }
    }
  }

  out.push('');
  out.push('To CLOSE a week\'s gap: weeklySummarize(\'<week_start>\') — but it lands EVERY');
  out.push('change in that week at once, so read the detail first.');

  for (var L = 0; L < out.length; L++) Logger.log(out[L]);
}

function auditPad_(v, width) {
  var s = String(v);
  while (s.length < width) s = ' ' + s;
  return s;
}

/**
 * READ-ONLY preview of what a heal WOULD do to the last 4 completed weeks.
 * Builds ctx once (including the guarded `_archive` week Set — an ungated
 * build would seed a '' key off a blank/pre-guard date cell, or throw on a
 * Date-typed one) and calls computeHealPlan_, the same function the eventual
 * write path calls, so the preview and the real heal can never diverge.
 *
 * Zero-arg for the Run button. Writes nothing.
 *
 * @returns {{generatedAt:string, weeks:Array, projectedSetValues:number, projectedOverrideCost:number}}
 */
function previewSummaryHeal() {
  var ss = getHubSpreadsheet_();
  // getSheetByName with null-guards, NOT ensureSheet — this is documented
  // READ-ONLY / "Writes nothing", but ensureSheet INSERTS a sheet and writes
  // a header row when the tab is absent (Code.gs ensureSheet). The earlier
  // "writes NOTHING" test never caught this because its fixture pre-creates
  // every tab first (REVIEW FIXES 2026-08-26, FIX 4b).
  var suppSheet = ss.getSheetByName(SUPPLIERS_TAB);
  var summSheet = ss.getSheetByName(SUMMARY_TAB);
  var archSheet = ss.getSheetByName(ARCHIVE_TAB);
  var revSheet = ss.getSheetByName(REVENUE_TAB);

  var archRows = archSheet ? archSheet.getDataRange().getValues().slice(1) : [];
  var archiveWeeks = {};
  for (var i = 0; i < archRows.length; i++) {
    var d = coerceDateStr_(archRows[i][0]);
    if (DATE_ARG_RE.test(d)) archiveWeeks[weekStartForDate_(d)] = true;
  }

  var summaryValues = summSheet ? summSheet.getDataRange().getValues() : [];
  var supplierRows = suppSheet ? suppSheet.getDataRange().getValues().slice(1) : [];
  var revenueRows = revSheet ? revSheet.getDataRange().getValues().slice(1) : [];

  var ctx = {
    archiveWeeks: archiveWeeks,
    summaryRows: summaryValues,
    supplierRows: supplierRows,
    revenueRows: revenueRows
  };

  // The last 4 completed weeks, oldest first — the same "last completed
  // week" anchor weeklySummarize_impl_/auditSummaryDrift_ already use.
  var lastCompleted = getLastCompletedWeek_(todayStr_());
  var weeks = [];
  var wk = lastCompleted.start;
  for (var n = 0; n < 4; n++) {
    weeks.unshift(wk);
    wk = addDaysStr_(wk, -7);
  }

  var plan = computeHealPlan_(weeks, ctx);

  var projectedSetValues = 0;
  for (var p = 0; p < plan.length; p++) projectedSetValues += plan[p].projectedSetValues;

  // The _archive + Summary read sizes a SINGLE override call would pay —
  // feeds the same >300 batching threshold greenBeanPull_'s up-to-5-calls-
  // per-run path is measured against.
  var projectedOverrideCost = archRows.length + (summaryValues.length ? summaryValues.length - 1 : 0);

  // Line-per-week — one big Logger.log(JSON.stringify(...)) gets truncated
  // by the editor (documented project gotcha).
  var out = [];
  out.push('=== SUMMARY HEAL PREVIEW (read-only, nothing written) ===');
  for (var q = 0; q < plan.length; q++) {
    var wp = plan[q];
    out.push(wp.week + '  ' + wp.action + '  rows=' + wp.rows.length +
      (wp.reason ? '  (' + wp.reason + ')' : ''));
  }
  out.push('projected setValue calls (whole 4-week window): ' + projectedSetValues);
  out.push('projected override read cost (_archive + Summary): ' + projectedOverrideCost);
  for (var L = 0; L < out.length; L++) Logger.log(out[L]);

  return {
    generatedAt: Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    weeks: plan,
    projectedSetValues: projectedSetValues,
    projectedOverrideCost: projectedOverrideCost
  };
}

/* ------------------------------------------------------------------ *
 * Orphan sweep (PRD-12, Step 3) — the MANUAL, gated removal half of orphan
 * handling. healOrphanCandidates_ (Code.gs) reports orphans automatically
 * inside every heal but never deletes; this is the one place a stale
 * Summary row is actually removed, and only on Jake's say-so.
 *
 * Follows this project's established dry-run-then-gated-apply shape
 * (cleanupDuplicateSummaryRows, cleanupOnlineRevenueSummaryRows):
 *   runSummaryOrphanSweepDryRun() — read-only, logs one line per candidate
 *     and records what it approved.
 *   runSummaryOrphanSweep()       — recomputes candidates fresh and refuses
 *     to proceed unless they are IDENTICAL to what the dry run approved —
 *     Sheet state can drift between the two calls (another heal landing in
 *     between), and adjusting the approved count to fit would defeat the
 *     whole point of a gate. On mismatch: re-run the dry run and re-approve.
 * ------------------------------------------------------------------ */

var SUMMARY_ORPHAN_BACKUP_TAB = 'Summary_orphan_backup';
var SUMMARY_ORPHAN_SWEEP_APPROVED_PROP_ = 'SUMMARY_ORPHAN_SWEEP_APPROVED';

/* REVIEW FIXES 2026-08-26 (FIX 4c, MINOR): the approval a dry run records
 * carried no timestamp, so a stale dry run from hours ago could still
 * authorize today's apply whenever the candidate set happened to still
 * match. An approval older than this is refused, not silently honored. */
var SUMMARY_ORPHAN_SWEEP_APPROVAL_MAX_AGE_MS_ = 60 * 60 * 1000;

/**
 * Core sweep, read-only. For every week Summary knows about, recomputes that
 * week's batch from Suppliers/Revenue exactly as healWeek_ does and reports
 * any live Summary key absent from it — same exclusions and normalization as
 * healOrphanCandidates_ (Code.gs): shopify_orderapp and Labour are skipped
 * (pull-owned, never derived), and matching is the full SUMMARY_KEY_COLS
 * tuple via rowKey_, never (week, location) alone.
 *
 * REVIEW FIXES 2026-08-26 (FIX 1, CRITICAL): a Suppliers-only recompute is
 * wrong for any week archiveAndPurge_ has touched. Two guards, mirroring
 * auditSummaryDrift_/computeHealPlan_ exactly:
 *  - source rows are Suppliers MERGED with _archive (auditDedupeSourceRows_),
 *    not Suppliers alone — otherwise every week whose invoices already moved
 *    to _archive recomputes empty and its live Summary row reads as an orphan.
 *  - weeks past auditPurgeCutoff_ are skipped entirely — past that line
 *    NEITHER tab holds the source rows any more, so a recompute is always
 *    empty and every row would misread as an orphan (~143 of 169 weeks).
 *  - SPLIT weeks (rows in both Suppliers and _archive) are skipped entirely —
 *    a recompute of a SPLIT week understates it, the same reason
 *    computeHealPlan_ and summaryDriftCheck_ both skip/suppress SPLIT weeks.
 * @returns {{mode:'dryRun', candidates:Array}}
 */
function summaryOrphanSweep_() {
  var ss = getHubSpreadsheet_();
  var summSheet = ss.getSheetByName(SUMMARY_TAB);
  if (!summSheet) { Logger.log('summaryOrphanSweep_: no Summary tab'); return { error: 'no-sheet' }; }

  var suppSheet = ss.getSheetByName(SUPPLIERS_TAB);
  var archSheet = ss.getSheetByName(ARCHIVE_TAB);
  var revSheet = ss.getSheetByName(REVENUE_TAB);
  var supplierRows = suppSheet ? suppSheet.getDataRange().getValues().slice(1) : [];
  var archiveRows = archSheet ? archSheet.getDataRange().getValues().slice(1) : [];
  var sourceRows = auditDedupeSourceRows_(supplierRows, archiveRows);
  var revenueRows = revSheet ? revSheet.getDataRange().getValues().slice(1) : [];
  var data = summSheet.getDataRange().getValues();

  var purgeCutoff = auditPurgeCutoff_(todayStr_());

  // SPLIT guard — same "week has an _archive row" test computeHealPlan_ uses.
  var archiveWeeks = {};
  for (var a = 0; a < archiveRows.length; a++) {
    var ad = coerceDateStr_(archiveRows[a][0]);
    if (DATE_ARG_RE.test(ad)) archiveWeeks[weekStartForDate_(ad)] = true;
  }

  var weeks = {};
  for (var r = 1; r < data.length; r++) {
    var wk = coerceDateStr_(data[r][0]);
    if (DATE_ARG_RE.test(wk)) weeks[wk] = true;
  }

  // Recompute each distinct week's batch once, not once per row. Weeks past
  // the purge line or SPLIT never get a computed-keys entry, so every live
  // row for them is skipped below rather than misread as an orphan.
  var computedKeysByWeek = {};
  var weekList = Object.keys(weeks);
  for (var w = 0; w < weekList.length; w++) {
    var week = weekList[w];
    if (week < purgeCutoff) continue;
    if (archiveWeeks[week]) continue;
    var weekEnd = addDaysStr_(week, 6);
    var recomputed = aggregateSupplierRows_(sourceRows, week, weekEnd, 'spend')
      .concat(aggregateSupplierRows_(revenueRows, week, weekEnd, 'revenue'));
    var keys = {};
    for (var g = 0; g < recomputed.length; g++) {
      var grp = recomputed[g];
      var keyRow = mayersSummaryKeyRow_(week, grp.department, grp.kind, grp.supplier, grp.location);
      keys[rowKey_(keyRow, SUMMARY_KEY_COLS)] = true;
    }
    computedKeysByWeek[week] = keys;
  }

  var candidates = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rowWeek = coerceDateStr_(row[0]);
    if (!DATE_ARG_RE.test(rowWeek)) continue;
    if (rowWeek < purgeCutoff) continue;
    if (archiveWeeks[rowWeek]) continue;
    var supplier = String(row[2]);
    var normSupplier = mayersNorm_(supplier);
    if (normSupplier === 'shopify_orderapp' || normSupplier === 'labour') continue;
    var key = rowKey_(row, SUMMARY_KEY_COLS);
    var keysForWeek = computedKeysByWeek[rowWeek] || {};
    if (keysForWeek[key]) continue;
    candidates.push({
      row: i, week: rowWeek, key: key,
      supplier: supplier, location: String(row[3]),
      total: Number(row[SUMMARY_TOTAL_COL]),
      raw: row
    });
  }

  return { mode: 'dryRun', candidates: candidates };
}

/**
 * Read-only. Logs one line per candidate — a single Logger.log(JSON.stringify)
 * gets truncated by the editor, and an approval gate nobody can read is not a
 * gate. Records the approved candidate set (count + keys) to a Script
 * Property so runSummaryOrphanSweep() can refuse to proceed if reality has
 * since drifted. Zero-arg for the Run button. Writes nothing to Summary.
 * @returns {{mode:'dryRun', candidates:Array}}
 */
function runSummaryOrphanSweepDryRun() {
  var report = summaryOrphanSweep_();
  if (report.error) { Logger.log('runSummaryOrphanSweepDryRun: ' + report.error); return report; }

  Logger.log('=== SUMMARY ORPHAN SWEEP — DRY RUN (nothing written) ===');
  Logger.log('found ' + report.candidates.length + ' orphan candidate(s)');
  for (var c = 0; c < report.candidates.length; c++) {
    var cd = report.candidates[c];
    Logger.log('  ORPHAN row ' + (cd.row + 1) + '  week ' + cd.week + '  ' +
      cd.supplier + ' @ ' + cd.location + '  $' + cd.total);
  }
  Logger.log('DRY RUN — nothing was written. Run runSummaryOrphanSweep() to apply.');

  var approved = {
    count: report.candidates.length,
    keys: report.candidates.map(function (cd) { return cd.key; }).sort(),
    approvedAt: Date.now()
  };
  PropertiesService.getScriptProperties().setProperty(
    SUMMARY_ORPHAN_SWEEP_APPROVED_PROP_, JSON.stringify(approved));

  return report;
}

/**
 * Gated apply. Recomputes candidates fresh and refuses to delete anything
 * unless they match EXACTLY (same count, same keys) what
 * runSummaryOrphanSweepDryRun() last approved — never adjusts the approved
 * count to fit a drifted reality. Backs every matched row up to
 * SUMMARY_ORPHAN_BACKUP_TAB before the first delete, then deletes bottom-up
 * so earlier row numbers stay valid as later rows shift.
 * Zero-arg for the Run button.
 * @returns {{mode:string, deleted:number, found:number, aborted:?boolean}}
 */
function runSummaryOrphanSweep() {
  var report = summaryOrphanSweep_();
  if (report.error) { Logger.log('runSummaryOrphanSweep: ' + report.error); return report; }

  var approvedRaw = PropertiesService.getScriptProperties().getProperty(SUMMARY_ORPHAN_SWEEP_APPROVED_PROP_);
  var approved = approvedRaw ? JSON.parse(approvedRaw) : null;
  var liveKeys = report.candidates.map(function (cd) { return cd.key; }).sort();

  // A gate that cannot read its own approval must fail CLOSED: a missing or
  // non-numeric approvedAt is treated as unusable, not as "not stale"
  // (REVIEW FIXES 2026-08-26, FIX 4 — the prior `typeof === 'number' && …`
  // check made a malformed approvedAt silently pass the staleness check).
  var approvalUsable = !!approved && typeof approved.approvedAt === 'number';
  var malformed = !!approved && !approvalUsable;
  var stale = approvalUsable &&
    (Date.now() - approved.approvedAt) > SUMMARY_ORPHAN_SWEEP_APPROVAL_MAX_AGE_MS_;

  var matches = approvalUsable && !stale && approved.count === liveKeys.length &&
    JSON.stringify(approved.keys) === JSON.stringify(liveKeys);

  if (!matches) {
    Logger.log('runSummaryOrphanSweep: ABORTED — ' +
      (malformed
        ? 'the approval record is missing/malformed (no usable approvedAt) — refusing to proceed'
        : stale
          ? 'the approved dry run is more than an hour old'
          : 'live orphan candidates (' + liveKeys.length + ') no longer match what ' +
            'runSummaryOrphanSweepDryRun() approved' + (approved ? ' (' + approved.count + ')' : ' (no dry run on record)')) +
      '. Re-run runSummaryOrphanSweepDryRun() and re-approve — never force this through.');
    return { mode: 'aborted', aborted: true, deleted: 0, found: liveKeys.length };
  }

  var ss = getHubSpreadsheet_();
  var summSheet = ss.getSheetByName(SUMMARY_TAB);
  var backup = ensureSheet(ss, SUMMARY_ORPHAN_BACKUP_TAB, SUMMARY_HEADERS);

  for (var b = 0; b < report.candidates.length; b++) backup.appendRow(report.candidates[b].raw);
  Logger.log('runSummaryOrphanSweep: backed up ' + report.candidates.length +
    ' row(s) to ' + SUMMARY_ORPHAN_BACKUP_TAB);

  var deleted = 0;
  for (var m = report.candidates.length - 1; m >= 0; m--) {
    summSheet.deleteRow(report.candidates[m].row + 1);
    deleted++;
  }

  PropertiesService.getScriptProperties().deleteProperty(SUMMARY_ORPHAN_SWEEP_APPROVED_PROP_);
  Logger.log('runSummaryOrphanSweep: APPLIED — deleted=' + deleted);
  return { mode: 'apply', deleted: deleted, found: report.candidates.length };
}

/* ------------------------------------------------------------------ *
 * Drift guard (PRD-13, Step 4) — a scheduled trigger that watches the
 * DRIFT ITSELF, separate from anything that could self-heal it. A guard
 * that ran inside weeklySummarize/healWeeks_ could never report that those
 * never ran at all.
 *
 * Windowed to auditPurgeCutoff_(todayStr_()) — the same ARCHIVE_RETENTION_DAYS
 * horizon archiveAndPurge_ already enforces, so this never re-alerts on the
 * 143+ weeks that are deliberately written off. Read-only: auditSummaryDrift_
 * writes nothing, and this adds no Sheet write of its own.
 *
 * A drifted week that also has an _archive row (SPLIT — same detection
 * computeHealPlan_ uses) cannot be closed by weeklySummarize('<week>') without
 * UNDERSTATING it, so flagging it daily would be un-actionable noise. It is
 * suppressed into splitSuppressed instead of drifted — but if any OTHER week
 * in the window is genuinely actionable, the one alert that fires still names
 * the SPLIT week too, for visibility.
 * ------------------------------------------------------------------ */

var SUMMARY_DRIFT_ALERT_TITLE_ = 'LEIBLE Summary drift detected';

/**
 * @param {number} nowMs injected clock
 * @returns {{weeksAudited:number, drifted:Array, splitSuppressed:Array, eventsCreated:number}}
 */
function summaryDriftCheck_(nowMs) {
  var ss = getHubSpreadsheet_();
  var cutoff = auditPurgeCutoff_(todayStr_());
  var report = auditSummaryDrift_(false, cutoff);

  // auditSummaryDrift_ returns {error:...} (no .weeks) when there is no
  // Summary tab to audit — a clean "cannot audit" signal, not a failure.
  // Reading report.weeks.length without this guard throws a TypeError inside
  // the scheduled trigger handler (REVIEW FIXES 2026-08-26, FIX 4a).
  if (report.error) {
    return { weeksAudited: 0, drifted: [], splitSuppressed: [], eventsCreated: 0 };
  }

  // Same "week has an _archive row" test computeHealPlan_ (Code.gs) uses to
  // decide skip-split — read-only, ARCHIVE_TAB may not exist yet.
  var archSheet = ss.getSheetByName(ARCHIVE_TAB);
  var archRows = archSheet ? archSheet.getDataRange().getValues().slice(1) : [];
  var archiveWeeks = {};
  for (var i = 0; i < archRows.length; i++) {
    var d = coerceDateStr_(archRows[i][0]);
    if (DATE_ARG_RE.test(d)) archiveWeeks[weekStartForDate_(d)] = true;
  }

  var drifted = [], splitSuppressed = [];
  for (var w = 0; w < report.weeks.length; w++) {
    var wk = report.weeks[w];
    if (archiveWeeks[wk.week]) {
      splitSuppressed.push({
        week: wk.week,
        reason: 'SPLIT — week has _archive row(s); a recompute would understate it, not close the gap'
      });
    } else {
      drifted.push(wk);
    }
  }

  // Only an actionable (non-SPLIT) week is worth interrupting Jake for — a
  // window with SPLIT weeks alone stays silent, not a daily un-actionable ping.
  var eventsCreated = 0;
  if (drifted.length) {
    eventsCreated = raiseCalendarAlert_(
      SUMMARY_DRIFT_ALERT_TITLE_,
      summaryDriftAlertBody_(drifted, splitSuppressed, cutoff),
      'ORANGE',
      nowMs);
  }

  return {
    weeksAudited: report.weeksAudited,
    drifted: drifted,
    splitSuppressed: splitSuppressed,
    eventsCreated: eventsCreated
  };
}

/** @returns {string[]} body lines — joined by raiseCalendarAlert_. */
function summaryDriftAlertBody_(drifted, splitSuppressed, cutoff) {
  var lines = [];
  lines.push('Summary has drifted from Suppliers/Revenue for ' + drifted.length +
    ' week(s) inside the repair window (purge line ' + cutoff + '):');
  for (var i = 0; i < drifted.length; i++) {
    var w = drifted[i];
    lines.push('  - ' + w.week + ': net $' + w.net + ' (' + w.missing + ' missing, ' +
      w.stale + ' stale, ' + w.summaryOnly + ' orphan)');
  }
  if (splitSuppressed.length) {
    lines.push('');
    lines.push('SPLIT week(s) — suppressed, cannot be closed without understating them:');
    for (var s = 0; s < splitSuppressed.length; s++) {
      lines.push('  - ' + splitSuppressed[s].week + ': ' + splitSuppressed[s].reason);
    }
  }
  lines.push('');
  lines.push('To repair a week: read the detail with auditSummaryDrift(true), then ' +
    "weeklySummarize('<week_start>') — it lands every change in that week at once.");
  return lines;
}

/**
 * Trigger handler. Zero arguments — deliberately (see staleness.gs header: a
 * time-based trigger passes an event object as arg 1, which corrupted the
 * Sales tab once already). All logic lives in the injectable summaryDriftCheck_.
 */
function checkSummaryDrift() {
  return summaryDriftCheck_(Date.now());
}

/**
 * Weekly, Monday 07:00 Australia/Sydney — after weeklySummarize's 04:00 slot
 * (so the week it audits has actually been summarized first) and clear of
 * the staleness watchdog's daily 11:00. A guard that ran inside the thing it
 * watches could never report that the thing never ran, so this is its own
 * trigger, not a call tacked onto weeklySummarize.
 *
 * Delete-then-create, touching ONLY its own handler name — five other
 * handlers (shopSpendWatchdog, checkIngestStaleness, weeklySummarize,
 * shopifyWeeklyPull, greenBeanPull) share this project's trigger list.
 */
function installSummaryDriftTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkSummaryDrift') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('checkSummaryDrift')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7)
    .inTimezone('Australia/Sydney').create();
  Logger.log('installSummaryDriftTrigger: Monday 07:00 Australia/Sydney trigger installed');
}

/* Zero-arg editor entry points — the Run button passes no arguments. */
function auditSummaryDrift() { return auditSummaryDrift_(false); }
function auditSummaryDriftDetail() { return auditSummaryDrift_(true); }
