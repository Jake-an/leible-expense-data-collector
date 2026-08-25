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
