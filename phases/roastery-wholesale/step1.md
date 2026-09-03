# Step 1: wholesale-fetch-gate

## Requirements Covered

- `PRD-14` — Roastery wholesale revenue via the Order-app `?api=wholesaleSales` read API.
  This step lays the constants and the **shape gate** every later step depends on.

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `connectors/gas/orderapp.gs` — the whole file. You are adding to it. Study
  `shopifyValidWeekBody_` (`:322-338`); your gate is its sibling and must feel identical.
- `phases/roastery-wholesale/prod-probe.md` — the **measured** PROD response. Build the
  gate against this, not against the DEV-written contract doc.
- `C:/Users/mioja/.claude/projects/LEIBLE_Order_app/docs/wholesale-sales-api.md` — read in
  full. It is the spec, not background.

## Task

Add to `connectors/gas/orderapp.gs`, in the same style as the shopify/greenbean sections:

Constants:
- `WHOLESALE_SOURCE = 'coffee_order_app'` — with a comment noting this source name was
  reserved for exactly this writer in `docs/ingest-contract.md` §1.
- `WHOLESALE_REPULL_WEEKS_ = 8` plus `wholesaleRepullWeeks_()` reading the Script Property
  `WHOLESALE_REPULL_WEEKS`, falling back to the constant when unset or unparseable.
  Comment WHY it is 8 and not `SHOPIFY_REPULL_WEEKS`'s 4: orders enter the window only
  once `Invoice_Status` reaches Finalized/Archived, which lags order-entry date, and
  `Invoice_Total` stays editable afterwards. The step-0 probe saw `excluded` (in-week but
  not yet Finalized) non-zero in 2 of 8 weeks — this lag is real, not theoretical.
- `WHOLESALE_PAGE_LIMIT = 200` — the producer's own default. Comment that the producer
  **silently clamps** an over-cap request (`Math.min(reqLimit, 500)`) instead of returning
  `BAD_REQUEST`, so a mis-set value gives no error signal.
- `WHOLESALE_MAX_PAGES = 20` — page-cap backstop (mirrors `GREENBEAN_MAX_PAGES`).
- `WHOLESALE_GROSS_FLOOR = 800` — heartbeat low-water mark. Comment that it is a
  low-water mark, **not** the median: the worst observed external week was $1,200.30 and
  a median floor (~$1,934) would suppress the heartbeat half the time.
- `WHOLESALE_DIAGNOSTIC_FLAGS_ = ['rowsOk','crossFootOk','moneyOk','partitionOk','byShopOk']`.

Pure function, no Sheet/Properties/UrlFetchApp access:

```
wholesaleValidWeekBody_(body, requestedWeek) -> {ok:true, weekStart, summary, paging}
                                             |  {ok:false, reason:'<why>'}
```

`requestedWeek` is a `lastCompletedWeeks_` entry: `{label, start, end}`. Reject unless
ALL hold:
1. `body` is an object with `body.meta` an object.
2. `body.meta.week === requestedWeek.label` — echo-check the label.
3. `typeof body.meta.weekStart === 'string'` and
   `body.meta.weekStart.slice(0,10) === requestedWeek.start`.
4. `body.summary` is an object carrying `all`, `internal`, `external`, `ambiguous` and
   `unknown` — each an object with a finite `orderCount` and a finite `gross`.
5. `body.diagnostics` is an object and **every** flag in `WHOLESALE_DIAGNOSTIC_FLAGS_` is
   strictly `=== true`. Not truthy — `=== true`.
6. `body.meta.paging` is an object with finite `matched`, `returned`, `limit`, `offset`.
7. `Array.isArray(body.orders)`.

Each rejection `reason` must name the specific failure, in the style of
`shopifyValidWeekBody_` (e.g. `'diagnostics.crossFootOk is not true'`,
`'meta.week 2026-W33 does not echo requested 2026-W32'`).

### Test First (TDD step)

Test cases (defined at design time — these are "done"):
- a full valid body (modelled on the real PROD shape in `prod-probe.md`) → `{ok:true}`
  with `weekStart` and `summary` returned
- `meta.week` disagreeing with `requestedWeek.label` → `ok:false`, reason names the echo
- `meta.weekStart` disagreeing with `requestedWeek.start` → `ok:false`
- each of the five `diagnostics` flags, one at a time, set to `false` → `ok:false` (5 cases)
- a `diagnostics` flag set to a truthy non-`true` value (`1`, `'true'`) → `ok:false`.
  This is the `=== true` requirement; a loose-equality implementation must fail it.
- `summary` missing `external` entirely → `ok:false`
- `summary.external.gross` present but `null` / `'1200.30'` / `NaN` → `ok:false` (3 cases)
- `summary.external.orderCount` non-finite → `ok:false`
- `orders` absent, or an object rather than an array → `ok:false` (2 cases)
- `meta.paging` absent, and `meta.paging.matched` non-finite → `ok:false` (2 cases)
- **a zero-activity week** (`orders: []`, every bucket `{orderCount:0, gross:0}`, all flags
  true) → `{ok:true}`. Zero is finite and this MUST pass the gate. It is step 4's
  heartbeat rule, not this gate, that refuses to call an empty week healthy.
- `wholesaleRepullWeeks_()` returns 8 with no property set; returns 12 with the property
  set to `'12'`; returns 8 with the property set to `'abc'` or `''`

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

All pre-existing tests stay green plus every case above.

## Verification Procedure

1. Run the AC command. Record pass/fail counts.
2. Confirm `wholesaleValidWeekBody_` touches no `SpreadsheetApp`, `PropertiesService` or
   `UrlFetchApp` — grep for those three symbols inside the function body; expect nothing.
3. Mutation check: relax the flag test from `=== true` to a truthy test and confirm the
   truthy-non-true case goes red. Revert.
4. Update this step in `phases/roastery-wholesale/index.json`.

## Prohibitions

- Do not fetch anything in this step. Reason: the gate must be pure so it is testable
  without a network mock, exactly like `shopifyValidWeekBody_`.
- Do not accept a truthy diagnostics flag. Reason: the producer computes these over its
  own internal identities; a `getCol()` miss on `Invoice_Total` zeroes every gross while
  row counts still balance, so these flags are the only signal that the money is real.
- Do not derive `external` as `all − internal` anywhere, now or later. Reason: it folds
  `ambiguous` and `unknown` (Leible Taiwan, DK, Altdrop) into external wholesale revenue —
  the exact "publish an own-cafe's revenue as external" failure the endpoint exists to
  prevent.
- Do not reuse `SHOPIFY_REPULL_WEEKS`. Reason: different lag characteristics, above.
- Do not gate on `meta.paging.rowsIncluded`. Reason: it is a boolean in the producer's
  code and a count in its doc example — an unreliable field.
- Do not break existing tests.
