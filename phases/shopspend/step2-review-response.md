# Step 2 review response — round 1

## Finding 1 [critical] Code.gs:218 — incomplete `shopspend` row validation

**Verdict: CONFIRMED, fixed.**

Read the `kind === 'shopspend'` branch (Code.gs:217-225 pre-fix) against step2.md:38-41. The brief
requires validating `week_end` presence and numeric-ness of `total_ex_gst`, `gst`, `total_inc_gst`,
`order_count`, `amended_count`. The implementation only checked `shop_id`, `week_label`,
`week_start`, and `total_ex_gst` — `week_end`, `gst`, `total_inc_gst`, `order_count`,
`amended_count` were unchecked.

Fix: added `if (!r.week_end)` and the four `isNaN(Number(x))` checks, same idiom as the existing
`total_ex_gst` / `revenue.amount` checks. `node connectors/gas/test_code.js` → 555 passed, 0
failed (no new test cases added — this is scope-limited to the finding, not new coverage).

## Finding 2 [important] Code.gs:150 — `ingestShopSpendRows` signature mismatch

**Verdict: CONFIRMED as a real deviation, but the suggested "revert to spec" fix is not viable —
applied the suggested alternative (document why) instead.**

step2.md:48-51's snippet calls `ingestShopSpendRows(source, rows, extracted_at, tabs.data, pull)`
— 5 args, no pulls-sheet reference. The implementation calls it with 6 args, inserting
`tabs.pulls` before `pull`. Confirmed by diff: `connectors/gas/Code.gs:150-153`.

Checked whether the spec's 5-arg form is actually satisfiable: step2.md:54-56 (same doc, two lines
below the snippet) says "when present, one row is written to the `ShopSpendPulls` tab" — writing
to a sheet requires a `Sheet` object reference. The 5-arg form passes no such reference (`tabs.data`
is the ShopSpend data sheet, not ShopSpendPulls), so `ingestShopSpendRows` could not fulfill the
pulls-row requirement it's the same step's brief specifies without receiving `tabs.pulls`
somehow — either as a 6th param (implementation's choice) or by having the callee call
`ensureShopSpendTabs_` itself (worse: duplicates tab resolution, breaks the "resolve tabs once in
doPost" pattern used by every other kind). The "Pulls row" test case (step2.md:91-92) exercises
this and passes only because `tabs.pulls` is threaded through.

Conclusion: the 6-arg signature is functionally required, not a stylistic drift. Applied the
finding's suggested option (2) — added an inline comment at the call site (Code.gs:150-152)
explaining the deviation from step2.md:48-51 and why `tabs.pulls` is needed. No behavior change.
