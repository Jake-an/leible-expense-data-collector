# Step 6: phase-review-fixes

## Requirements Covered

- `PRD-12` — Summary self-heal window
- `PRD-13` — Summary drift guard

Remediation step. The phase-end review gate returned REVISE twice; round 1's CRITICAL is
closed, and this step closes round 2's 2 IMPORTANT + 3 MINOR. Steps 2-4 remain `completed`
because they implemented their specs correctly — these are cross-cutting defects the
per-step reviews could not see.

## Files to Read

- `connectors/gas/Code.gs` — `healRaiseAlert_` at :1949-1965, `healWeek_` alert call at ~:2015, `aggregateSupplierRows_` grouping at :1749-1756, `rowKey_` normalization, `upsertRows_` at :609-649 (the `duplicatesSkipped` branch at :642), `healEarliestBackupRows_` at :1902
- `connectors/gas/staleness.gs` — `raiseCalendarAlert_` and `stalenessResolveColor_` (the correct colour-by-string-key pattern)
- `connectors/gas/summary_audit.gs` :666 (approval-staleness gate), :126-140 (how the audit sees the collision)
- `phases/summary-self-heal/step4.md` — its Prohibitions and Verification Procedure #2

## Task

### FIX 1 — IMPORTANT. Route `healRaiseAlert_` through `raiseCalendarAlert_`.

`healRaiseAlert_` (`Code.gs:1949-1965`) hand-rolls a second calendar path and breaks three
of step 4's contracts:

- **(a) Prohibition violation.** It references `CalendarApp.EventColor` directly at
  `Code.gs:1958`. step4.md says verbatim "Do not reference `CalendarApp` outside
  `staleness.gs`", and step4.md's Verification Procedure #2 ("confirm by grep that
  `CalendarApp` appears in no file other than `staleness.gs`") fails today because of it.
  `raiseCalendarAlert_` takes the colour as a string KEY and resolves it via
  `stalenessResolveColor_` inside `staleness.gs` — call it.
- **(b) No idempotency.** `raiseCalendarAlert_` dedupes via the "titles already on the day"
  read; `healRaiseAlert_` does not, so every re-run creates ANOTHER all-day event for the
  same week. `healWeeks_` heals up to 4 weeks per run and every `greenBeanPull_` override
  routes through `weeklySummarize`, so a persistently-drifted week spams duplicate events
  on the exact channel meant to signal real corruption.
- **(c) Blob description.** step4.md requires `bodyLines` as an ARRAY so "callers must not
  hand-build one long blob"; `healWeek_` passes `alertDetail.join('\n\n')`.

**Accurate scope note — do not overstate the fix.** The "staleness.gs is the SOLE source of
the CalendarApp scope" invariant is *already false* independently of this phase:
`orderapp.gs:176` and `orderapp.gs:212` both reference `CalendarApp.EventColor` and predate
it. Fix `Code.gs:1958` because it is this phase's regression and because (b) and (c) are
real defects. Do **not** silently refactor `orderapp.gs` here — that is a separate,
pre-existing concern; note it in `TODO.md` instead.

### FIX 2 — IMPORTANT. Normalization mismatch loses money and can never converge.

`aggregateSupplierRows_` groups on RAW strings (`Code.gs:1753`:
`department + '||' + kind + '||' + name + '||' + location`, case- and whitespace-sensitive)
while `rowKey_` normalizes with `.trim().toLowerCase()`. Two source rows differing only by
case or trailing space produce TWO groups but ONE key, and `upsertRows_` discards the
second as `duplicatesSkipped` **without ever summing it** (`Code.gs:642`).

Verified empirically by the reviewer with a probe: source rows
`Mayers`/`Leible North`/$100 and `mayers `/`leible north`/$250 (source total $350) produce
2 groups, 1 distinct `rowKey_`, and `upsertRows_` returns `{rowsAdded:1, duplicatesSkipped:1}`
leaving `Summary` at **$100 — $250 silently lost**.

Worse, it can never converge. A second heal returns
`{rowsAdded:0, rowsUpdated:0, duplicatesSkipped:2}`: `healWeek_` reports `action:'heal'`,
`rowsUpdated:0`, raises no alert and flags no orphan — indistinguishable from "already
correct". Meanwhile `auditSummaryDrift_` (`summary_audit.gs:126-140`) DOES see it and
pushes a stale entry, so `checkSummaryDrift` alerts every Monday forever with no available
remediation. That is exactly the un-actionable recurring alert step 4's SPLIT suppression
exists to prevent, except here the heal claims success.

