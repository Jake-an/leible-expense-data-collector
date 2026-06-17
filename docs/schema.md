# Sheet Schema

Two tabs, one Sheet. All sources normalize to one of these before writing. Invoice-level for suppliers (no line items, no GST, no categories), daily-gross for sales.

A third tab `_staging` is a scratch area to test ingestion before trusting a connector — same columns as `Suppliers`.

## Tab `Suppliers` (invoice-level, all supplier sources)

| Column | Type | Required | Description |
|---|---|---|---|
| `date` | date (YYYY-MM-DD) | yes | Invoice / order date |
| `supplier` | string | yes | Canonical supplier name (see mapping) |
| `total` | number | yes | Invoice total in AUD (positive = expense, negative = credit) |
| `invoice_ref` | string | yes | Invoice or order number (also the dedup key) |
| `location` | string | no | Delivery site, where the source exposes it |
| `source` | string | yes | Connector identifier (`food_dairy_co`, `mayers`, …) |
| `extracted_at` | datetime (ISO 8601) | yes | When the connector pulled this row |

**Dedup key:** `source + invoice_ref`. Invoice-level granularity makes this a clean natural key. Duplicates are silently skipped on insert (not an error).

## Tab `Sales` (Square, daily gross per location)

| Column | Type | Required | Description |
|---|---|---|---|
| `date` | date (YYYY-MM-DD) | yes | Sales day (Australia/Sydney) |
| `location` | string | yes | Square location name |
| `gross_sales` | number | yes | Gross sales total in AUD for that location that day |
| `source` | string | yes | Always `square` |
| `extracted_at` | datetime (ISO 8601) | yes | When the pull ran |

**Dedup key:** `date + location`. Gross only, no backfill — starts from go-live.

## Canonical Supplier Names

| Source connector | `supplier` value |
|---|---|
| food_dairy_co | Food and Dairy Co |
| fresh_and_chill | Fresh and Chill |
| kent_paper | Kent Paper |
| ordermentum (Tuga) | Tuga Pastry |
| ordermentum (Butterboy) | Butterboy |
| mayers | Mayers |

GAS resolves `supplier` from the `source` field via a `SUPPLIER_NAMES` map in `connectors/gas/Code.gs`. Ordermentum carries the canonical name per-account in the POST payload (Tuga vs Butterboy share `source: "ordermentum"`).

## Labour (not a tab built here)

Labour cost (date × location: gross + super + weekend/PH penalties, **no tax**) is owned by the **LEIBLE_Payroll** project. This collector links to Payroll's output sheet rather than recomputing it. See `docs/ADR.md` ADR-007.
