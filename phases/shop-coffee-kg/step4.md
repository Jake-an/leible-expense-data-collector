# Step 4: pull-orchestrator

## Requirements Covered

- `PRD-21` - ShopCoffee: the scheduled pull, whole-row upsert, backfill and staleness watch.

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself - set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/hey-i-want-to-unified-alpaca.md` - the approved plan (P2 section is this phase's spec; "Design facts" and "Risks" apply to every step).
- `docs/schema.md`, `docs/rules.md` (two-runtime boundary: GAS owns writes/normalisation).
- `connectors/gas/labour_weekly.gs:100-200` (`labourCostUpsert_`) and its ensure-sheet/header handling.
- `connectors/gas/orderapp.gs` - `orderAppRunStart_`, `withScriptLock_` (`Code.gs:104`), `lastCompletedWeeks_`, `orderAppRunSuccess_`/`orderAppRunSkipped_`, `installOrderAppTriggers` (`:2042`), `wholesalePull` as the end-to-end template.
- `connectors/gas/staleness.gs` and `test_code.js:3543` (`STAMPS_HEARTBEAT` list, `STALENESS_SOURCES`, `STALENESS_THRESHOLD_OVERRIDES`).
- Memories: `gas-header-consts-dont-migrate-live-tabs`, `resum-cap-oldest-first-starves-newest-week`, `upsertrows-drops-within-batch-key-collisions`, `orderapp-pulls-silent-success-vendor-named-summary`, `gas-mock-discards-getrange-geometry`.

## Design facts (shared by every step in this phase)

- Order app token property name in the hub: `ORDER_APP_COST_TOKEN` (const `ORDER_APP_TOKEN_PROP`, `connectors/gas/orderapp.gs:10`); the Order-app URL is NOT a property - it is the const `ORDER_APP_EXEC_URL` (`orderapp.gs:9`, PROD /exec). `orderAppFetch_` is at `orderapp.gs:215`.
- Upsert template = `labourCostUpsert_` (`connectors/gas/labour_weekly.gs:131`, unconditional whole-row rewrite), keyed `row[0]||row[3]` (week_start||shop). NOT `labourHubUpsert_` (:106 - keys col 2 and only rewrites on total/department change, so a repull could not self-heal) and NOT `upsertRows_` (`Code.gs:1191` rewrites one amount column only).
- Crows Nest orders carry `Invoice_Status="No Invoice"` (Order app `Engine_Invoice.js:1216-1234`), which is NOT in `WHOLESALE_API_STATUS_FILTER`. The `shopCoffeeLines` endpoint filters `Pending Entry, Finalized, Archived, No Invoice`; if Crows Nest reads 0 the status filter is the first suspect.
- Hub `doGet` token check (`Code.gs:2247`) runs before `fn` dispatch, so new `fn`s inherit auth; no allowlist change.
- Shop map is Script Property `SHOP_COFFEE_SHOPS` = JSON `{shopId: "York"|"Pitt"|"Crowsnest"|"North"}` (matches GM monitor `SHOP_KEYS`, `LEIBLE_GM_COST_MONITOR/Config.gs:82`). The exact shopIds are not pinned in code; step 0 discovers them.
- Producer size parser to mirror: `LEIBLE_Order_app/Engine_Utils.js:630` `parseSkuSize_` (`-8K`->8, `-1K`->1, `-200`->0.2). `billingQtyMap_` (`Engine_Invoice.js:72`) is the producer's Actual_Delivered -> Items_JSON fallback.
- Tests are inserted ABOVE the final `console.log('\n' + passed + ' passed...)` / `process.exit(...)` pair of `connectors/gas/test_code.js` (tests after `process.exit` are dead). Add `load('shopcoffee.gs')` next to the other `load(...)` lines near `test_code.js:433`.

## Task

In `connectors/gas/shopcoffee.gs` add:

- Constants: `SHOP_COFFEE_TAB='ShopCoffee'`, `SHOP_COFFEE_HEADERS` (the 10 columns from step 3), `SHOP_COFFEE_SOURCE='shopcoffee'`, `SHOP_COFFEE_SHOPS_PROP='SHOP_COFFEE_SHOPS'`, `SHOP_COFFEE_BACKFILLED_PROP='SHOP_COFFEE_BACKFILLED'`.
- **`shopCoffeeUpsert_(sheet, rows)`** modelled on `labourCostUpsert_` (`labour_weekly.gs:131`): UNCONDITIONAL whole-row rewrite when the key `week_start||shop` already exists, append otherwise; coerce Date cells via local components (memory `sheet-date-coercion`); within-batch duplicate keys are a bug (memory `upsertrows-drops-within-batch-key-collisions`) - throw rather than silently drop. Creates the tab with headers if missing (`ensureSheet`; headers are written only when missing).
- **`shopCoffeePull(opts)`**: `orderAppRunStart_(SHOP_COFFEE_SOURCE)` -> `withScriptLock_`. Skip safely (no heartbeat, `orderAppRunSkipped_`) when `ORDER_APP_COST_TOKEN` or `SHOP_COFFEE_SHOPS` is unset/unparseable. Weeks via `lastCompletedWeeks_`: **12 weeks on the first run (`SHOP_COFFEE_BACKFILLED` unset), then 8** (late status flips); set `SHOP_COFFEE_BACKFILLED` only after a fully clean backfill. Per week: fetch (step 2) -> aggregate (step 3) -> upsert. A week whose fetch gate fails is skipped and counted (other weeks still proceed). **Heartbeat (`stalenessStampHeartbeat_`) only on a fully clean run** (every week ok, zero unmapped shopIds with volume). Fail-open consecutive-failure alerting as in the other order-app pulls. Log one line per week (weeks written, rows, unmapped volume - the run must not be silent-success). Return `{weeksRequested, weeksWritten, weeksSkipped, rowsWritten, unmapped, dryRun}`.
- **`dryRun`**: computes everything, writes nothing, stamps nothing, returns what it would write.
- Property-driven zero-arg wrappers for the editor Run button (memory `gas-run-button-needs-property-driven-wrappers`): `shopCoffeePullRun()` / `shopCoffeePullDry()`.
- Trigger: add a Monday **06:30** time-driven trigger for `shopCoffeePull` inside `installOrderAppTriggers` (`orderapp.gs:2042`), idempotent (no duplicate on re-install).
- Staleness: add `'shopcoffee'` to `STALENESS_SOURCES` with a **168h** entry in `STALENESS_THRESHOLD_OVERRIDES` (weekly feed), and add `'shopcoffee'` to the `STAMPS_HEARTBEAT` list in the test at `test_code.js:3543` (the guard test `testEveryHeartbeatSourceIsWatched` must stay green).

### Test First (TDD step)

Write these tests in `connectors/gas/test_code.js` BEFORE the implementation, ABOVE the final summary/`process.exit` pair. Confirm RED for the right reason (function undefined / wrong value - not a syntax error), then implement to GREEN, then refactor. The enumerated cases are the definition of done.

Use the same in-memory Sheet/Properties/UrlFetchApp mocks as the wholesale pull tests; mocks must preserve getRange geometry.
- first run (`SHOP_COFFEE_BACKFILLED` unset) requests 12 weeks; next run requests 8; flag set only after a clean backfill
- clean run writes 4 shops x N weeks, stamps heartbeat once
- repull with unchanged data -> no duplicate rows (row count stable)
- **repull where ONLY `retail_kg` changed -> that row IS rewritten** (the whole-row-upsert self-heal; fails against a `labourHubUpsert_`-style total-only compare)
- week whose fetch gate fails is skipped, other weeks still written, NO heartbeat stamped
- unmapped shopId with volume -> no heartbeat, volume logged
- missing token or missing/unparseable `SHOP_COFFEE_SHOPS` -> skipped, nothing written, no heartbeat, no throw
- `dryRun` writes nothing and stamps nothing
- lock contention -> second concurrent call exits without writing
- Monday 06:30 trigger installed exactly once across two `installOrderAppTriggers` calls
- `'shopcoffee'` present in `STALENESS_SOURCES`, has a 168h override, and the existing watched-sources guard test passes with it in `STAMPS_HEARTBEAT`
- row Date cells round-trip without an AEST off-by-one (local-component coercion)
- the token never appears in log output

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

All pre-existing tests stay green plus every case above. Report the final pass count.

## Verification Procedure

1. Run the AC command; record counts (the FULL suite - the staleness guard test is cross-step).
2. Mutation check: switch the upsert to compare only a total column; confirm the `retail_kg`-only test goes red; revert.
3. `grep -n "shopCoffeePull" connectors/gas/*.gs` - confirm the only trigger registration is in `installOrderAppTriggers`.
4. Update this step in `phases/shop-coffee-kg/index.json`.

## Prohibitions

- Do not break existing tests. Reason: `node connectors/gas/test_code.js` is the whole-repo gate (baseline recorded in step 0's `prod-probe.md`; run the FULL suite - memory `cross-step-test-anchor-conflict`).
- Do not commit credentials, tokens, PII or real shop/order data into code, tests, fixtures or `prod-probe.md`. Reason: Absolute Rule; use dummy fixtures.
- Do not deploy, push, or touch Script Properties in this step unless the step says so. Reason: deploy is step 6, push is "lets stop here".
- Do not create a new GAS project/deployment. Reason: one project, one deployment (CLAUDE.md Canonical IDs).
- Do not use `labourHubUpsert_` or `upsertRows_`. Reason: neither rewrites a whole row on a one-column change, so a repull could not self-heal.
- Do not stamp the heartbeat on a partial/skipped run. Reason: silent staleness is the enemy; a dirty run must look stale.
- Do not run the trigger installer or a real pull now. Reason: trigger install and the real run happen in step 6.
- Do not touch the `Summary` or `Revenue` tabs. Reason: ShopCoffee is a separate tab by decision.
