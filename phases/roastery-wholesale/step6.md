# Step 6: silo-check-and-docs

## Requirements Covered

- `PRD-14` — prove the shopSpend silo holds against the new writer, and bring every doc
  that describes this path up to date.

If the Task below contradicts the requirement, `docs/ADR.md`, or a CRITICAL rule in
CLAUDE.md, set `"status": "needs_context"` with the contradiction spelled out and stop.

## Files to Read

- `connectors/gas/Code.gs` — `weeklySummarize_impl_`, `aggregateSupplierRows_` (`:1894`),
  `doGet` and `doGetShopSpendCoverage_` (`:1687`, `:1753`).
- `connectors/gas/shopspend.gs`, `connectors/gas/summary_audit.gs`.
- `docs/schema.md`, `docs/ingest-contract.md`, `docs/api.md`, `docs/PRD.md`, `TODO.md`.
- `phases/roastery-wholesale/prod-probe.md`.

## Task

**1. Silo proof — do the greps, then write the finding verbatim into this step's notes.**
Establish and record, with file:line evidence, that:
- the `ShopSpend` / `ShopSpendPulls` / `ShopSpend Report` tabs are reached only by
  `shopspend.gs`, the tab constants and normalizers in `Code.gs`, and
  `doGetShopSpendCoverage_` behind its own `fn=shopspendCoverage`;
- `weeklySummarize_impl_`, `aggregateSupplierRows_`, the default `doGet` summary path and
  `summary_audit.gs` read only `Suppliers`, `Revenue`, `Summary` and `_archive`;
- therefore nothing anywhere adds shopSpend dollars to wholesale dollars.

Record the sharper form the step-0 probe found: a single order carries
`invoiceStatus: 'Finalized'` **and** `status: 'Receipt Confirmed'` at the same time. So
`?api=shopSpend` (which filters on `Receipt Confirmed`/`Amendment Requested`) and
`?api=wholesaleSales` (which filters on `Finalized`/`Archived`) return the **same orders**,
not merely rows from the same sheet. The silo therefore holds only because no report reads
both tab sets — it is a reporting boundary, not a data-level one. Say that plainly.

**2. `summaryOrphanSweep_` bounds.** Record that it **does** cover `kind='revenue'` rows
(`summary_audit.gs:585`), but skips any week before `auditPurgeCutoff_` and any week
carrying `_archive` rows (`:581-582`, `:600-601`) — so a shop reclassified upstream before
the purge line orphans a `location='wholesale'` Summary row that nothing will ever sweep.

**3. Docs.**
- `docs/schema.md` — under `Revenue`: name `coffee_order_app` as a live writer, list the
  four `channel` values, and state that `amount` from this source is **GST-EXCLUSIVE**,
  written as the producer emits it. Mirror the existing per-source GST precedent in the
  `Suppliers` section ("`total` is GST-inclusive for `source='greenbean'` only… not
  asserted for any other source"). Explain why there is no gross-up: roasted coffee is
  GST-free food in AU, so ×1.1 would invent revenue that was never charged, on a figure
  the producer states is never reconciled against Xero.
- `docs/ingest-contract.md` §1 — mark the reserved source **LIVE**, and state that its
  producer is the GAS-native `wholesalePull`, **not** `doPost`. Add the consequence that
  matters: a GAS-native caller bypasses `validateIngest_` entirely, so none of the
  rejections this doc attributes to ingest apply on that path —
  `wholesaleRevenueRows_` re-implements them. Update the staleness note (it is now watched).
- `docs/api.md` — the four new `location` values are a change to a contract with an
  external consumer. Name `LEIBLE_GM_COST_MONITOR`, its Monday 08:00 read, and that its
  `ROASTERY_REVENUE_CHANNELS` config (default `online,wholesale`) decides which of them
  reach the company headline. State the prohibition: `internal` / `ambiguous` / `unknown`
  must **not** be added to that list.
- `docs/PRD.md` — PRD-14 already exists; leave it `planned`. It flips to `built` only
  after step 8's live verification, the same rule PRD-9/10/11 followed.
- `TODO.md` — replace the stale "**Blocked on:** the upstream API key" block. It was never
  blocked: the owner is `?api=wholesaleSales` and it uses the `ORDER_APP_COST_TOKEN` the
  collector already holds. Record the corrected magnitude from `prod-probe.md`: the
  "$10k+/week wholesale money" is the `all` bucket and is **84.2% internal** cafe
  transfers; genuine external wholesale is **~$2,364/week**. Add a follow-up item for
  splitting a dedicated `COST_API_TOKEN` (the producer doc §12 flags that this endpoint
  newly exposes order-level revenue for every Leible cafe on a token shared with three
  other consumers), and one noting `greenBeanPull` (Tue 05:00) also misses the Monday
  08:00 consumer read.

## Acceptance Criteria

```bash
bash scripts/lint.sh
node connectors/gas/test_code.js
```

Docs-only step: the suite must stay green, not grow.

## Verification Procedure

1. Run both AC commands. Record pass/fail counts.
2. `git diff --stat` — confirm only `docs/` and `TODO.md` changed, plus this step's notes.
   No `.gs` file may change in this step.
3. Re-read the TODO.md block you replaced and confirm no sentence still claims the work is
   blocked on a credential.
4. Update this step in `phases/roastery-wholesale/index.json`.

## Prohibitions

- Do not change any `.gs` file in this step. Reason: a docs step that also moves code
  makes the phase-end review unable to attribute a regression.
- Do not flip PRD-14 to `built`. Reason: green tests are not live verification; that is
  step 8's job.
- Do not add `internal` / `ambiguous` / `unknown` to `ROASTERY_REVENUE_CHANNELS` in
  `LEIBLE_GM_COST_MONITOR`, or recommend it. Reason: it would fold inter-company transfers
  into company revenue, double-counting money the cafes' Square sales already book.
- Do not edit the `LEIBLE_GM_COST_MONITOR` or `LEIBLE_Order_app` repos at all. Reason:
  they are out of this phase's scope; note the follow-ups in TODO.md instead.
