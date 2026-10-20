# Step 6: deploy-live

## Requirements Covered

None - `covers: []`. Operational deploy + live verification of PRD-21/PRD-22; no new feature code.

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself - set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/hey-i-want-to-unified-alpaca.md` - the approved plan (P2 section is this phase's spec; "Design facts" and "Risks" apply to every step).
- `docs/schema.md`, `docs/rules.md` (two-runtime boundary: GAS owns writes/normalisation).
- `C:/Users/mioja/.claude/docs/agent-autonomy.md` - **LOAD BEFORE ANY DEPLOY/PROMOTE** (PROD chain order, hard stops, browser hygiene, secrets, login batching).
- `scripts/deploy.sh`, `config/deployment.json`, `docs/rules.md`.
- `phases/shop-coffee-kg/prod-probe.md` (the `SHOP_COFFEE_SHOPS` proposal, baseline pass count).
- Memories: `deploy-after-gas-changes`, `gas-exec-probe-curl`, `chrome-sheet-edits-and-gas-runs-blocked-by-classifier`, `claspignore-name-based-broke-exec`, `no-deploy-gate-in-this-repo`, `trigger-list-contradicts-todo-claims`.

## Design facts (shared by every step in this phase)

- Order app token property name in the hub: `ORDER_APP_COST_TOKEN` (const `ORDER_APP_TOKEN_PROP`, `connectors/gas/orderapp.gs:10`); the Order-app URL is NOT a property - it is the const `ORDER_APP_EXEC_URL` (`orderapp.gs:9`, PROD /exec). `orderAppFetch_` is at `orderapp.gs:215`.
- Upsert template = `labourCostUpsert_` (`connectors/gas/labour_weekly.gs:131`, unconditional whole-row rewrite), keyed `row[0]||row[3]` (week_start||shop). NOT `labourHubUpsert_` (:106 - keys col 2 and only rewrites on total/department change, so a repull could not self-heal) and NOT `upsertRows_` (`Code.gs:1191` rewrites one amount column only).
- Crows Nest orders carry `Invoice_Status="No Invoice"` (Order app `Engine_Invoice.js:1216-1234`), which is NOT in `WHOLESALE_API_STATUS_FILTER`. The `shopCoffeeLines` endpoint filters `Pending Entry, Finalized, Archived, No Invoice`; if Crows Nest reads 0 the status filter is the first suspect.
- Hub `doGet` token check (`Code.gs:2247`) runs before `fn` dispatch, so new `fn`s inherit auth; no allowlist change.
- Shop map is Script Property `SHOP_COFFEE_SHOPS` = JSON `{shopId: "York"|"Pitt"|"Crowsnest"|"North"}` (matches GM monitor `SHOP_KEYS`, `LEIBLE_GM_COST_MONITOR/Config.gs:82`). The exact shopIds are not pinned in code; step 0 discovers them.
- Producer size parser to mirror: `LEIBLE_Order_app/Engine_Utils.js:630` `parseSkuSize_` (`-8K`->8, `-1K`->1, `-200`->0.2). `billingQtyMap_` (`Engine_Invoice.js:72`) is the producer's Actual_Delivered -> Items_JSON fallback.
- Tests are inserted ABOVE the final `console.log('\n' + passed + ' passed...)` / `process.exit(...)` pair of `connectors/gas/test_code.js` (tests after `process.exit` are dead). Add `load('shopcoffee.gs')` next to the other `load(...)` lines near `test_code.js:433`.

## Task

Ship PRD-21/22 live. This step touches PRODUCTION (the single GAS deployment) - follow the PROD chain in `agent-autonomy.md` in its fixed order.

1. **Pre-flight:** `node connectors/gas/test_code.js` green; `git status` clean except this phase; `git log -3` (re-derive state live). Read `docs/autonomy-readiness.json` per `agent-autonomy.md` section (j). Commit + `prod-*` tag, then run `/security-audit` (adds a read `fn` and consumes a token-gated endpoint) and require a fresh APPROVE at final HEAD; a blocked audit the agent cannot fix is a hard stop. Make no CLAUDE.md/docs edit after the audit before deploying.
2. **Set `SHOP_COFFEE_SHOPS`** (Script Property) to the JSON proposed in `prod-probe.md`. If the harness classifier denies editing properties or the editor Run button (memory `chrome-sheet-edits-and-gas-runs-blocked-by-classifier`), STOP and tell Jake exactly what to paste (the shop map is non-secret; tokens never in chat).
3. **Deploy:** `bash scripts/deploy.sh` (clasp push + redeploy the ONE deployment id in `config/deployment.json`; never mint a new deployment, never `clasp create-script`). Deploy in its own call.
4. **Install triggers:** run `installOrderAppTriggers` (confirm the Mon 06:30 `shopCoffeePull` trigger exists exactly once via the Triggers page - the Triggers page is the only source of truth).
5. **Dry run then real run:** `shopCoffeePullDry` (read the returned counts: 4 shops x 12 weeks, unmapped = 0, Crows Nest non-zero), then the real `shopCoffeePull` (first run = 12-week backfill). If the Run button is classifier-blocked, hand Jake ONE batched step under `blocked: credential`/classifier and finish everything else.
6. **Live read checks:** `curl -sL "<exec>?fn=shopCoffee&token=<read token via get_credential>"` -> `ok:true`, 4 rows for the last completed week; a no-token call -> unauthorized. Use bare `curl -sL`, never `-X POST`.
7. **Chrome read-only smoke:** open the ShopCoffee tab; confirm 12 weeks x 4 shops, header intact, no #errors; hand-check ONE known tin week against the Order app and record the match.
8. **On any failure:** roll back (`git checkout <prod tag>` + `bash scripts/deploy.sh`) and re-smoke; a failed rollback is a hard stop.
9. **Only then** update CLAUDE.md live/rollback lines and flip PRD-21/PRD-22 `Status` to `built`; commit. **Do NOT git push** (push is "lets stop here" only).

## Acceptance Criteria

Live evidence recorded in `phases/shop-coffee-kg/deploy-note.md`: deploy.sh exit 0 + deployment id unchanged; Triggers page shows one Mon 06:30 `shopCoffeePull`; dry-run + real-run counts; `fn=shopCoffee` curl `ok:true` + no-token unauthorized; Chrome ShopCoffee tab 12x4 with the hand-checked tin week.

## Verification Procedure

1. Re-run `node connectors/gas/test_code.js` and `python -m pytest scripts/test_execute.py -q` post-change.
2. Confirm `config/deployment.json` deployment id is unchanged.
3. Confirm the staleness guard watches `shopcoffee` (no false alert expected: the real run stamps the heartbeat).
4. Update this step in `phases/shop-coffee-kg/index.json`.

## Prohibitions

- Do not bypass any gate (`SKIP_*`, `--no-verify`, hand-written verdict, waiver). Reason: hard stop in Agent Autonomy.
- Do not mint a new GAS deployment or project. Reason: one URL forever (CLAUDE.md Canonical IDs).
- Do not write to PROD data other than the new ShopCoffee tab. Reason: any other PROD data write is a hard stop; no backfill into Summary/Revenue.
- Do not print the read token or the Order-app token. Reason: secrets stay out of chat/repo; use `get_credential`.
- Do not git push. Reason: push only on "lets stop here".
- Do not scaffold or deploy Cropster (`cropster-roasting`). Reason: waits on credentials (PRD-23/24 stay `planned`).
