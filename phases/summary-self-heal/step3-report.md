# Step 3 — orphan-detection

## What shipped

- `healOrphanCandidates_` (Code.gs) — inside every `healWeek_`, sweeps live `Summary`
  rows for that week against the freshly computed batch. Any live key not in the batch
  is reported as an orphan candidate (`key`, `supplier`, `location`, `total`). Excludes
  `shopify_orderapp` (pull-owned, structurally unreachable from a recompute). Matches the
  full `SUMMARY_KEY_COLS` tuple via `rowKey_`, never `(week, location)` alone. Detection
  only — no delete call anywhere on this path.
- `healWeek_` folds orphan findings into the week's existing alert (`healRaiseAlert_`)
  instead of raising a second event, so a death between write and alert can't lose the
  notice.
- `summaryOrphanSweep_` / `runSummaryOrphanSweepDryRun()` / `runSummaryOrphanSweep()`
  (summary_audit.gs) — the manual, gated removal half, copying the project's established
  dry-run-then-gated-apply shape:
  - Dry run recomputes every week's batch, logs one line per candidate (never a single
    `Logger.log(JSON.stringify(...))` blob), and records the approved candidate set
    (count + sorted keys) to a Script Property.
  - Apply recomputes fresh and refuses to proceed unless live candidates match the
    approved set exactly; on mismatch it aborts with zero deletes and tells the operator
    to re-run the dry run — it never adjusts the approved count to fit drifted reality.
  - Backs every matched row up to `Summary_orphan_backup` before the first `deleteRow`,
    then deletes bottom-up (descending row index) so earlier indices stay valid.

## The round-9 conflict (resolved by Jake, 2026-08-25)

Implementing the spec as written broke one pre-existing test: `greenBeanPull_`'s
date-move self-heal re-summarizes both the old and new week, and re-summarizing the OLD
week aggregates to no row at all for that key — so the old week's `Summary` row survives
holding the full amount while the new week also gains it. That's a genuine double-count,
not a false positive from this step's detection.

Jake's decision: accept it as a real finding. The round-9 test's expectation changed from
0 alerts to 1, with the full reasoning written into the test body (`test_code.js`, near
the `greenBeanPull_` date-move suite) so it can't be quietly reverted. Every other
pre-existing test still passes. Root-causing the greenbean path itself (having it delete
the stale row automatically) was explicitly rejected — that would add an automatic
`Summary` delete, which this step's Prohibitions forbid and which is unrecoverable for
`shopify_orderapp` rows. Each occurrence needs a manual sweep; that follow-up is recorded
for Step 5's `TODO.md` work.

## Verification

- `node connectors/gas/test_code.js` — 1446 passed, 0 failed, exit 0.
- Mutation test: removed the `shopify_orderapp` exclusion in `healOrphanCandidates_` —
  `shopify_orderapp online row is excluded from orphan candidates` went red (1445/1
  failed), confirming the exclusion is load-bearing. Reverted; suite back to
  1446 passed, 0 failed.
- Diff checked against Prohibitions: no `deleteRow` on the automatic path, no
  `(week, location)`-only matching, no widening of the exclusion to
  `SUMMARY_AUDIT_PULL_OWNED_`, no bare `new Date()`, candidates logged one line each.

## REVIEW FIXES 2026-08-26 (phase-end gate REVISE — 1 CRITICAL, 2 IMPORTANT, 3 MINOR)

The phase-end gate found defects in this step's original spec that no per-step review
caught (RED for these 12 cases already committed in `test(summary-self-heal): step 3 RED
— orphan-detection`). Implemented straight against "REVIEW FIXES 2026-08-26" in
`step3.md`:

- **FIX 1 (CRITICAL)** — `summaryOrphanSweep_` (summary_audit.gs) now recomputes from
  `auditDedupeSourceRows_(supplierRows, archiveRows)`, not `Suppliers` alone; skips any
  week `< auditPurgeCutoff_(todayStr_())` entirely; and skips any SPLIT week (rows in both
  `Suppliers` and `_archive`, same test `computeHealPlan_`/`summaryDriftCheck_` use). Both
  the candidate-recompute loop and the candidate-collection loop apply the purge/SPLIT
  skip identically, so a row for a skipped week can never surface as a candidate.
- **FIX 2 (IMPORTANT)** — `Labour` is now excluded alongside `shopify_orderapp` in both
  `healOrphanCandidates_` (Code.gs:2071) and `summaryOrphanSweep_` (summary_audit.gs),
  matched via `mayersNorm_(supplier) === 'labour'`. `SUMMARY_AUDIT_PULL_OWNED_` itself is
  untouched — greenbean/Bennetts stay derived and in the computed batch, only the two
  structurally-unreachable suppliers (`shopify_orderapp`, `labour`) are excluded from
  orphan detection.
- **FIX 3 (IMPORTANT)** — covered by the RED-phase fixture additions already committed
  (archive-only week, past-purge-line week, Labour row, SPLIT week — all assert zero
  candidates); no further test changes needed in GREEN.
- **FIX 4a** — `summaryDriftCheck_` now short-circuits to
  `{weeksAudited:0, drifted:[], splitSuppressed:[], eventsCreated:0}` when
  `auditSummaryDrift_` returns `{error:...}` (no Summary tab), instead of throwing on
  `report.weeks.length`.
- **FIX 4b** — `previewSummaryHeal` now reads `Summary`/`_archive`/`Revenue` with
  `getSheetByName` + null-guards, matching `summaryOrphanSweep_`'s existing pattern,
  instead of `ensureSheet` (which inserts the tab + header row when absent).
- **FIX 4c** — the dry-run approval Script Property now carries `approvedAt: Date.now()`;
  `runSummaryOrphanSweep` refuses (aborts, deletes nothing) an approval older than
  `SUMMARY_ORPHAN_SWEEP_APPROVAL_MAX_AGE_MS_` (1 hour), on top of the existing exact
  count/keys match.

### Verification (this round)

- `node connectors/gas/test_code.js` — 1497 passed, 0 failed, exit 0 (1485 pre-existing +
  12 newly green).
- Mutation test: removed the `week < purgeCutoff` skip from both loops in
  `summaryOrphanSweep_` — `FIX1: a week past the purge line yields ZERO candidates, not
  "every row is an orphan"` went red (1496 passed, 1 failed), confirming the purge-line
  guard is load-bearing. Reverted; suite back to 1497 passed, 0 failed.
- Diff checked against Prohibitions: no `deleteRow` added on any automatic path, no new
  `(week, location)`-only matching, `SUMMARY_AUDIT_PULL_OWNED_` list itself untouched
  (only two of its four members gained an explicit exclusion check), no bare `new Date()`
  introduced (`Date.now()` used throughout, consistent with `withMockNow`).
