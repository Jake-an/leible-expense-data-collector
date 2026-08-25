# Step 2 — guarded-shared-write-path

## What was built

- `SUMMARY_HEAL_BACKUP_TAB` ('Summary_heal_backup') / `SUMMARY_HEAL_BACKUP_HEADERS`
  (`SUMMARY_HEADERS` + `run_id`) — Code.gs constants.
- `SUMMARY_HEAL_WEEKS_` (default 4, in-code) vs `SUMMARY_HEAL_WEEKS` (Script
  Property override, no trailing underscore) — two names, two things.
- `healEarliestBackupRows_(backupRows, week)` — pure, resolves a restore to the
  earliest snapshot per week.
- `healBackupWeek_(week, ctx)` — snapshot-once backup of a week's live Summary
  rows to the backup tab, write-once (refuses to overwrite an existing
  snapshot for that week).
- `healRaiseAlert_(week, kind, detail, highSeverity)` — one calendar alert per
  call, RED for a SPLIT-skip/duplicate-refusal of the newest week, ORANGE
  otherwise. Reuses `stalenessCalendar_()`.
- `healWeek_(week, ctx, isNewest)` — the ONE guarded per-week write: backup →
  SPLIT guard → duplicate-key refusal → one `upsertRows_` call → correction
  alert (raised immediately, off actual `updates`, never on a bare append).
- `healWeeks_(weeks)` — shared entry point. Builds `ctx` once (one `_archive`
  read, one Summary snapshot) for the whole batch, sorts newest-first
  regardless of input order, and treats a refused/skipped NEWEST week as a
  loud run-level failure (`success:false`, `newestWeekFailed:true`) without
  failing the run for an older week's refusal.
- `weeklySummarize_impl_` rewired: both the scheduled run and every override
  (including every `greenBeanPull_` override call) now route through
  `healWeeks_`/`healWeek_`. Branch differences reduce to exactly two: week
  selection (kill switch via `summaryHealWindowSize_()`) and archive/purge
  (scheduled only, still exactly once). Labour is pulled once per batch, only
  for weeks that actually healed (never a SPLIT/refused week), and its own
  correction is alerted separately. The pre-existing flat return shape
  (`weekStart`/`weekEnd`/`summariesAdded`/`summariesUpdated`/
  `labourTabAdded`/`labourSummaryAdded`/`refused`) is preserved whenever
  exactly one week is processed (every override, and a scheduled run with the
  kill switch off) — this is what every pre-existing caller/test depends on.

## Verification

- `node connectors/gas/test_code.js` — 1412 passed, 0 failed (every case in
  the step's Test First list, plus the full pre-existing suite).
- Mutation test (SPLIT guard): short-circuited the guard's condition
  (`if (false && (...))`), re-ran — 15 tests failed as expected (guard is
  load-bearing), then restored and confirmed 1412/0 again.
- Diff read against every Prohibition: no per-week `ctx` build, no
  pull-owned/supplier-list filtering, no `Summary` row deletion, no bare
  `new Date()` in new code (`new Date(Date.now())` throughout), no
  `summariesAdded + summariesUpdated` success check.

## One pre-existing test updated

`orderapp.gs`'s round-9 orphan test (`noinv date-move`, test_code.js ~6291)
expected exactly 1 calendar event. With PRD-12's correction alert now live,
the queued `weeklySummarize(week)` call for that same week raises a SECOND,
separate alert because the week's total genuinely moved 400 → 800 (the very
double-count the orphan alert explains) — two real, independent signals for
the same underlying stale row, not a regression. Updated the expected count
from 1 to 2; the existing checks on `calendarEvents[0]` (still the orphan
alert, raised first) are unchanged and still pass.
