/**
 * backfill_resummarize.gs — re-summarize the weeks touched by the Ordermentum
 * North Sydney backfill (2026-08-24).
 *
 * TEMPORARY. Delete once the weeks below are verified.
 *
 * WHY THIS EXISTS. The Ordermentum connector was pointed at the DEAD North
 * Sydney retailer account ('Apex international group pty ltd') instead of the
 * live one ('LEGEND STAR INVESTMENTS PTY LTD'), so North produced no rows at
 * all, for any supplier, ever. The backfill added 54 Suppliers rows
 * ($10,792.80 of Fuel Bakery and Tuga spend at Leible North).
 *
 * Those rows are in `Suppliers` but NOT in `Summary`, and `Summary` is what
 * doGet serves and every report reads. weeklySummarize only ever writes ONE
 * week per call, and its bare form does the last completed week — so without
 * this the backfilled money stays invisible everywhere except the raw tab.
 *
 * The Apps Script Run button passes NO arguments, so weeklySummarize('2026-07-06')
 * is unreachable from the editor: calling it unwrapped would silently summarize
 * last week instead of the week asked for.
 *
 *   Run:  runOrdermentumBackfillResummarize()
 *
 * Idempotent. upsertRows_ updates a changed total and counts an unchanged one as
 * duplicatesSkipped, so a second run is a no-op — re-run it freely.
 */

/* The eight COMPLETE weeks the backfill touched, oldest first.
 *
 * 2026-08-24 is deliberately absent: that week has not finished, and
 * weeklySummarize REFUSES an incomplete week (Code.gs:1791) because a partial
 * total frozen into Summary is indistinguishable from a final one to any
 * consumer of doGet. Its 4 rows summarize on their own once the week closes.
 *
 * Weeks marked (M) are also in the parked Mayers location repair. Re-summarizing
 * them here is safe and does not disturb it: this rebuilds from Suppliers, where
 * the Mayers rows still hold their pre-repair locations, so the Mayers rows come
 * back exactly as they were. It DOES make the Mayers Phase 3 baseline stale —
 * re-capture that before applying the Mayers repair. */
var ORDERMENTUM_BACKFILL_WEEKS_ = [
  '2026-06-29',
  '2026-07-06', // (M)
  '2026-07-13',
  '2026-07-20', // (M)
  '2026-07-27', // (M)
  '2026-08-03',
  '2026-08-10',
  '2026-08-17'
];

/**
 * Re-summarize every backfilled week, oldest first. Zero-arg for the Run button.
 * @returns {{weeks:number, ok:number, failed:number, results:Object[]}}
 */
function runOrdermentumBackfillResummarize() {
  var results = [];
  var ok = 0;

  for (var i = 0; i < ORDERMENTUM_BACKFILL_WEEKS_.length; i++) {
    var week = ORDERMENTUM_BACKFILL_WEEKS_[i];
    var res = weeklySummarize(week);

    /* "No error" is NOT success. weeklySummarize returns {refused:…} WITHOUT
     * throwing on lock contention (Code.gs:1757) and on an incomplete week
     * (Code.gs:1791). And do NOT assert on summariesAdded + summariesUpdated:
     * both refusal paths make that sum NaN, and upsertRows_ counts an unchanged
     * amount as duplicatesSkipped — so a correct idempotent re-run legitimately
     * returns 0/0 and would read as failure. Assert the shape, then read the
     * Summary state to confirm. */
    var good = !!(res && !res.refused && res.weekStart === week);
    if (good) ok++;

    results.push({
      week: week,
      ok: good,
      refused: res && res.refused ? res.refused : null,
      summariesAdded: res ? res.summariesAdded : null,
      summariesUpdated: res ? res.summariesUpdated : null
    });
    Logger.log('runOrdermentumBackfillResummarize: ' + week + ' -> ' +
      (good ? 'OK' : 'FAILED') + ' ' + JSON.stringify(res));
  }

  var summary = {
    weeks: ORDERMENTUM_BACKFILL_WEEKS_.length,
    ok: ok,
    failed: ORDERMENTUM_BACKFILL_WEEKS_.length - ok,
    results: results
  };
  Logger.log('RESUMMARIZE COMPLETE: ' + JSON.stringify(summary, null, 2));
  if (summary.failed > 0) {
    Logger.log('runOrdermentumBackfillResummarize: ' + summary.failed + ' week(s) did NOT ' +
      'succeed. A "locked" refusal just means something else held the script lock — ' +
      're-run this function, it is idempotent.');
  }
  return summary;
}

/**
 * Read-only check that the backfill actually reached Summary: Ordermentum spend
 * at Leible North, per week. Zero-arg for the Run button.
 *
 * Before the backfill every one of these was zero — that was the defect.
 */
function checkOrdermentumNorthInSummary() {
  var ss = getHubSpreadsheet_();
  var sheet = ss.getSheetByName(SUMMARY_TAB);
  if (!sheet) return { error: 'no Summary tab' };

  var data = sheet.getDataRange().getValues();
  var wanted = {};
  for (var w = 0; w < ORDERMENTUM_BACKFILL_WEEKS_.length; w++) {
    wanted[ORDERMENTUM_BACKFILL_WEEKS_[w]] = { rows: 0, total: 0, suppliers: [] };
  }

  for (var r = 1; r < data.length; r++) {
    var week = coerceDateStr_(data[r][0]);
    if (!wanted[week]) continue;
    if (String(data[r][3]).trim().toLowerCase() !== 'leible north') continue;

    var supplier = String(data[r][2]).trim();
    // The Ordermentum-sourced suppliers only — Fresh and Chill / Food and Dairy
    // Co also sell to North and were never affected by the venue bug.
    if (['fuel bakery', 'butterboy', 'tuga pastries australia', "allie's foods"]
      .indexOf(supplier.toLowerCase()) === -1) continue;

    wanted[week].rows++;
    wanted[week].total += Number(data[r][4]) || 0;
    wanted[week].suppliers.push(supplier + ' $' + (Number(data[r][4]) || 0));
  }

  var grand = 0, weeksWithData = 0;
  for (var k in wanted) {
    wanted[k].total = Math.round(wanted[k].total * 100) / 100;
    grand += wanted[k].total;
    if (wanted[k].rows > 0) weeksWithData++;
  }

  var out = {
    weeksChecked: ORDERMENTUM_BACKFILL_WEEKS_.length,
    weeksWithNorthData: weeksWithData,
    grandTotal: Math.round(grand * 100) / 100,
    byWeek: wanted
  };
  Logger.log('ORDERMENTUM @ LEIBLE NORTH IN SUMMARY: ' + JSON.stringify(out, null, 2));
  return out;
}
