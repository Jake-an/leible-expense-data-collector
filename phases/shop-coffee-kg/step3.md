# Step 3: aggregate

## Requirements Covered

- `PRD-21` - ShopCoffee: per-week x per-shop bar/retail/unclassified kg rows.

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself - set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/hey-i-want-to-unified-alpaca.md` - the approved plan (P2 section is this phase's spec; "Design facts" and "Risks" apply to every step).
- `docs/schema.md`, `docs/rules.md` (two-runtime boundary: GAS owns writes/normalisation).
- `connectors/gas/labour_weekly.gs:100-160` (`labourCostUpsert_` row shape precedent).
- `connectors/gas/shopcoffee.gs` (steps 1-2).
- `docs/schema.md` - the `ShopCoffee` tab spec is added in step 5; the row shape here must match it.

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

Add **`shopCoffeeAggregate_(lines, weekStart, weekEnd, isoWeek, shopMap, nowIso)`** (pure) -> `{rows, unmappedShopIds, totals}`.

Row per CONFIGURED shop (`shopMap` = the resolved shop map, i.e. `SHOP_COFFEE_SHOPS_DEFAULT` unless the `SHOP_COFFEE_SHOPS` property overrides it: `{shopId: 'York'|'Pitt'|'Crowsnest'|'North'}`), in a fixed shop order:
`[week_start, week_end, iso_week, shop, bar_kg, retail_kg, unclassified_kg, excluded_lines, line_count, pulled_at]`.
- Each line goes through `shopCoffeeClassify_`; kg summed per bucket per shop, rounded to 3dp ONCE at the end (no per-line float dust).
- `excluded_lines` = count of excluded lines; `line_count` = ALL lines for that shop (coffee + excluded).
- A configured shop with NO lines still gets a ZERO row (zeros, not absent) so a missing shop is visible.
- Lines whose `shopId` is not in `shopMap` are DROPPED and reported in `unmappedShopIds` as `{shopId, lines, kg}` (volume, so a wrong map is loud). Unmapped is EXPECTED for Leible Taiwan and external shops; the caller decides what is alarming (step 4).
- Reconciliation: bar+retail+unclassified kg over all rows + unmapped kg === sum of classified kg of the input (integer-milligram compare) - `totals.reconciled` boolean.

### Test First (TDD step)

Write these tests in `connectors/gas/test_code.js` BEFORE the implementation, ABOVE the final summary/`process.exit` pair. Confirm RED for the right reason (function undefined / wrong value - not a syntax error), then implement to GREEN, then refactor. The enumerated cases are the definition of done.

- mixed lines for one shop -> correct bar / retail / unclassified sums
- zero row emitted for a configured shop with no lines (all zeros, line_count 0)
- unmapped shopId dropped, counted with its line count and kg in `unmappedShopIds`
- excluded lines counted in `excluded_lines` and `line_count`, contribute 0 kg
- 3dp rounding: three lines of 0.2kg x1 -> 0.6, not 0.6000000000000001
- fixed row column order and exact header shape
- shop order stable regardless of input order
- reconciliation true on a clean fixture; deliberately corrupted input flips `reconciled` to false
- no input mutation (deep-equal the input before/after)
- empty `lines` -> all configured shops get zero rows
- the same shop name appearing under two shopIds in the map sums into one row

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

All pre-existing tests stay green plus every case above. Report the final pass count.

## Verification Procedure

1. Run the AC command; record counts.
2. Purity grep on the aggregate for `SpreadsheetApp|new Date\(\)|Date\.now|CalendarApp` (aggregate takes `nowIso` as a parameter).
3. Mutation check: drop the zero-row rule; confirm red; revert.
4. Update this step in `phases/shop-coffee-kg/index.json`.

## Prohibitions

- Do not break existing tests. Reason: `node connectors/gas/test_code.js` is the whole-repo gate (baseline recorded in step 0's `prod-probe.md`; run the FULL suite - memory `cross-step-test-anchor-conflict`).
- Do not commit credentials, tokens, PII or real shop/order data into code, tests, fixtures or `prod-probe.md`. Reason: Absolute Rule; use dummy fixtures.
- Do not deploy, push, or touch Script Properties in this step unless the step says so. Reason: deploy is step 6, push is "lets stop here".
- Do not create a new GAS project/deployment. Reason: one project, one deployment (CLAUDE.md Canonical IDs).
- Do not read a clock inside the aggregate. Reason: purity; `pulled_at` is passed in.
- Do not emit a row for an unmapped shop. Reason: the tab holds exactly the configured shops; unmapped volume is reported, not stored.