`aggregateSupplierRows_` and `upsertRows_` are both pre-existing and unmodified by this
phase, so this is **inherited, not introduced** — but the phase promotes it from a one-shot
summarize bug into a self-heal that re-asserts the understated total across a rolling
4-week window while the new guard alarms indefinitely.

**Fix:** group in `aggregateSupplierRows_` using the same `.trim().toLowerCase()`
normalization `rowKey_` uses, so collisions SUM instead of splitting. Keep the original
raw `supplier`/`location`/`department` of the first row seen for display. Additionally,
treat a non-zero `duplicatesSkipped` on the heal path as a **reportable condition**, not
silence — a silent discard on a money path is what made this invisible.

**⚠️ EXPECTED CONSEQUENCE — flag it, do not hide it.** This makes the audit's recomputed
totals correct where they were previously split, so the drift figure may legitimately
MOVE off `$288,852.51`. That is a fix revealing itself, not a regression. Re-derive the
number, record the delta and its cause in `TODO.md`, and update the Verification step that
asserts `$288,852.51` so it asserts the newly re-derived figure with the reason recorded.

### FIX 3 — MINOR. `healRaiseAlert_` has zero test coverage.

`grep 'Summary heal|healRaiseAlert|createAllDayEvent'` in `test_code.js` matches nothing
for this path. Add coverage as part of FIX 1: colour-by-key, idempotency within a day,
`bodyLines` array, and that a broken calendar cannot throw out of it.

### FIX 4 — MINOR. Approval-staleness gate fails OPEN.

`summary_audit.gs:666` — `var stale = !!approved && typeof approved.approvedAt === 'number' && (...)`.
A malformed approval record (missing or non-numeric `approvedAt`) makes `stale` FALSE, so
the delete proceeds. A gate that cannot read its own approval must fail CLOSED. Invert it:
treat a missing/unparseable `approvedAt` as stale and refuse.

### FIX 5 — MINOR. Remove the orphan helper.

`healEarliestBackupRows_` (`Code.gs:1902`) has no production caller — `grep` across
`connectors/` returns only its own definition. Either wire it into the documented restore
path (the "earliest snapshot per week" rule) or delete it. Dead code on a restore path is
worse than absent code: it reads as an available recovery mechanism that nothing invokes.

## Test First

Confirm each FAILS before implementing.

1. Two source rows differing only by case/trailing space SUM into one Summary row at the
   full total (the $350 case), not $100.
2. A second heal of that week reports convergence — no perpetual `duplicatesSkipped`.
3. Non-zero `duplicatesSkipped` on the heal path is reported, not silent.
4. `auditSummaryDrift_` no longer reports a phantom stale entry for the case-variant week.
5. `healRaiseAlert_` creates no second event for the same week+kind on a same-day re-run.
6. `healRaiseAlert_` passes `bodyLines` as an array.
7. `grep CalendarApp` finds no match in `Code.gs`.
8. A broken calendar cannot throw out of the heal alert path.
9. A malformed/missing `approvedAt` makes the sweep refuse (fails CLOSED).
10. `healEarliestBackupRows_` is either called by production code or gone.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
python -m pytest -q
grep -n "CalendarApp" connectors/gas/Code.gs   # must return nothing
```

## Verification Procedure

1. Run all three AC commands.
2. Mutation-test FIX 2: revert the normalization and confirm test 1 goes red.
3. Re-run the phase gate. It must return `approve`.

## Prohibitions

- Do not refactor `orderapp.gs`'s pre-existing `CalendarApp` references here. Reason: separate pre-existing concern; record it in `TODO.md` instead of widening this step.
- Do not make the approval gate fail open under any circumstance. Reason: it guards the only path that deletes `Summary` rows.
- Do not suppress the drift figure change from FIX 2. Reason: it is a real correction; hiding it would recreate exactly the silent-understatement class this phase exists to close.
- Do not change `aggregateSupplierRows_`'s displayed supplier/location casing. Reason: `doGet` consumers and `LEIBLE_GM_COST_MONITOR`'s location mapping read those strings.
- Do not break existing tests.
