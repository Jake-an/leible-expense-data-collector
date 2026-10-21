# Step 5: doget-fn

## Requirements Covered

- `PRD-22` - `doGet` `fn=shopCoffee` read API over the `ShopCoffee` tab.

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself - set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/hey-i-want-to-unified-alpaca.md` - the approved plan (P2 section is this phase's spec; "Design facts" and "Risks" apply to every step).
- `docs/schema.md`, `docs/rules.md` (two-runtime boundary: GAS owns writes/normalisation).
- `connectors/gas/Code.gs` `doGet` (~:2247 token check, then the `fn` dispatch) and an existing `fn=` handler for the response shape.
- `docs/api.md`, `docs/schema.md`.

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

Add to `connectors/gas/shopcoffee.gs` **`shopCoffeeRead_(from, to)`** and wire `fn=shopCoffee` into the `doGet` `fn` dispatch in `Code.gs` (one dispatch line; the token check at `Code.gs:2247` already runs first, so no-token -> unauthorized comes for free - a test must prove it).

- Params `from`, `to` (ISO `yyyy-MM-dd` week_start bounds, inclusive). Default when absent: the **last completed week** only. Invalid/inverted dates -> an error body (not a throw, not all data).
- Response: `{ok:true, fn:'shopCoffee', from, to, rows:[{week_start, week_end, iso_week, shop, bar_kg, retail_kg, unclassified_kg, excluded_lines, line_count, pulled_at}]}` - kg as numbers; Date cells coerced to `yyyy-MM-dd` via local components.
- Missing tab -> `ok:true, rows:[]` with a `note`, not a throw.
- Docs: add `fn=shopCoffee` to `docs/api.md` (params, auth, response, example) and the `ShopCoffee` tab (columns, key `week_start||shop`, kg-only, bar rule per Design facts (widened 2026-10-22), unclassified meaning) to `docs/schema.md`. Do not flip PRD status here (step 6 / phase-end).

### Test First (TDD step)

Write these tests in `connectors/gas/test_code.js` BEFORE the implementation, ABOVE the final summary/`process.exit` pair. Confirm RED for the right reason (function undefined / wrong value - not a syntax error), then implement to GREEN, then refactor. The enumerated cases are the definition of done.

- valid token + `from`/`to` -> only rows within range, shape as above
- no `from`/`to` -> exactly the last completed week (4 shop rows)
- **no token / wrong token -> unauthorized, and no row data in the body**
- `from` after `to` / malformed dates -> error body
- missing `ShopCoffee` tab -> `ok:true`, empty rows, note
- Date cells in the sheet come back as `yyyy-MM-dd` strings (no AEST off-by-one)
- numeric kg returned as numbers (not strings)
- existing `fn` handlers unaffected (full suite green)
- auth-coverage: the new fn is reachable only through `doGet` (run the repo's auth-coverage gate if one exists in the suite)

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

All pre-existing tests stay green plus every case above. Report the final pass count.

## Verification Procedure

1. Run the AC command; record counts.
2. `grep -n "shopCoffee" docs/api.md docs/schema.md` - both documented.
3. Mutation check: bypass the token check in the test double; confirm the no-token test goes red; revert.
4. Update this step in `phases/shop-coffee-kg/index.json`.

## Prohibitions

- Do not break existing tests. Reason: `node connectors/gas/test_code.js` is the whole-repo gate (baseline recorded in step 0's `prod-probe.md`; run the FULL suite - memory `cross-step-test-anchor-conflict`).
- Do not commit credentials, tokens, PII or real shop/order data into code, tests, fixtures or `prod-probe.md`. Reason: Absolute Rule; use dummy fixtures.
- Do not deploy, push, or touch Script Properties in this step unless the step says so. Reason: deploy is step 6, push is "lets stop here".
- Do not create a new GAS project/deployment. Reason: one project, one deployment (CLAUDE.md Canonical IDs).
- Do not add a second auth path or an allowlist exception. Reason: the shared `doGet` token check is the whole security surface.
- Do not return the whole tab when params are invalid. Reason: fail closed.
