# Sheet Schema

Suppliers, Sales, Labour, Revenue and Summary, one Sheet. All sources normalize to
one of these before writing. Invoice-level for suppliers, daily-gross for Square
sales, order-level for Revenue.

Every pre-existing tab carries a `department` column, appended **last** so
index-based dedup keys stay valid (see `docs/ADR.md` for why). Existing rows
backfill to `Cafe`; the only other value today is `Roastery`. `DEPARTMENTS` in
`connectors/gas/Code.gs` is the source of truth — an ingest row with any other
value is rejected by `validateIngest_`.

A tab `_staging` is a scratch area to test ingestion before trusting a connector —
same columns as `Suppliers`.

## Tab `Suppliers` (invoice-level, all supplier sources — Cafe expenses + Roastery COGS)

| Column | Type | Required | Description |
|---|---|---|---|
| `date` | date (YYYY-MM-DD) | yes | Invoice / order date |
| `supplier` | string | yes | Canonical supplier name (see mapping) |
| `total` | number | yes | Invoice total in AUD (positive = expense, negative = credit) |
| `invoice_ref` | string | yes | Invoice or order number (also the dedup key) |
| `location` | string | no | Delivery site, where the source exposes it |
| `source` | string | yes | Connector identifier (`food_dairy_co`, `mayers`, …) |
| `extracted_at` | datetime (ISO 8601) | yes | When the connector pulled this row |
| `department` | string | yes | `Cafe` or `Roastery`; defaults to `Cafe` if omitted |

**Dedup key:** `source + invoice_ref`. Invoice-level granularity makes this a clean
natural key. A re-ingest of the same key **upserts**: unchanged amount is skipped,
a changed amount updates the row in place (`total` + `extracted_at`) rather than
appending a duplicate — see `ingestSupplierRows`/`upsertRows_` in `Code.gs`.

## Tab `Sales` (Square, daily gross per location — always Cafe)

| Column | Type | Required | Description |
|---|---|---|---|
| `date` | date (YYYY-MM-DD) | yes | Sales day (Australia/Sydney) |
| `location` | string | yes | Square location name |
| `gross_sales` | number | yes | Gross sales total in AUD for that location that day |
| `source` | string | yes | Always `square` |
| `extracted_at` | datetime (ISO 8601) | yes | When the pull ran |
| `department` | string | yes | Always `Cafe` (Square only serves the cafes) |

**Dedup key:** `date + location`. Gross only, no backfill — starts from go-live.
A **prior** day's row may be corrected in place (narrow upsert); the current
Sydney day never overwrites itself mid-day — see `appendSalesRow_`.

## Tab `Revenue` (order-level, non-Square revenue — currently Roastery only)

| Column | Type | Required | Description |
|---|---|---|---|
| `date` | date (YYYY-MM-DD) | yes | Order date |
| `department` | string | yes | `Cafe` or `Roastery`; defaults to `Cafe` if omitted |
| `channel` | string | yes | e.g. `wholesale`, `online` (Shopify) |
| `customer` | string | yes | Customer / order name |
| `amount` | number | yes | Gross order total in AUD (incl. shipping + GST) |
| `order_ref` | string | yes | Order or upload id (also the dedup key) |
| `source` | string | yes | Connector identifier |
| `extracted_at` | datetime (ISO 8601) | yes | When the row was ingested |

**Dedup key:** `source + order_ref`, same upsert semantics as `Suppliers`. An
amended wholesale order (same key, changed amount) updates in place.

**`shopify` source** (`connectors/gas/shopify.gs`, `shopifyDailyPull`): pulls
Shopify Admin API orders (`current_total_price`, not `total_price`, so a later
refund upserts a lower amount) for `channel='online'`, always
`department='Roastery'`. `customer` is the order's customer name, or
`#<order_number>` for a guest checkout. `order_ref` is the Shopify order id.
Requires Script Properties `SHOPIFY_SHOP_DOMAIN` and `SHOPIFY_ACCESS_TOKEN`
(scope `read_orders`) — never in the repo, never in chat. The daily trigger
re-pulls the last 2 days so a late refund still lands.

## Tab `Summary` (weekly rollup, spend AND revenue)

`week_start | week_end | supplier | location | total | summarized_at | department | kind`.
`kind` is `spend` (from `Suppliers`) or `revenue` (from `Revenue`) — the two are
**never netted against each other**. The `supplier` JSON field holds the customer
name on `kind:'revenue'` rows (dual meaning, documented in `docs/api.md`).
`weeklySummarize()` **upserts** (see `docs/api.md`), keyed on
`week_start||department||kind||supplier||location`.

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
