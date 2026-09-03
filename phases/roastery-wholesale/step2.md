# Step 2: wholesale-paging

## Requirements Covered

- `PRD-14` — the producer pages `orders[]` only; every summary/diagnostic bucket is
  computed over the full unpaged scan. This step collects a week's orders safely.

If the Task below contradicts the requirement, `docs/ADR.md`, or a CRITICAL rule in
CLAUDE.md, set `"status": "needs_context"` with the contradiction spelled out and stop.

## Files to Read

- `connectors/gas/orderapp.gs` — especially `orderAppFetch_` (`:81-102`),
  `orderAppClassifyResponse_` (`:53-74`), `greenBeanFetchAllRows_` (the existing
  offset-paginated fetcher — mirror its abort discipline), and the constants + gate you
  added in step 1.
- `phases/roastery-wholesale/prod-probe.md` — note that today `matched` is 5–7 against
  `limit=200`, so this code path will not page in practice. Build it correctly anyway.

## Task

Add `wholesaleFetchWeekOrders_(week)` to `connectors/gas/orderapp.gs`.

`week` is a `lastCompletedWeeks_` entry `{label, start, end}`. Returns:

```
{ok:true, orders:[…], summary:<page-0 summary>, meta:<page-0 meta>}
|  {ok:false, reason:'<why>'}
```

Algorithm:
1. `offset = 0`, `collected = []`, `seen = {}`, `pages = 0`.
2. Loop: `orderAppFetch_({api:'wholesaleSales', week: week.label,
   limit: WHOLESALE_PAGE_LIMIT, offset: offset})`.
   - A non-`ok` fetch result → return `{ok:false, reason:'fetch: ' + res.reason}`.
   - Run `wholesaleValidWeekBody_(res.body, week)` on **every** page. Any `ok:false` →
     return `{ok:false, reason:'page ' + pages + ': ' + gate.reason}`.
3. On page 0, capture `summary` and `meta` — these are the authoritative unpaged figures.
   On every later page, `meta.paging.matched` MUST equal page 0's `matched`; if it shifts,
   the sheet changed underneath the scan → return `{ok:false, reason:'matched shifted …'}`.
4. Append each order, skipping any `orderId` already in `seen` (dedup across pages).
5. `offset += body.orders.length`. If `body.orders.length === 0` while
   `collected.length < matched`, the producer is not advancing → return
   `{ok:false, reason:'short page …'}`.
6. `pages++`; if `pages > WHOLESALE_MAX_PAGES` → return `{ok:false, reason:'page cap …'}`.
7. Stop when `collected.length >= matched`. Then require `collected.length === matched`
   exactly; anything else → `{ok:false, reason:'collected N !== matched M'}`.

### Test First (TDD step)

Replace `orderAppFetch_` with a stub per test. The suite's loader makes every `.gs`
top-level `var` a writable property of `globalThis`, so assign the stub, and restore the
original in a `finally` block.

Test cases (defined at design time — these are "done"):
- single page, `matched: 6`, 6 orders → `ok:true`, 6 orders, `summary` is page 0's
- three pages (`matched: 450` at `limit: 200` → 200/200/50) → `ok:true`, 450 orders,
  and the offsets requested were 0, 200, 400
- **`summary` returned is page 0's, unchanged**, even when later pages carry different
  `summary` values — assert the exact object, proving pages are never summed
- `matched` changes from 450 to 400 on page 2 → `ok:false`, reason names the shift
- a page repeats an `orderId` already seen → it is counted once, and the short-count
  guard then fires rather than silently returning fewer orders than `matched`
- a page returns `orders: []` while `collected < matched` → `ok:false`, reason `short page`
- more than `WHOLESALE_MAX_PAGES` pages → `ok:false`, reason names the cap
- page 1 passes the gate but page 2 has `diagnostics.moneyOk: false` → `ok:false`,
  reason names the page index — proves every page is re-gated, not just the first
- `orderAppFetch_` returns `{ok:false, reason:'no-token'}` → `ok:false`, reason carries it
- a zero-activity week (`matched: 0`, `orders: []`) → `ok:true` with `orders: []`
  and no second fetch issued

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

## Verification Procedure

1. Run the AC command. Record pass/fail counts.
2. Confirm by reading the code that no total is ever accumulated across pages — the only
   money that leaves this function is page 0's `summary` object.
3. Mutation check: delete the `matched`-stability check and confirm that test reds. Revert.
4. Update this step in `phases/roastery-wholesale/index.json`.

## Prohibitions

- Do not sum paged `orders[]` to rebuild a weekly total. Reason: paging covers `orders[]`
  ONLY; `summary`, `diagnostics`, `orphanRows`, `undatedRows`, `outOfWeekRows` and
  `excluded` are all computed over the producer's full unpaged scan. A page-sum would
  disagree with the producer's own authoritative figure and defeat step 4's cross-foot.
- Do not gate only the first page. Reason: the sheet is read live on every request, so a
  later page can be internally inconsistent while the first was clean.
- Do not request a `limit` above the producer's 500 max. Reason: it clamps silently rather
  than erroring, so the request you think you sent is not the one it served.
- Do not break existing tests.
