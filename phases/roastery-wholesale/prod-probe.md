# Step 0 — PROD contract probe, `?api=wholesaleSales`

Run 2026-09-03 against **PROD** `ORDER_APP_EXEC_URL`
(`AKfycbwuLSrcyi…/exec`), token resolved via `base_connector.get_credential`
(`ORDER_APP_COST_TOKEN`, 64 chars). One request per completed ISO week,
`limit=200`, `offset` default.

## Verdict: ❌ GATE FAILED — do not proceed to code

The plan's step-0 gate required `summary.external.gross >= 7000` in at least
3 of the last 4 completed weeks. **0 of 4 pass.** The largest external week in
the whole 8-week window is $4,887.40.

Everything else the gate checks is healthy: every week returned `ok:true`,
`environment: PROD`, `schemaVersion: 1`, `meta.week`/`weekStart` echoing the
request, and **all five `diagnostics.*Ok` true** on all 8 weeks. The endpoint
is working correctly. The premise was wrong, not the API.

## Measured — 8 completed weeks

| week | start | all | internal | external | ambiguous | unknown | excluded |
|---|---|---:|---:|---:|---:|---:|---|
| 2026-W28 | 2026-07-06 | 14,063.48 | 11,463.58 | 2,599.90 | 0 | 0 | — |
| 2026-W29 | 2026-07-13 | 14,266.13 | 12,665.83 | 1,211.70 | 388.60 | 0 | — |
| 2026-W30 | 2026-07-20 | 17,800.10 | 14,053.80 | 3,746.30 | 0 | 0 | — |
| 2026-W31 | 2026-07-27 | 18,660.36 | 13,399.77 | 4,887.40 | 373.19 | 0 | — |
| 2026-W32 | 2026-08-03 | 16,709.92 | 15,312.77 | 1,397.15 | 0 | 0 | — |
| 2026-W33 | 2026-08-10 | 14,514.17 | 12,895.79 | 1,200.30 | 418.08 | 0 | 1 / $2,896.66 |
| 2026-W34 | 2026-08-17 | 14,919.00 | 13,323.35 | 1,595.65 | 0 | 0 | — |
| 2026-W35 | 2026-08-24 | 16,251.90 | 13,980.20 | 2,271.70 | 0 | 0 | 2 / $289.44 |

**8-week totals:** all $127,185.06 · internal $107,095.09 (**84.2%**) ·
external $18,910.10 (**14.9%**) · ambiguous $1,179.87 · unknown $0.
**External weekly mean $2,363.76. Internal weekly mean $13,386.89.**

## What this means

TODO.md's "$10k+/week wholesale money" is the **`all`** bucket. 84% of it is
`internal` — beans moved to Leible's own cafes (Leible Pitt / York / Blue),
which is an inter-company transfer, not income. Those cafes' Square sales are
already counted as revenue; booking the transfer as revenue too would
double-count it.

Genuine external wholesale income is **~$2.4k/week**, not $10k+.

## Other facts confirmed for the build

- `orphanRows` is a stable $2,703 / 3 rows in **every** weekly response —
  exactly as `wholesale-sales-api.md` §9 states. Never ingest it.
- `outOfWeekRows` gross varies per call ($240,485–$242,977) and is ~138 rows
  against `rowsScanned: 162` — it really is "the rest of the sheet".
- `blankRows: 14` on every call.
- **No paging pressure today.** `meta.paging.matched` was 5–7 every week
  against `limit=200`; `truncated: false` throughout. `rowsIncluded` came back
  as the boolean `true`, confirming the code over the doc example.
- `excluded` is non-zero in 2 of 8 weeks — in-week orders not yet
  Finalized/Archived. This is the late-arrival the 8-week re-pull window exists
  for, and it is real, not theoretical.
- `classificationConflicts` fires on `Leible Taiwan`
  (`name-conflicts-sheet-wholesale`) in W29/W31/W33 — the AMBIGUOUS money.
- **Sharper than the plan assumed:** a sample order carries
  `invoiceStatus: "Finalized"` AND `status: "Receipt Confirmed"`
  simultaneously. So `?api=shopSpend` (which filters on `Receipt Confirmed`)
  and `?api=wholesaleSales` see the **same orders**, not merely the same
  sheet. The silo holds because no report combines the tabs — but the overlap
  is at order level, which is worth stating explicitly in the docs step.
- Order fields present: `orderId, date, shopId, shopType, shopTypeSource,
  amount, invoiceStatus, status, xeroInvoiceNumber, xeroInvoiceNumber2`.
