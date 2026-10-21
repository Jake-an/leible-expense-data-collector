# shop-coffee-kg: PROD probe (Order app `shopCoffeeLines`)

Probed 2026-10-22 by the main thread against PROD Order app @217, ISO weeks 2026-W31..W42, limit 1000. No week truncated; every week `ok`. Aggregates only - no tokens, order ids or customer names.

## Category line counts (W31..W42)

| category | lines |
|---|---|
| House Blend | 281 |
| Single Origin | 246 |
| Cold Brew | 164 |
| Packaging | 155 |
| Decaf | 74 |
| Reserve Single Origin | 33 |
| Drip Bag | 28 |
| Tea | 8 |
| Misc | 2 |
| null | 2 |

## Shops (exact shopId strings)

- LEIBLE: `Leible Blue`, `Leible Crows Nest`, `Leible Pitt`, `Leible Taiwan`, `Leible York`. Crows Nest is present, so the `No Invoice` status filter works.
- External (not reported): O3, 63 Do, Comission Coffee, KiKi Dessert, ADCO, Second Storey Cafe, ADCO Leppington, Forge, ADCO CARSS PARK, Colgate.

## Coffee category x size suffix (lines)

| category | -1K | -200 | -8K | other |
|---|---|---|---|---|
| Cold Brew | 76 | 88 | - | - |
| Decaf | 34 | 40 | - | - |
| House Blend | 131 | 94 | 56 | - |
| Reserve Single Origin | - | 29 | - | -02, -03, -04, -05 (one line each) |
| Single Origin | 98 | 148 | - | - |

No `-PT` lines yet (feature live since PROD @216, 2026-10-21).

## W42 sample

94 lines; `counts.droppedBadQty` 2, `blankRows` 5, `outOfWeekRows` 188; `diagnostics.rowsOk` and `linesOk` both true.

## Not yet measured

Date-vs-WeekLabel disagreement rate (lines carry `date` and `weekLabel`). Step 0 computes it from a fresh 2-week probe and appends it under "Verification" below.

## Decisions (Jake, 2026-10-22)

A. Shop map: code constant default in `shopcoffee.gs` (`SHOP_COFFEE_SHOPS_DEFAULT`), overridable by Script Property `SHOP_COFFEE_SHOPS` (JSON) if set and parseable; set-but-unparseable -> skip the run loudly, no writes. Default: `{"Leible York":"York","Leible Pitt":"Pitt","Leible Crows Nest":"Crowsnest","Leible Blue":"North"}`. Leible Blue is the North Sydney shop; display key `North` matches the GM monitor `SHOP_KEYS`. Leible Taiwan and all external shops are not reported (unmapped, expected). Matching is exact on the shopId string as emitted by the API.

B. Bar rule (widened): bar = Single Origin 1kg (`-1K`) + House Blend tins (`-8K`) + House Blend partial tins (`-PT`, qty already kg) + Decaf 1kg (`-1K`) + Cold Brew 1kg (`-1K`). retail = every other coffee-bean line (House Blend 1K and 200g, Single Origin 200g, Decaf 200g, Cold Brew 200g, Reserve Single Origin parseable sizes, SO 8K literal). excluded (kg 0) = Drip Bag, Tea, Packaging, Misc. unclassified = coffee category with unparseable size suffix (Reserve SO `-02/-03/-04/-05`), null category, or unknown category. Coffee-bean categories: House Blend, Single Origin, Reserve Single Origin, Decaf, Cold Brew. Widening beyond this list needs Jake's sign-off.

## Verification

Step 0 re-probe, 2026-10-22 (Thu, ISO W43 in progress), the 2 most recent completed ISO weeks: **2026-W41** and **2026-W42**. PROD Order app, `shopCoffeeLines`, limit 1000, paged until `truncated` false (1 page each).

| week | ok | lines | rowsOk | linesOk | Leible Crows Nest lines |
|---|---|---|---|---|---|
| 2026-W41 | true | 90 | true | true | 10 |
| 2026-W42 | true | 94 | true | true | 13 |

- **Crows Nest non-zero: confirmed** (10 and 13 lines), so the `No Invoice` status filter works.
- **Date-vs-WeekLabel disagreement rate: 0.0% (0 of 184 lines; W41 0/90, W42 0/94).** `date` is a plain `YYYY-MM-DD` string (already the Sydney calendar day), ISO week computed from it matched `weekLabel` on every line.
- **Drift vs recorded facts: none.**
  - Leible shopIds seen: Leible Blue, Leible Crows Nest, Leible Pitt, Leible York in both weeks; Leible Taiwan in W42 (5 lines). Same exact strings as recorded. External shops seen (Comission Coffee, 63 Do, ADCO, ADCO CARSS PARK, KiKi Dessert, Second Storey Cafe) are all in the recorded external set.
  - Categories seen: House Blend, Single Origin, Cold Brew, Decaf, Reserve Single Origin, Packaging, Drip Bag, Tea, Misc. All within the recorded set (no null category appeared in these two weeks).
  - Coffee SKU suffixes seen: only `-1K`, `-200`, `-8K` (`-8K` on House Blend only). No `-PT` lines yet, and no Reserve SO `-02..-05` in these weeks.
- Not measured here: `counts` was absent from the paged responses I read (the recorded W42 `counts` figures were not re-checked); only `diagnostics` was verified.

## Phase baseline

`node connectors/gas/test_code.js` before any step 1-6 change: **3292 passed, 0 failed** (2026-10-22).
