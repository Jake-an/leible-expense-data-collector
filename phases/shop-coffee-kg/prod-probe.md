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

(step 0 appends: the 2 weeks re-probed, drift vs the above, Date-vs-WeekLabel disagreement rate, Crows Nest non-zero confirmation, `node connectors/gas/test_code.js` baseline pass count.)
