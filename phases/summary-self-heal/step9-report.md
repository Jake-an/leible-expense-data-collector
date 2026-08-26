# Step 9 — bounded-closeout (FINAL STEP, repair-only)

One bounded round per Jake's 2026-08-26 decision: fix what's named below, freeze
regardless of the next phase-gate verdict, write anything requiring new surface
to `TODO.md` instead of building it.

## FIX1 (IMPORTANT) — falsified backup baseline for a newly-summarized week

`healBackupWeek_` (`Code.gs`) now writes an explicit **empty-baseline marker**
row (`kind = SUMMARY_HEAL_EMPTY_MARKER_KIND_ = 'empty-baseline'`, `total = 0`)
into `Summary_heal_backup` when a week's first heal finds ZERO live Summary
rows, instead of leaving the week's backup marker absent. `healWeeks_`'s
`backedUpWeeks` seed (built from rows physically present in the backup tab)
now correctly recognizes the week as already handled on the next run, so it
never re-snapshots its own post-heal output as "the earliest baseline".

`restoreWeekFromHealBackup_` recognizes the marker (`SUMMARY_KIND_COL`) and
skips re-inserting it into live `Summary` — restoring an empty baseline now
correctly means "delete the live rows, add nothing back", not "insert a blank
row". `restoredCount` now reflects rows actually appended, not
`snapshotRows.length` (which would over-count by 1 for a marker-only restore).

## FIX2 (IMPORTANT) — preview window didn't match the real heal window

`previewSummaryHeal` (`summary_audit.gs`) now sizes its window from
`summaryHealWindowSize_()` — the same function `weeklySummarize_impl_` uses —
instead of a hardcoded `4`. Preview and apply can no longer diverge on the one
pre-flight look an operator gets before a real heal runs. One pre-existing
test (`test_code.js` — "reports exactly the 4-week window") asserted the OLD,
divergent behavior; updated to assert the corrected 1-week default (kill
switch off), since that was the bug this fix exists to close.

## FIX3 (IMPORTANT) — orphan sweep deleted by stale cached index, no lock

`runSummaryOrphanSweep` (`summary_audit.gs`) now wraps its backup+delete in
`withScriptLock_`, matching every other Summary write path. Inside the lock,
each candidate's identity is re-verified against a **fresh** `getDataRange()`
read (full `SUMMARY_KEY_COLS` tuple via `rowKey_`, never the cached index
alone) — any mismatch aborts the WHOLE sweep before a single backup row or
delete happens. A held lock also aborts cleanly (no throw, zero deletes,
`{mode:'aborted', aborted:true, ...}`).

## FIX4 (MINOR) — Labour alert bypassed the shared calendar-events cache

`healWeeks_` now returns `calendarEventsCache` (the same cache object its
internal `ctx` used for every `healWeek_` correction alert), and
`weeklySummarize_impl_`'s Labour correction alert passes it through to
`healRaiseAlert_`. One `getEventsForDay` read for the whole batch, not two.

## FIX5 (MINOR) — no date validation in listSummaryHealBackups

`listSummaryHealBackups` now skips any backup row whose `coerceDateStr_`
result fails `DATE_ARG_RE`, matching the guard `auditSummaryDrift_`/
`computeHealPlan_` already apply — a blank/malformed date cell no longer
produces a `''` week entry.

## FIX6 (MINOR) — recurring `tdd_state: green_done`

Step 8's `tdd_state` was already `red_done` in the working tree at dispatch
(fixed by an earlier session pass) — verified via `grep -n "green_done"
phases/summary-self-heal/index.json` (no matches). No index.json change
needed for this fix. Added a `TODO.md` "known open" line recording that step
subagents keep hand-writing this value and that the harness should reject
unknown `tdd_state` values at write time.

## Verification

- `node connectors/gas/test_code.js` — **1616 passed, 0 failed**.
- `python -m pytest -q` — **485 passed**.
- `git diff --stat` on `connectors/gas/{Code,summary_audit}.gs` — zero
  `function` lines added or removed (`git diff ... | grep -E '^\+function |^\-function '`
  returned nothing): repair-only, confirmed.
- Mutation-tested FIX1 (removed the empty-baseline marker write — 3 of the
  FIX1 assertions correctly went red) and FIX3's stale-index guard (removed
  the fresh-identity re-verification loop — 4 of the FIX3 test2 assertions
  correctly went red), then restored both and re-confirmed full green
  (1616/0, 485 pytest).

## Known open (written to TODO.md, not built this step)

- Step 6's tdd_state recurrence (FIX6) — harness should reject unknown
  `tdd_state` values at write time.
