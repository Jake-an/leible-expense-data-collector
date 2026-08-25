# Step 6 — phase-review-fixes report

Closed round 2's 2 IMPORTANT + 3 MINOR phase-gate findings. 1517 passed, 0 failed
(`node connectors/gas/test_code.js`); `python -m pytest -q` 485 passed.

## FIX 1 (IMPORTANT) — `healRaiseAlert_` routes through `raiseCalendarAlert_`
`Code.gs` no longer references `CalendarApp` directly. `healRaiseAlert_(week, kind,
bodyLines, highSeverity)` builds the stable title and delegates to
`raiseCalendarAlert_` (`staleness.gs`) for color resolution, idempotency-within-a-day,
and the `bodyLines.join('\n')`. All 3 call sites (`healWeek_`'s SPLIT/duplicate-refusal
branch, `healWeek_`'s correction/orphan alert, `weeklySummarize`'s labour-correction
alert) now pass an array, not a hand-joined blob. `orderapp.gs`'s two pre-existing
`CalendarApp.EventColor` references are untouched per the step's Prohibition — logged
as a separate pre-existing concern, not this phase's regression.

## FIX 2 (IMPORTANT) — `aggregateSupplierRows_` normalization
Groups now key on `.trim().toLowerCase()` per field, matching `rowKey_` exactly, so a
case/whitespace-only twin SUMS into one group instead of splitting into two that
collapse onto the same Summary key and get silently discarded by `upsertRows_`'s
`duplicatesSkipped` branch. Displayed `supplier`/`location` still keep the first-seen
raw casing (prohibition honored — doGet/GM_COST_MONITOR consumers unaffected). Shared
by both spend and revenue aggregation, and by `auditSummaryDrift_`, so the fix and its
convergence apply uniformly.

**Consequence, recorded in TODO.md:** a pre-existing, explicitly-pinned test
(`mixed channel casing collapses to ONE Summary row`) asserted the OLD buggy behavior
(100 + 25 reporting as 25) — updated to assert the corrected sum (125), since it is
the same defect class FIX 2 exists to close. The $288,852.51/143-week write-off is
past the purge line and structurally untouched by this fix (self-heal/drift-guard
never reach those weeks).

## FIX 3 (MINOR) — heal-path coverage + reportable `duplicatesSkipped`
`healWeek_` now returns `duplicatesSkipped` (from `upsertRows_`) and logs a line
naming the week whenever it's non-zero — a silent discard on a money path was exactly
what let FIX 2's defect hide. Covered by the new FIX1/FIX2/FIX3 test block (12 cases).

## FIX 4 (MINOR) — orphan-sweep approval gate fails CLOSED
`summary_audit.gs`'s `runSummaryOrphanSweep` now treats a missing/non-numeric
`approvedAt` as unusable (fails closed), not as "not stale" — previously a malformed
approval record could pass the staleness check and let the delete proceed.

## FIX 5 (MINOR) — `healEarliestBackupRows_` wired to a real caller
Added `restoreWeekFromHealBackup_(week)` (Code.gs, next to the pure helper) — the
manual, by-hand "Data undo" path TODO.md already documented ("restore the affected
week from the earliest Summary_heal_backup snapshot"). Deletion was not viable: a
pre-existing step-2 test calls `healEarliestBackupRows_` directly, so removing it
would violate "do not break existing tests."

## Docs touched
`docs/api.md`, `docs/ingest-contract.md` — corrected the mixed-casing warnings to
describe the fixed (sums correctly, casing display is still first-seen-wins)
behavior instead of the old silent-loss behavior.

## Verification performed
- Mutation test: reverted FIX 2's normalization line, re-ran the suite — 10 tests
  went red (the exact FIX2/FIX3 cases + the updated mixed-casing regression test),
  confirming the fix is load-bearing. Restored, re-ran green (1517/0).
- `grep -n "CalendarApp" connectors/gas/Code.gs` — no matches.
