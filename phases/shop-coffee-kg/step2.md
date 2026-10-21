# Step 2: fetch-gate-paging

## Requirements Covered

- `PRD-21` - ShopCoffee: fetching the week's raw lines with strict completeness gating.

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself - set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/hey-i-want-to-unified-alpaca.md` - the approved plan (P2 section is this phase's spec; "Design facts" and "Risks" apply to every step).
- `docs/schema.md`, `docs/rules.md` (two-runtime boundary: GAS owns writes/normalisation).
- `connectors/gas/orderapp.gs:215` (`orderAppFetch_`) and `:249-317` (`wholesaleFetchWeekOrders_` paging guards - copy the guards).
- `connectors/gas/test_code.js` tests around the wholesale fetch (the `global.UrlFetchApp` swap pattern).
- `phases/shop-coffee-kg/prod-probe.md`.

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

In `connectors/gas/shopcoffee.gs` add **`shopCoffeeFetchWeekLines_(weekLabel)`** -> `{ok, lines, matched, diagnostics, meta, reason}` that pages `?api=shopCoffeeLines&week=<weekLabel>&offset&limit` via the existing `orderAppFetch_` (token from `ORDER_APP_COST_TOKEN`, URL from `ORDER_APP_EXEC_URL`) with the same paging guards as `wholesaleFetchWeekOrders_` (`orderapp.gs:249-317`: max page cap, offset must advance, `truncated` loop terminates, no infinite loop on a stuck producer).

Strict body gate - the week is `ok:true` ONLY when ALL hold: body `ok===true`; `diagnostics.rowsOk===true && diagnostics.linesOk===true`; `lines` is an array on every page; **`collected.length === matched`** after dedup (matched counts lines after the producer's per-order collapse); every line has finite qty>0, string `sku`, string `orderId`, `shopId`. Dedup key `orderId|sku` (a duplicate across pages is dropped and counted; a duplicate with a DIFFERENT qty fails the gate). Any failure -> `ok:false` with a specific `reason` (never partial lines treated as complete).

### Test First (TDD step)

Write these tests in `connectors/gas/test_code.js` BEFORE the implementation, ABOVE the final summary/`process.exit` pair. Confirm RED for the right reason (function undefined / wrong value - not a syntax error), then implement to GREEN, then refactor. The enumerated cases are the definition of done.

- single page happy path -> ok, lines returned
- multi-page (offset/limit/truncated) assembles all pages in order
- `collected.length !== matched` (short page) -> `ok:false`, reason names the mismatch
- `diagnostics.rowsOk=false` / `linesOk=false` -> `ok:false`
- body `ok:false` / non-JSON / HTTP error / UNAUTHORIZED -> `ok:false`, no throw
- `lines` not an array -> `ok:false`
- stuck producer (offset never advances / truncated forever) -> terminates via the page cap, `ok:false`
- duplicate `orderId|sku` across pages dropped and counted; same key with different qty -> `ok:false`
- malformed line (qty<=0, NaN, missing sku/orderId/shopId) -> `ok:false`
- missing `ORDER_APP_COST_TOKEN` -> skip result (not an exception), consistent with `orderapp.gs:164-166`
- the token never appears in any logged/returned reason string

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

All pre-existing tests stay green plus every case above. Report the final pass count.

## Verification Procedure

1. Run the AC command; record counts.
2. No Sheet access in this function: `grep -n "SpreadsheetApp" connectors/gas/shopcoffee.gs` - expect none at this step.
3. Mutation check: weaken the `collected.length === matched` gate; confirm red; revert.
4. Update this step in `phases/shop-coffee-kg/index.json`.

## Prohibitions

- Do not break existing tests. Reason: `node connectors/gas/test_code.js` is the whole-repo gate (baseline recorded in step 0's `prod-probe.md`; run the FULL suite - memory `cross-step-test-anchor-conflict`).
- Do not commit credentials, tokens, PII or real shop/order data into code, tests, fixtures or `prod-probe.md`. Reason: Absolute Rule; use dummy fixtures.
- Do not deploy, push, or touch Script Properties in this step unless the step says so. Reason: deploy is step 6, push is "lets stop here".
- Do not create a new GAS project/deployment. Reason: one project, one deployment (CLAUDE.md Canonical IDs).
- Do not call `UrlFetchApp` directly. Reason: all Order-app calls go through `orderAppFetch_` (token handling, URL).
- Do not return partial lines as a successful week. Reason: a silent partial week understates a shop with no signal.
- Do not log the token or full response bodies. Reason: secrets/business data stay out of logs.
