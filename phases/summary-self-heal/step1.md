# Step 1: primitives-report-what-they-did

## Requirements Covered

- `PRD-12` — Summary self-heal window (the correction alert must be driven by what actually changed; today the primitives do not report it)

If the Task section contradicts `docs/ADR.md` or a CRITICAL rule in CLAUDE.md, set
`"status": "needs_context"` with the contradiction spelled out, and stop.

## Files to Read

- `connectors/gas/Code.gs` — `upsertRows_` at :609–649 (note it returns counts only), `labourWeeklyPull_` at :719–786 (note the return at :781 drops `rowsUpdated`), `weeklySummarize_impl_` at :1806
- `connectors/gas/orderapp.gs` :379–410 (a second `upsertRows_` caller that must keep working unchanged)
- `connectors/gas/test_code.js` — existing `upsertRows_` and labour cases

## Task

### 1. `upsertRows_` reports which rows changed

Add `updates: [{key, from, to}]` to the returned object. `rowsAdded`, `rowsUpdated` and
`duplicatesSkipped` keep their exact current meaning and position — every existing caller
(`weeklySummarize_impl_`, `labourWeeklyPull_`, `shopifyWeeklyPull`, `greenBeanPull_`,
`summary_drift_repair.gs`) reads those and must be unaffected.

`updates` records only rows that were actually written — a row whose existing amount
equalled the new amount is `duplicatesSkipped`, not an update, and must NOT appear.

This is what the correction alert is driven from. It replaces the week-age heuristic an
earlier draft used, which was blind to a genuine correction on the newest week and would
have false-alerted on labour and directly-written rows.

### 2. `labourWeeklyPull_` reports updates and takes a week list

Two changes:

- Return `summaryUpdated` alongside `summaryAdded`. Today (`Code.gs:781`) it returns only
  `summaryAdded: summaryResult.rowsAdded` and silently drops `rowsUpdated`, so a heal that
  corrects four weeks of labour returns `labourSummaryAdded: 0` — indistinguishable from
  "nothing happened", on a path whose verification instruction is "read the returned counts".
- Accept a **week list** instead of a single week, filtering the external `LABOUR_COST`
  source once. Today it filters `if (ws !== week.start) continue` and re-reads the whole
  external sheet per call; a naive 4-week loop would pay four cross-spreadsheet reads.

Keep the single-week call shape working (pass a one-element list) so the current caller is
a trivial edit.

## Test First

Write these in `connectors/gas/test_code.js` and confirm they FAIL first.

1. `upsertRows_` returns `updates` with `{key, from, to}` for each row it actually rewrote.
2. A row whose amount is unchanged appears in `duplicatesSkipped` and **not** in `updates`.
3. A brand-new row appears in `rowsAdded` and **not** in `updates`.
4. `rowsAdded` / `rowsUpdated` / `duplicatesSkipped` keep their existing values for every
   pre-existing test scenario (regression guard for the other four callers).
5. `labourWeeklyPull_` returns `summaryUpdated` and it is non-`undefined`.
6. A labour correction (changed total for an already-summarized week) surfaces as
   `summaryUpdated >= 1`, not as a silent zero.
7. `labourWeeklyPull_` given a 4-week list reads the external source **once** — assert the
   mock's source-sheet `getDataRange` call count is 1, not 4.
8. `labourWeeklyPull_` given a one-element list behaves exactly as the old single-week call.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js   # all suites green, including every case above
```

## Verification Procedure

1. Run the AC command.
2. Confirm by reading the diff that no existing caller's use of `rowsAdded`/`rowsUpdated`
   changed meaning — green tests alone do not prove this (documented project lesson:
   555/555 passing once masked a prohibition violation because the fixture lacked the
   case that would expose it).
3. Update this step in `phases/summary-self-heal/index.json`.

## Prohibitions

- Do not change the existing keys or semantics of `upsertRows_`'s return object. Reason: four other callers and the repair tooling read them.
- Do not add a delete path to `upsertRows_`. Reason: orphan removal is Step 3's gated, backed-up, manual path — never an automatic write.
- Do not filter any supplier list out of the batch. Reason: see Step 0 Prohibitions; this was a CRITICAL caught in plan review.
- Do not use bare `new Date()`. Reason: `withMockNow` patches only `Date.now()`.
- Do not break existing tests.
