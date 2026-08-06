# Step 5: staleness-and-shopify-retirement

## Requirements Covered

- `PRD-10` — supersedes the never-activated `connectors/gas/shopify.gs` (deleted here) and registers the new source's watchdog exemption
- `PRD-11` — mechanical exclusivity guard (`validateIngest_` rejects `coffee_order_app` supplier rows) + watchdog exemption + schema/contract docs

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself — set `"status": "needs_context"` and stop.

## Files to Read

- `connectors/gas/staleness.gs` (whole file — `STALENESS_SOURCES` at :30, the exemption comment above it)
- `connectors/gas/shopify.gs` (the file being deleted — note `stalenessStampHeartbeat_('shopify')` at :88 is its only heartbeat stamper)
- `connectors/gas/test_code.js` :331 (`load('shopify.gs')`), :2794 (`STAMPS_HEARTBEAT` literal), :2795 (`EXEMPT` literal), :2811+ (`testCoffeeOrderAppContract`), :4171–4173 (shopspend registration-guard precedent), plus every suite that tests shopify.gs symbols (`shopifyOrdersToRows_`, `shopifyParseLinkHeader_`, ~:1031–1200)
- `connectors/gas/Code.gs` :235 (`validateIngest_`)
- `docs/schema.md`, `docs/ingest-contract.md`

## Task

1. **staleness.gs:** remove `'shopify'` AND `'coffee_order_app'` from `STALENESS_SOURCES`
   (:30). Both are never-seen sources that can only false-alarm: shopify.gs never ran
   and is deleted below; coffee_order_app's two prospective ingest paths are closed by
   this phase's exclusivity guards and it stamps no heartbeat today. Extend the
   exemption comment: `shopify_orderapp` (weekly, Mon 05:00) and `greenbean` (weekly,
   Tue 05:00) are deliberately NOT in the 96h watchdog — their cadence is 168h and
   their failure detection is the orderapp fail-open counter/alert (orderapp.gs).
2. **Delete `connectors/gas/shopify.gs`** (git history preserves it — do not keep a
   commented-out copy).
3. **test_code.js:**
   - delete the `load('shopify.gs')` line (:331)
   - delete `'shopify'` from the `STAMPS_HEARTBEAT` literal (:2794). Do NOT move it to
     `EXEMPT` — a deleted connector is not a "deliberately unwatched" source.
   - add `'shopify_orderapp'` and `'greenbean'` to the `EXEMPT` literal with one-line
     reason strings (cadence 168h > 96h threshold; failure detection = orderapp
     fail-open alert)
   - add registration guards mirroring :4171–4173: "`shopify` is NOT in
     STALENESS_SOURCES", "`coffee_order_app` is NOT in STALENESS_SOURCES"
   - delete every shopify.gs-only suite (`shopifyOrdersToRows_`,
     `shopifyParseLinkHeader_`, its fetch-wrapper suites) — KEEP the generic
     `global.UrlFetchApp` save/swap/restore helpers used by orderapp suites
   - after deletion, `grep -n "shopifyDailyPull\|shopifyOrdersToRows_\|shopifyParseLinkHeader_" connectors/gas/` must return nothing
4. **Code.gs `validateIngest_`:** reject `kind='suppliers'` (or omitted-kind default)
   payloads with `source='coffee_order_app'` → `{result:'error', message:` naming the
   greenbean exclusivity (stock-intake invoices arrive only via the Order-app
   greenBeanCost pull, `source='greenbean'`)`}`. Update `testCoffeeOrderAppContract`
   (:2811+) in the same change so the contract test asserts the rejection instead of
   the old reserved-payload acceptance.
5. **docs/schema.md:** document `source='greenbean'` Suppliers semantics — invoice_ref
   format `supplierKey/invoiceNum` (+ `noinv-` fallback), ALL statuses = committed
   spend, `total` is **GST-inclusive for `source='greenbean'` only** (do not declare
   GST semantics for other sources — unverified), stale-row limitation + runbook (a
   row deleted from the Order app's 06_Stock_Intake leaves a stale hub row: edit/zero
   the Suppliers row, then run `weeklySummarize('<week>')`). Document the Summary
   `supplier='shopify_orderapp'` revenue rows and the shopify.gs retirement note.
6. **docs/ingest-contract.md:** mark the reserved `coffee_order_app` bean-invoice
   payload shape (§ around lines 51–61) as superseded/rejected (mechanically enforced
   by validateIngest_), and the online-revenue payload shape (lines 38–49) as mutually
   exclusive with the PRD-10 shopify_orderapp feed — no connector may POST online
   Shopify revenue.

### Test First (TDD step)

Test cases (defined at design time — these are "done"):
- `validateIngest_` with `kind:'suppliers', source:'coffee_order_app'` → `result:'error'`, message mentions greenbean exclusivity
- omitted `kind` (defaults to suppliers) + `source:'coffee_order_app'` → same rejection
- `kind:'suppliers', source:'greenbean'` (well-formed rows) → accepted
- registration guards: `'shopify'` not in `STALENESS_SOURCES`; `'coffee_order_app'` not in `STALENESS_SOURCES`
- heartbeat-watch consistency suite passes with `'shopify'` removed from `STAMPS_HEARTBEAT` and the two new EXEMPT entries present
- full suite green with shopify.gs deleted (proves nothing else referenced it)

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

Also (manual greps, must be empty):

```bash
grep -rn "shopifyDailyPull\|shopifyOrdersToRows_\|shopifyParseLinkHeader_\|load('shopify.gs')" connectors/gas/
```

## Verification Procedure

1. Run the AC commands.
2. Checklist: no shopify.gs references anywhere; EXEMPT reasons are honest one-liners; ingest-contract.md and testCoffeeOrderAppContract agree.
3. Update this step in `phases/orderapp-pulls/index.json`.

## Prohibitions

- Do not add `'shopify'` to the EXEMPT literal. Reason: it mislabels a deleted connector as deliberately-unwatched forever; the honest fix is deleting it from STAMPS_HEARTBEAT.
- Do not delete the generic `global.UrlFetchApp` swap helpers. Reason: the orderapp suites (steps 0/2/4) depend on them.
- Do not touch `SHOPIFY` references inside `recurringSlug_`/`RECUR_SHOPIFY` fixtures (~:2674). Reason: that is the Suppliers-side recurring-invoice slug under `source='recurring'` — a different tab and key space, unrelated to the retired feed.
- Do not declare GST semantics for sources other than greenbean in schema.md. Reason: retroactive claim over Mayers/Ordermentum/FDCo that nobody verified.
- Do not break existing tests (beyond deleting the shopify.gs-only suites).
