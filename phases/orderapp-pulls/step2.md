# Step 2: shopify-weekly-pull

## Requirements Covered

- `PRD-10` — Shopify online weekly revenue via Order-app read API: pull the last 4 completed ISO weeks of `?api=shopifySales` and upsert Summary rows (`kind=revenue`, `supplier=shopify_orderapp`, `location=online`, `department=Roastery`)

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself — set `"status": "needs_context"` and stop.

## Files to Read

- `connectors/gas/orderapp.gs` (steps 0–1: fetch wrapper, run accounting, week helpers)
- `connectors/gas/Code.gs` :29 (`SUMMARY_HEADERS`), :65 (`SUMMARY_KEY_COLS = [0,6,7,2,3]`), :104 (`withScriptLock_`), :535 (`upsertRows_` — updates ONLY amount+stamp in place on key match), :645 (`labourWeeklyPull_` — the Summary-direct precedent), :734 (`ensureSheet`), :1606 (`aggregateSupplierRows_` — read how online revenue groups are keyed by `source`; this is why the supplier token below must NOT be `'shopify'`), :1700 (`weeklySummarize`)
- `connectors/gas/test_code.js` :1031–1120 (UrlFetchApp swap pattern)

## Task

Add to `connectors/gas/orderapp.gs`:

```js
var SHOPIFY_REPULL_WEEKS = 4;
function shopifyWeeklyPull() { /* orderAppRunStart_('shopify_orderapp') BEFORE lock; withScriptLock_ wrapper; lock timeout → loud log + return {locked:true} (run stays counted as incomplete) */ }
function shopifyWeeklyPull_impl_() { /* → {weeksRequested, weeksFetched, rowsAdded, rowsUpdated, duplicatesSkipped, noToken?, apiFailed?} */ }
```

Behavior of `shopifyWeeklyPull_impl_()`:

1. For each of `lastCompletedWeeks_(todayStr_(), SHOPIFY_REPULL_WEEKS)` call
   `orderAppFetch_({api:'shopifySales', week: label})`. The Order-app response (success):
   `meta.weekStart` / `meta.weekEndExclusive` (Sydney-local ISO datetime strings),
   `summary: {orderCount, grossSales}` — zero-sales weeks return real zeros, write them.
   `meta.snapshot` documents the figure is live — that is why past weeks are re-pulled;
   a changed gross must UPDATE the existing Summary row in place.
2. Build one Summary row per successful week in `SUMMARY_HEADERS` order:
   `[meta.weekStart.slice(0,10), addDaysStr_(weekStart, 6), 'shopify_orderapp', 'online', summary.grossSales, pulledAt, 'Roastery', 'revenue']`.
   **The supplier token is `'shopify_orderapp'` — never `'shopify'`.** Reason:
   `aggregateSupplierRows_` names online Revenue-tab groups by their `source`, so a
   Revenue row with `channel='online', source='shopify'` would produce the byte-identical
   Summary key and the 04:00 `weeklySummarize` and this 05:00 pull would silently
   overwrite each other's total (last-write-wins, no divergence signal).
3. One batched `upsertRows_(summarySheet, rows, SUMMARY_KEY_COLS, 4, 5)` call
   (`SUMMARY_TOTAL` col 4, stamp col 5; use `ensureSheet(ss, 'Summary', SUMMARY_HEADERS)`).
4. `orderAppRunSuccess_('shopify_orderapp')` ONLY if every requested week fetched ok.
   Partial success still writes the successful weeks but does NOT reset/stamp
   (`apiFailed:true` in the return).
5. Token unset → `{noToken:true}`, nothing written, no heartbeat.

### Test First (TDD step)

Test cases (defined at design time — these are "done"):
- 4 mocked weeks → 4 Summary rows, exact column order above, dates are `yyyy-MM-dd` strings
- re-run with one week's gross changed → that row updated in place (amount + stamp), other 3 counted `duplicatesSkipped`, row count unchanged (settling-order case)
- one of 4 weeks returns `{ok:false,error:'UPSTREAM'}` → other 3 written, return has `apiFailed:true`, heartbeat NOT stamped, counter NOT reset
- zero-sales week (`grossSales:0, orderCount:0`) → a real `0` row is written
- key-disjointness: run `weeklySummarize` over a Revenue fixture containing `channel='online'` rows with `source='shopify'` and `source='coffee_order_app'` → NO Summary row keyed `supplier='shopify_orderapp'` is produced by it (proves the two writers can never collide)
- Sheet Date read-back: write rows, mock the sheet returning `Date` objects for the date columns, re-run pull with identical data → still dedups (exercises `coerceDateStr_`/`rowKey_` local-component coercion)
- lock timeout path: `withScriptLock_` denied → loud log, `{locked:true}` returned, `orderAppRunStart_` was already called (counter incremented), nothing written
- token unset → `{noToken:true}`, sheet untouched

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

## Verification Procedure

1. Run the AC command.
2. Checklist: Summary written ONLY through `upsertRows_` with `SUMMARY_KEY_COLS`; supplier token `shopify_orderapp` everywhere (grep the diff for `'shopify'` writes — none may target Summary); heartbeat source is `shopify_orderapp`.
3. Update this step in `phases/orderapp-pulls/index.json`.

## Prohibitions

- Do not write the current (incomplete) ISO week. Reason: a partial gross frozen in Summary is indistinguishable from a final figure to doGet consumers; `weeklySummarize` refuses incomplete weeks for the same reason.
- Do not use supplier token `'shopify'` in any Summary row. Reason: byte-identical key collision with `aggregateSupplierRows_` online grouping (see Task §2).
- Do not append rows to Summary with raw `appendRow`/`setValues` outside `upsertRows_`. Reason: the upsert key set IS the dedup contract.
- Do not use `toISOString()` on any date. Reason: AEST off-by-one gotcha.
- Do not break existing tests.
