# Step 0: prod-contract-probe

## Requirements Covered

None - `covers: []`. Discovery/verification only (no feature code); it de-risks PRD-21 by pinning the real producer contract before any classifier is written.

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself - set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/hey-i-want-to-unified-alpaca.md` - the approved plan (P2 section is this phase's spec; "Design facts" and "Risks" apply to every step).
- `docs/schema.md`, `docs/rules.md` (two-runtime boundary: GAS owns writes/normalisation).
- `connectors/gas/orderapp.gs:9-10,164-230` - `ORDER_APP_EXEC_URL`, `ORDER_APP_TOKEN_PROP`, `orderAppFetch_` (how the hub calls the Order app).
- Memory `gas-exec-probe-curl.md` - use bare `curl -sL`; never add `-X POST`/Content-Type.
- Memory `curl-probe-token-via-get-credential-not-env-grep.md` - read the token via `get_credential`, never grep `.env`.

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

`phases/shop-coffee-kg/prod-probe.md` already exists: the main thread probed PROD (Order app @217, weeks 2026-W31..W42) on 2026-10-22 and recorded the real categories, shops, SKU suffixes and Jake's decisions. **This step only verifies it against a fresh probe and appends the one missing measurement. No GAS code is written. No questions for Jake.**

### Endpoint contract (what the hub relies on)

`GET <ORDER_APP_EXEC_URL>?api=shopCoffeeLines&token=<COST_API_TOKEN>&week=YYYY-Www&offset=N&limit=N` (limit max 1000 on PROD). Token = hub Script Property `ORDER_APP_COST_TOKEN`; read it locally via `base_connector.get_credential('ORDER_APP_COST_TOKEN')` (never print/log it). URL = const `ORDER_APP_EXEC_URL` in `connectors/gas/orderapp.gs`. Use bare `curl -sL` (no `-X POST`, no Content-Type). Response: `lines[]` `{orderId, shopId, shopType, date, weekLabel, sku, name, category, qty}`, `meta`, paging (`offset`, `limit`, `matched`, `truncated`), `diagnostics {rowsOk, linesOk}`, `counts`.

### Work

1. Fresh-probe the 2 most recent completed PROD ISO weeks (page until `truncated` is false). Check each against `prod-probe.md`: all `ok`, `diagnostics.rowsOk/linesOk` true, shopId set still matches (LEIBLE: Leible Blue, Leible Crows Nest, Leible Pitt, Leible Taiwan, Leible York), categories still within the recorded set, coffee SKU suffixes still within the recorded set (now including `-PT` if any appear). Crows Nest must be non-zero; if 0, STOP and report (status filter issue).
2. Compute the **Date-vs-WeekLabel disagreement rate** from those lines (each line carries `date` and `weekLabel`: fraction of lines whose ISO week from `date` != `weekLabel`; use the Sydney calendar for `date`). Append it to `prod-probe.md` under a "Verification" heading with the two weeks probed, plus any drift found vs the recorded facts. Aggregates only - no tokens, order ids or customer names.
3. Record the current `node connectors/gas/test_code.js` pass count as the phase baseline in `prod-probe.md`.
4. Do NOT set Script Properties (the shop map is a code default now; step 6 only deploys).

## Acceptance Criteria

```bash
test -s phases/shop-coffee-kg/prod-probe.md && node connectors/gas/test_code.js | tail -2
```

`prod-probe.md` exists and covers all items above; suite still green.

## Verification Procedure

1. Re-read `prod-probe.md` for secrets: `grep -inE "token|AKfy|@" phases/shop-coffee-kg/prod-probe.md` - expect nothing sensitive.
2. Confirm Crows Nest non-zero and the Date-vs-WeekLabel rate are stated explicitly.
3. Update this step in `phases/shop-coffee-kg/index.json`.

## Prohibitions

- Do not write or modify any `.gs`/`.js` code. Reason: this is a read-only probe; the contract it records drives steps 1-3.
- Do not print, log or store the token. Reason: Absolute Rule - secrets stay out of chat and repo; use `get_credential`.
- Do not use `-X POST` or a Content-Type header on the curl probe. Reason: gives a misleading 411/404 on a healthy GAS endpoint.
- Do not set Script Properties or deploy. Reason: step 6.
- Do not commit raw line data. Reason: business data stays out of the repo; aggregates only.
