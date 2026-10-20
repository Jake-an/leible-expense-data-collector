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
- Shop map is Script Property `SHOP_COFFEE_SHOPS` = JSON `{shopId: "York"|"Pitt"|"Crowsnest"|"North"}` (matches GM monitor `SHOP_KEYS`, `LEIBLE_GM_COST_MONITOR/Config.gs:82`). The exact shopIds are not pinned in code; step 0 discovers them.
- Producer size parser to mirror: `LEIBLE_Order_app/Engine_Utils.js:630` `parseSkuSize_` (`-8K`->8, `-1K`->1, `-200`->0.2). `billingQtyMap_` (`Engine_Invoice.js:72`) is the producer's Actual_Delivered -> Items_JSON fallback.
- Tests are inserted ABOVE the final `console.log('\n' + passed + ' passed...)` / `process.exit(...)` pair of `connectors/gas/test_code.js` (tests after `process.exit` are dead). Add `load('shopcoffee.gs')` next to the other `load(...)` lines near `test_code.js:433`.

## Task

Verify the Order-app endpoint `?api=shopCoffeeLines` (built in plan phase P1, already deployed to PROD before this phase starts) matches the contract below, using real PROD data, and record what the real data looks like. **No GAS code is written in this step.**

### Endpoint contract (what the hub will rely on)

`GET <ORDER_APP_EXEC_URL>?api=shopCoffeeLines&token=<COST_API_TOKEN>&week=YYYY-Www&offset=N&limit=N` (limit default/max 500). The token is the SAME token the hub already stores in Script Property **`ORDER_APP_COST_TOKEN`** (the hub's `orderAppFetch_`, `orderapp.gs:215`, attaches it); the Order app's side name is `COST_API_TOKEN`. The URL is the const `ORDER_APP_EXEC_URL`, not a property.

Response (JSON, `ok:true`):
- `lines[]`: `{orderId, shopId, shopType, date, weekLabel, sku, name, category, qty}` - one entry per order line AFTER the producer's `billingQtyMap_` collapse (Actual_Delivered wins, falls back to Items_JSON; stickers stripped; qty<=0/NaN dropped). `category` is null for an unknown SKU (still emitted). Inactive/retired SKUs keep their category.
- `meta`: `{distinctShopIds, distinctCategories, excludedByStatus}`.
- paging: `offset`, `limit`, `matched` (count of lines after collapse, for the whole week), `truncated` (true when more pages remain).
- `diagnostics`: `{rowsOk, linesOk}` (both must be true for a week to be trusted).
- Failure modes: wrong/missing token -> `UNAUTHORIZED` (and no counter side-effect); bad week -> error body.
- Status filter: `Pending Entry, Finalized, Archived, No Invoice`.

### Work

1. Read the token via `get_credential` (never print it). Curl the 12 most recent completed PROD ISO weeks (last completed = the week before the current Sydney ISO week), paging until `truncated` is false, plus one wrong-token probe (expect UNAUTHORIZED).
2. Write `phases/shop-coffee-kg/prod-probe.md` (NO tokens, NO order ids, NO customer names - aggregates only) with: per-week `matched` vs lines fetched; the full `meta.distinctShopIds` (with `shopType`), `distinctCategories`, SKU suffix patterns seen on coffee lines (`-1K`, `-8K`, `-200`, others), every SKU whose category is null or whose suffix is unrecognised (code only), `excludedByStatus` counts, `diagnostics`, and the **rate at which `date` and `weekLabel` disagree on which ISO week an order belongs to** (the plan uses `date`; this measures the risk).
3. Confirm the four main shops are all non-zero in at least the recent weeks - **Crows Nest must be non-zero** (if 0, the `No Invoice` status filter is missing on the producer: stop and report, do not proceed).
4. Propose the `SHOP_COFFEE_SHOPS` JSON in `prod-probe.md`. Ask Jake ONLY if the North Sydney shopId or the Crows Nest spelling (`Crowsnest`) is ambiguous. Do NOT set the Script Property here (step 6 does).
5. Record the current `node connectors/gas/test_code.js` pass count as the phase baseline in `prod-probe.md`.

## Acceptance Criteria

```bash
test -s phases/shop-coffee-kg/prod-probe.md && node connectors/gas/test_code.js | tail -2
```

`prod-probe.md` exists and covers all items above; suite still green.

## Verification Procedure

1. Re-read `prod-probe.md` for secrets: `grep -inE "token|AKfy|@" phases/shop-coffee-kg/prod-probe.md` - expect nothing sensitive.
2. Confirm Crows Nest non-zero is stated explicitly.
3. Update this step in `phases/shop-coffee-kg/index.json`.

## Prohibitions

- Do not write or modify any `.gs`/`.js` code. Reason: this is a read-only probe; the contract it records drives steps 1-3.
- Do not print, log or store the token. Reason: Absolute Rule - secrets stay out of chat and repo; use `get_credential`.
- Do not use `-X POST` or a Content-Type header on the curl probe. Reason: gives a misleading 411/404 on a healthy GAS endpoint.
- Do not set Script Properties or deploy. Reason: step 6.
- Do not commit raw line data. Reason: business data stays out of the repo; aggregates only.
