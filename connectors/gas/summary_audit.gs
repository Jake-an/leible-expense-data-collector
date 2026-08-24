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
 * @returns {Object} audit report
 */
function auditSummaryDrift_(detail) {
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

  var archKeys = {};
  for (var a = 0; a < archRows.length; a++) {
    var ak = rowKey_(archRows[a], SUPPLIERS_KEY_COLS);
    if (ak !== '||') archKeys[ak] = true;
  }

  var byWeek = {};
  var dupRows = 0;
  var dupMoney = 0;

  for (var s = 0; s < suppRows.length; s++) {
    var key = rowKey_(suppRows[s], SUPPLIERS_KEY_COLS);
    if (key === '||' || archKeys[key] !== true) continue;

    var d = coerceDateStr_(suppRows[s][0]);
    if (!DATE_ARG_RE.test(d)) continue;
    var wk = weekStartForDate_(d);
    var amt = Number(suppRows[s][2]) || 0;

    if (!byWeek[wk]) byWeek[wk] = { rows: 0, total: 0 };
    byWeek[wk].rows++;
    byWeek[wk].total += amt;
    dupRows++;
    dupMoney += amt;
  }

  var weeks = Object.keys(byWeek).sort();
  Logger.log('=== _archive DUPLICATE AUDIT (read-only, nothing written) ===');
  Logger.log('Suppliers rows ' + suppRows.length + ' | _archive rows ' + archRows.length);
  Logger.log('invoices present in BOTH tabs: ' + dupRows + ' | $' + dupMoney.toFixed(2));
  Logger.log('affected weeks: ' + weeks.length);
  Logger.log('');
  Logger.log('week          rows        $');
  for (var w = 0; w < weeks.length; w++) {
    Logger.log('  ' + weeks[w] + auditPad_(byWeek[weeks[w]].rows, 8) +
      auditPad_(byWeek[weeks[w]].total.toFixed(2), 12));
  }
  Logger.log('');
  Logger.log('Each of these is ONE invoice stored twice. Any reader that sums');
  Logger.log('Suppliers + _archive without deduping over-reports by $' + dupMoney.toFixed(2) + '.');

  return {
    suppliersRows: suppRows.length,
    archiveRows: archRows.length,
    duplicateRows: dupRows,
    duplicateMoney: Math.round(dupMoney * 100) / 100,
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

/* Zero-arg editor entry points — the Run button passes no arguments. */
function auditSummaryDrift() { return auditSummaryDrift_(false); }
function auditSummaryDriftDetail() { return auditSummaryDrift_(true); }
