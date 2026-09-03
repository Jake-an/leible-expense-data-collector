# Step 8: live-bring-up

## Requirements Covered

- `PRD-14` — the supervised first live run, and the only point at which the weekly
  trigger is armed.

If the Task below contradicts the requirement, `docs/ADR.md`, or a CRITICAL rule in
CLAUDE.md, set `"status": "needs_context"` with the contradiction spelled out and stop.

## ⚠ This is the one-way door

`upsertRows_` (`Code.gs:712`) is insert/update only — it has **no delete path**. A code
rollback (`clasp redeploy -V`) reverts the code, never the data. The steps below are in
this order for that reason; do not reorder them.

## Files to Read

- `phases/roastery-wholesale/prod-probe.md` — the per-week grosses you will diff against.
- `connectors/gas/orderapp.gs` — `wholesalePull`, `installOrderAppTriggers`.
- `TODO.md`, "Order-app pulls — live bring-up" — the same runbook shape, already executed
  once successfully. Follow its evidence discipline.

## Task

Run these **in order**, recording the real output of each into this step's notes.

**(a) Snapshot — reference only.** Duplicate the `Revenue` and `Summary` tabs in the hub
Sheet (`Revenue_prewholesale_YYYYMMDD`, `Summary_prewholesale_YYYYMMDD`). These exist for
diffing and row-by-row recovery. ⚠ **A wholesale copy-back is prohibited**: restoring a
whole tab would delete rows other producers wrote after the snapshot froze —
`shopify_orderapp` writes `Summary` directly, and `Labour` comes from an external sheet.

**(b) Dry run.** From the Apps Script editor, `wholesalePull({dryRun:true})`. Diff its
per-week bucket grosses against `prod-probe.md`. They should match for the four weeks the
probe covered; a discrepancy means the upstream changed and must be explained before (c).
Note that these pulls **return** their counts and log little — read the return value, do
not wait for a log line.

**(c) Wet run.** `wholesalePull()`. Then probe `doGet` for the completed weeks and confirm:
`kind='revenue'` rows at `location='wholesale'` with the customer name in `supplier`, and
separate rows at `location='internal'`. Confirm the `wholesale` figures match the probe.

**(d) Idempotency.** Re-run `wholesalePull()`. Expect `rowsAdded:0, rowsUpdated:0`, an
unchanged `Revenue` row count, and unchanged `summarized_at` stamps on the Summary rows.

**(e) Negative auth.** Temporarily clear `ORDER_APP_COST_TOKEN` and confirm the run takes
the `noToken` path and writes nothing. Restore it.

**(f) Alerting.** Run `checkIngestStaleness()` and confirm it reaches the calendar. Assert
the event **exists** (title `LEIBLE expense stale: <source>`); `eventsCreated:0` is dedup,
not failure.

**(g) Orphan sweep.** `runSummaryOrphanSweepDryRun()` once. Read-only. Record the
candidates it reports.

**(h) Arm the trigger — only now.** `installOrderAppTriggers()`. Then open the Apps Script
**Triggers page** and confirm all four survived, because it is delete-then-create over its
whole handler list: `shopifyWeeklyPull` Mon 05:00, `greenBeanPull` Tue 05:00,
`wholesalePull` Mon 06:00, `wholesalePullRetry` Mon 07:00 — all `Australia/Sydney`. Never
verify a trigger by reading code; the Triggers page is the only source of truth.

**(i)** Only after (a)–(h) all pass, flip `PRD-14` to `built` in `docs/PRD.md` and write
the runbook receipt into `TODO.md`.

## Removal procedure — carry this verbatim, an operator will need it at 3am

1. Delete every `Revenue` row where `source = 'coffee_order_app'`.
2. Collect the affected `week_start` values and run them through `weeksWithArchivedRows_`.
   **Refuse any week it returns** — exactly as `runFdcoBackfillResummarize` does
   (`Code.gs:1622-1627`). Re-summarizing a split week overwrites a correct `Suppliers`
   total with a partial one, destroying spend figures this connector never touched.
3. `weeklySummarize('<week_start>')` for each surviving week. Assert the return; it
   reports `{refused:…}` rather than throwing, and its counters are `summariesAdded` /
   `summariesUpdated`.
4. Re-probe `doGet` and confirm the `location='wholesale'` and `location='internal'` rows
   are gone.
5. Delete the `wholesalePull` and `wholesalePullRetry` triggers from the Triggers page.

## Acceptance Criteria

Every check in (a)–(h) executed, with its **real** output recorded. A check that was not
run is a check that failed — do not mark this step complete on a partial pass.

## Verification Procedure

1. Re-read this step's notes and confirm every one of (a)–(h) has real output beside it,
   not a restatement of what was expected.
2. Confirm the `Revenue` row count before and after (d) is identical.
3. Confirm on the Triggers page — not in code — that exactly four orderapp triggers exist.
4. Update this step in `phases/roastery-wholesale/index.json`.

## Prohibitions

- Do not run `installOrderAppTriggers()` before (h). Reason: arming the trigger earlier
  makes the first live write unattended and unverified.
- Do not restore a snapshot tab by copying it back wholesale. Reason: it deletes rows
  later producers wrote; the snapshots are for diffing and row-level recovery only.
- Do not re-summarize a week carrying `_archive` rows, in the bring-up or the removal.
- Do not flip PRD-14 to `built` on anything less than a full pass. Reason: PRD-9/10/11
  followed exactly this rule, and green tests are not live verification.
- Do not skip (b) and go straight to the wet run. Reason: the dry run against
  `prod-probe.md` is the only check that the numbers about to be written are the numbers
  that were measured.
