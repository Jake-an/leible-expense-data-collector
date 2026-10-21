# Step 1: classifier

## Requirements Covered

- `PRD-21` - ShopCoffee: SKU size -> kg and the bar/retail/unclassified/excluded classification (bar rule widened by Jake 2026-10-22).

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself - set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/hey-i-want-to-unified-alpaca.md` - the approved plan (P2 section is this phase's spec; "Design facts" and "Risks" apply to every step).
- `docs/schema.md`, `docs/rules.md` (two-runtime boundary: GAS owns writes/normalisation).
- `phases/shop-coffee-kg/prod-probe.md` (step 0 output) - real suffixes, categories and unknown SKUs; the classifier must cover them.
- `connectors/gas/labour.gs` header + `connectors/gas/test_code.js` ~:1-460 (`load()` indirect-eval, `check`/`eq`).

## Design facts (shared by every step in this phase)

- Order app token property name in the hub: `ORDER_APP_COST_TOKEN` (const `ORDER_APP_TOKEN_PROP`, `connectors/gas/orderapp.gs:10`); the Order-app URL is NOT a property - it is the const `ORDER_APP_EXEC_URL` (`orderapp.gs:9`, PROD /exec). `orderAppFetch_` is at `orderapp.gs:215`.
- Upsert template = `labourCostUpsert_` (`connectors/gas/labour_weekly.gs:131`, unconditional whole-row rewrite), keyed `row[0]||row[3]` (week_start||shop). NOT `labourHubUpsert_` (:106 - keys col 2 and only rewrites on total/department change, so a repull could not self-heal) and NOT `upsertRows_` (`Code.gs:1191` rewrites one amount column only).
- Crows Nest orders carry `Invoice_Status="No Invoice"` (Order app `Engine_Invoice.js:1216-1234`), which is NOT in `WHOLESALE_API_STATUS_FILTER`. The `shopCoffeeLines` endpoint filters `Pending Entry, Finalized, Archived, No Invoice`; if Crows Nest reads 0 the status filter is the first suspect.
- Hub `doGet` token check (`Code.gs:2247`) runs before `fn` dispatch, so new `fn`s inherit auth; no allowlist change.
- Shop map (Jake, 2026-10-22) is a CODE CONSTANT default in `shopcoffee.gs` (`SHOP_COFFEE_SHOPS_DEFAULT`): `{"Leible York":"York","Leible Pitt":"Pitt","Leible Crows Nest":"Crowsnest","Leible Blue":"North"}` (Leible Blue = North Sydney shop; display keys match GM monitor `SHOP_KEYS`, `LEIBLE_GM_COST_MONITOR/Config.gs:82`). Overridable by Script Property `SHOP_COFFEE_SHOPS` (JSON) if set and parseable; set-but-unparseable -> skip the run loudly, no writes. Matching is exact on the shopId string as emitted by the API. Leible Taiwan and all external shops are NOT reported (they count as unmapped, expected). Shop ids are resolved - no question for Jake.
- Bar rule (Jake, widened 2026-10-22): bar = Single Origin 1kg (`-1K`) + House Blend tins (`-8K`) + House Blend partial tins (`-PT`, qty already kg) + Decaf 1kg (`-1K`) + Cold Brew 1kg (`-1K`). retail = every other coffee-bean line (House Blend 1K and 200g, Single Origin 200g, Decaf 200g, Cold Brew 200g, Reserve Single Origin any parseable size, SO 8K literal). excluded (kg 0) = categories Drip Bag, Tea, Packaging, Misc. unclassified = coffee category with unparseable size suffix (incl. Reserve SO SKUs ending -02/-03/-04/-05), null category, or unknown category. Coffee-bean categories constant: House Blend, Single Origin, Reserve Single Origin, Decaf, Cold Brew. Real PROD facts: `phases/shop-coffee-kg/prod-probe.md`.
- Producer size parser to mirror: `LEIBLE_Order_app/Engine_Utils.js:630` `parseSkuSize_` (`-8K`->8, `-1K`->1, `-200`->0.2). `billingQtyMap_` (`Engine_Invoice.js:72`) is the producer's Actual_Delivered -> Items_JSON fallback.
- Tests are inserted ABOVE the final `console.log('\n' + passed + ' passed...)` / `process.exit(...)` pair of `connectors/gas/test_code.js` (tests after `process.exit` are dead). Add `load('shopcoffee.gs')` next to the other `load(...)` lines near `test_code.js:433`.

## Task

Create **`connectors/gas/shopcoffee.gs`** (pure functions only; no Sheet/Properties/UrlFetch access in this step). Header comment explains the bar rule (see Design facts) and that the producer sends raw lines while the hub classifies. Add `load('shopcoffee.gs')` near `test_code.js:433`.

- **`shopCoffeeSizeKg_(sku)`** -> kg (number) or `null`. Mirrors the producer's `parseSkuSize_` (`Engine_Utils.js:630`): suffix `-8K`->8, `-1K`->1, `-200`->0.2 (grams -> kg). Case- and whitespace-insensitive. Unknown suffix -> `null`, never guessed. **Partial tin** `-PT` (e.g. `HB-ABS-PT`, `HB-BUO-PT`, added by Order app 3290515, live PROD @216): qty is already in kg, so kg-per-unit = 1 (mirrors producer `stockKgPerUnit_`, `Engine_Utils.js:683`).
- **`shopCoffeeClassify_(line)`** -> `{bucket:'bar'|'retail'|'unclassified'|'excluded', kg}` where kg = size_kg x qty (3dp); `kg` is 0 for `excluded`. Rules (Jake 2026-10-22):
  - category in the excluded list (Drip Bag, Tea, Packaging, Misc) -> `excluded`.
  - category null, or not in the coffee-bean list (House Blend, Single Origin, Reserve Single Origin, Decaf, Cold Brew) and not excluded -> `unclassified`.
  - coffee bean with unparseable size suffix (incl. Reserve SO `-02/-03/-04/-05`) -> `unclassified`.
  - `bar`: Single Origin `-1K`; House Blend `-8K` tin; House Blend `-PT` partial tin (qty already kg); Decaf `-1K`; Cold Brew `-1K`.
  - every OTHER coffee bean -> `retail` (House Blend 1K and 200g, Single Origin 200g, Decaf 200g, Cold Brew 200g, Reserve SO 200g or any parseable size, SO 8K literal).
- Make the bar recognition table-driven (constants listing the coffee-bean categories, excluded categories and the bar rules above, from `prod-probe.md`) so a new category is a one-line change; a category not in the table is `unclassified`.

### Test First (TDD step)

Write these tests in `connectors/gas/test_code.js` BEFORE the implementation, ABOVE the final summary/`process.exit` pair. Confirm RED for the right reason (function undefined / wrong value - not a syntax error), then implement to GREEN, then refactor. The enumerated cases are the definition of done.

- SO 1K -> `bar`, kg 1 (x qty 3 -> 3)
- HB 8K tin -> `bar`, kg 8
- HB-ABS-PT qty 4.3 (House Blend partial tin) -> `bar`, kg 4.3 (PT = part-used 8kg tin, qty in kg)
- non-HB `-PT` (if any appears) -> `unclassified`, never guessed
- Decaf 1K -> `bar`, kg 1; Cold Brew 1K -> `bar`, kg 1
- SO 200 -> `retail`, kg 0.2; Decaf 200 -> `retail`, kg 0.2; Cold Brew 200 -> `retail`; Reserve SO 200 -> `retail`
- HB 1K (bag) -> `retail`, kg 1
- SO 8K -> `retail` (literal rule, pinned)
- Reserve SO `-03` (unparseable size) -> `unclassified`
- unknown suffix -> `unclassified`; null category -> `unclassified`; unknown category -> `unclassified`; unparseable SKU -> `unclassified`
- Drip Bag / Tea / Packaging / Misc -> `excluded`, kg 0
- case and whitespace variants of the SKU (`so-1k`, ` SO-1K `) classify identically
- qty multiplication and 3dp rounding (0.2 x 3 = 0.6 exactly, no float dust)
- a hub test pins the producer regexes: assert `shopCoffeeSizeKg_` on a table of real SKU suffixes copied from `prod-probe.md` so drift from `parseSkuSize_` fails loudly
- robustness: the functions never throw on `null`/`undefined`/non-string input

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

All pre-existing tests stay green plus every case above. Report the final pass count.

## Verification Procedure

1. Run the AC command; record counts.
2. Purity grep: `grep -nE "SpreadsheetApp|PropertiesService|UrlFetchApp|Utilities|Logger|CalendarApp|DriveApp|GmailApp|new Date\(\)|Date\.now" connectors/gas/shopcoffee.gs` - expect NO matches (`CalendarApp` must not appear even in a comment; FIX6 test9a greps every `.gs`).
3. Mutation check on the bar rule (e.g. make HB 1K bar, or drop Decaf from bar): confirm a test goes red, revert.
4. Update this step in `phases/shop-coffee-kg/index.json`.

## Prohibitions

- Do not break existing tests. Reason: `node connectors/gas/test_code.js` is the whole-repo gate (baseline recorded in step 0's `prod-probe.md`; run the FULL suite - memory `cross-step-test-anchor-conflict`).
- Do not commit credentials, tokens, PII or real shop/order data into code, tests, fixtures or `prod-probe.md`. Reason: Absolute Rule; use dummy fixtures.
- Do not deploy, push, or touch Script Properties in this step unless the step says so. Reason: deploy is step 6, push is "lets stop here".
- Do not create a new GAS project/deployment. Reason: one project, one deployment (CLAUDE.md Canonical IDs).
- Do not guess a size or category. Reason: unparseable/unknown is `unclassified` by design, surfaced in the tab rather than hidden.
- Do not widen `bar` BEYOND the list in Design facts (SO 1K, HB 8K tin, HB -PT, Decaf 1K, Cold Brew 1K); e.g. HB 1K bags stay retail. Reason: Jake's decision 2026-10-22 (widened from the 2026-10-20 strict rule); anything wider needs his sign-off.
- Do not name anything that collides with another `.gs` global. Reason: all `.gs` share one namespace; prefix everything `shopCoffee`.
