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

**`greenbean` source** (`connectors/gas/orderapp.gs`, `greenBeanPull` /
`greenBeanInvoices_`): pulls green-bean stock-intake invoices from the
Order-app read API (`?api=greenBeanCost`) and groups raw lines into one
`Suppliers` row per invoice. `invoice_ref` is `<supplierKey>/<invoiceNum>`,
or `<supplierKey>/noinv-<dateLocal>` when the API line carries no invoice
number — this is the grouping key as well as the dedup key, so two lines
sharing a blank invoice number on the same day and supplier collapse into
one summed row, but the same supplier's blank-invoice lines on different
days do not. **All statuses count as committed spend** — the fetch requests
`status: 'ALL'` and `greenBeanInvoices_` sums every line's `totalCostIncGst`
with no status-based filtering; there is no "provisional" or "draft" carve-out
on this source today. **`total` is GST-inclusive for `source='greenbean'`
only** — this is verified from the API field name (`totalCostIncGst`); GST
treatment is NOT asserted for any other `Suppliers` source (Food and Dairy
Co, Fresh and Chill, Kent Paper, Mayers, Ordermentum) — nobody has verified
those, so don't assume consistency.

**Stale-row limitation and runbook:** if a stock-intake row is deleted from
the Order app's `06_Stock_Intake` sheet after the hub already ingested it,
the hub has no delete signal — the API only ever returns what currently
exists, so a vanished invoice simply stops appearing in future pulls, and
the already-ingested `Suppliers` row (and its already-summarized `Summary`
contribution) goes stale silently. To correct it: manually edit the stale
`Suppliers` row (zero out `total`, or delete the row entirely), then run
`weeklySummarize('<week_start>')` for the affected week to re-derive
`Summary` from the corrected `Suppliers` data.

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

**`shopify` source — RETIRED.** `connectors/gas/shopify.gs` (`shopifyDailyPull`,
direct Shopify Admin API access requiring `SHOPIFY_SHOP_DOMAIN` /
`SHOPIFY_ACCESS_TOKEN` Script Properties) never ran in production and has been
deleted (git history preserves it). Online Shopify revenue is now sourced
exclusively via the Order-app read API — see `shopify_orderapp` under
`Summary` below. `channel='online'` rows in this tab are historical only —
`validateIngest_` MECHANICALLY REJECTS any `kind='revenue'` payload containing
a `channel='online'` row (case-insensitive, any source): online revenue's sole
producer is the Order-app shopifySales pull (PRD-10 exclusivity; see
`docs/ingest-contract.md`).

## Tab `Summary` (weekly rollup, spend AND revenue)

`week_start | week_end | supplier | location | total | summarized_at | department | kind`.
`kind` is `spend` (from `Suppliers`) or `revenue` (from `Revenue`) — the two are
**never netted against each other**. The `supplier` JSON field holds the customer
name on `kind:'revenue'` rows (dual meaning, documented in `docs/api.md`).
`weeklySummarize()` **upserts** (see `docs/api.md`), keyed on
`week_start||department||kind||supplier||location`.

**`supplier='shopify_orderapp'` revenue rows are a direct write, not a
`weeklySummarize()`-derived row.** `shopifyWeeklyPull`/`_impl_`
(`connectors/gas/orderapp.gs`) pulls the last 4 completed ISO weeks from the
Order-app read API (`?api=shopifySales`) and `upsertRows_`s straight into
`Summary` — `kind='revenue'`, `supplier='shopify_orderapp'`,
`location='online'`, `department='Roastery'` — bypassing `Revenue` entirely.
This is the one exception to "`Summary` is always derived from `Suppliers`/
`Revenue`" in this schema. Past weeks are re-pulled every run (the Order app
serves a live snapshot), so a changed gross updates the row in place.

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

## shopSpend tabs (separate silo — outside the two-tab ingest contract)

Three tabs consume an **external** internal Apps Script JSON API (`shopSpend`) that
reports per-shop, per-ISO-week order dollars. This is not the `Suppliers`/`Sales`/
`Revenue`/`Summary` pipeline: no existing tab, header, or the `doGet` contract is
touched by any of this. No report reads these tabs except `ShopSpend Report`
(built from `ShopSpend` + `ShopSpendPulls`, not from any other tab).

### `doPost` request fields for `kind: 'shopspend'`

Two request-only fields govern absence detection. They are the contract of
record for the destructive path — `docs/api.md` cross-references them here.

| Field | Type | Required | Description |
|---|---|---|---|
| `weeks_complete` | array of `YYYY-Www` | no | Weeks this request carries **in full**. GAS tombstones missing shop-weeks **only** for weeks named here. Absent ⇒ tombstone nothing (a `Logger.log` warning records the degraded mode). A week split across requests is named in **no** request's `weeks_complete`, so it degrades to a stale `present` row rather than a wrong `absent` one. |
| `weeks_verified_empty` | array of `YYYY-Www` | no | Weeks the caller declares genuinely empty. Every entry **must** also appear in this request's `weeks_complete`, and **must not** have any row in this request's `rows` — `validateIngest_` rejects the payload otherwise. Standing the blast-radius breaker down for a legitimate 100% absence is its only purpose. |

Both are validated element-by-element against `^\d{4}-W\d{2}$`. Each request is
validated **alone**, so `weeks_verified_empty` must be scoped to the chunk that
declares it — attaching the full list to every chunk aborts a multi-chunk pull.

What backs `weeks_verified_empty` is a whole-fetch completeness gate plus that
week returning zero rows — **not** a per-week positive probe. See `docs/api.md`
for the gate's conditions and the mass-absence confirmation procedure.

### Tab `ShopSpend` (append-only snapshot store)

| Column | Type | Required | Description |
|---|---|---|---|
| `shop_id` | string | yes | Upstream shop identifier |
| `week_label` | string | yes | ISO week label as returned by the API (e.g. `2026-W31`) |
| `week_start` | date (YYYY-MM-DD) | yes | Passed through from the API — never recomputed here |
| `week_end` | date (YYYY-MM-DD) | yes | Passed through from the API — never recomputed here |
| `order_count` | number | yes | Confirmed order count for the shop-week |
| `amended_count` | number | yes | Count of orders still in `Amendment Requested` state (dollars provisional) |
| `total_ex_gst` | number | yes | Order dollars excluding GST |
| `gst` | number | yes | GST component (`0` is normal — many coffee SKUs are GST-free) |
| `total_inc_gst` | number | yes | Order dollars including GST |
| `gst_treatment` | string | yes | GST treatment tag from the API meta (`EXCLUSIVE_PRIMARY` for shopSpend) |
| `environment` | string | yes | Upstream environment the pull ran against (e.g. `prod`, `staging`) |
| `fetched_at` | datetime (ISO 8601, AEST/AEDT offset) | yes | When this snapshot was pulled |
| `source` | string | yes | Connector identifier (`shopspend`) |
| `presence` | string | yes | `present` or `absent` (see tombstone rule below) |

**Change-detection key:** `shop_id + week_label`. This tab is **append-only**: a
re-pull writes a **new row only when a figure changed** for that key (identical
figures for the same shop-week are skipped, not re-written). Rows are never
edited or deleted in place — history is the append log itself.

**`presence` tombstone semantics:** `presence` is normally `present`. If a
shop-week that existed in a previous pull is **missing** from the current pull's
results, a new row is appended for that key with `presence: 'absent'` — a
tombstone marking "this shop-week disappeared from upstream as of this pull."
A tombstone counts as a figure change for the change-detection rule above (a
transition from `present` to `absent`, or back, always appends).

**"Latest snapshot" = the last matching row in append order — explicitly NOT**
`max(fetched_at)`. `fetched_at` carries a UTC offset (`+11:00`/`+10:00` across
the Australia/Sydney DST flip) and a lexicographic string compare on it orders
the DST transition wrongly. Always resolve "latest" by scanning for the last row
matching `shop_id + week_label` in sheet-row order, never by comparing
`fetched_at` values.

### Tab `ShopSpendPulls` (one row per pull, always written)

| Column | Type | Required | Description |
|---|---|---|---|
| `fetched_at` | datetime (ISO 8601) | yes | When this pull ran (shared across all `ShopSpend` rows it wrote) |
| `environment` | string | yes | Upstream environment pulled against |
| `from_week` | string | yes | First ISO week label requested |
| `to_week` | string | yes | Last ISO week label requested |
| `matched` | number | yes | Shop-weeks matched by the query |
| `returned` | number | yes | Shop-weeks actually returned |
| `truncated` | boolean | yes | Whether the API truncated the result set |
| `warnings_count` | number | yes | Count of `warnings[]` entries from the API |
| `warnings` | string (JSON array) | yes | The `warnings[]` payload itself |
| `unpriced_sku_count` | number | yes | Count of SKUs the API skipped for lack of pricing |
| `unpriced_skus` | string (JSON array) | yes | The `unpricedSkus` payload — these dollars are **missing**, not zero |
| `amended_count` | number | yes | Total orders still in `Amendment Requested` across this pull |
| `possible_duplicate_shop_names` | string (JSON array) | yes | Shop-name collisions the API flagged |
| `empty_range_with_invalid_labels` | boolean | yes | Whether the requested range was empty AND carried invalid week labels |
| `invalid_week_labels` | string (JSON array) | yes | Week labels the API rejected as malformed |
| `gst_treatment` | string | yes | GST treatment tag for this pull (`EXCLUSIVE_PRIMARY`) |
| `diverges_from_live_pricing` | boolean or `""` | yes | Whether returned totals diverge from the current live pricing sheet. `""` = **not assessed** — the API exposes no pricing-divergence signal to derive this from |
| `matches_live_pricing` | boolean or `""` | yes | Whether returned totals match the current live pricing sheet. `""` = **not assessed**, same reason as above |
| `total_orders_scanned` | number | yes | Total orders the API scanned to build this response |
| `absent_shop_ids` | string (JSON array) or `""` | yes | Shop ids tombstoned as `absent` in this pull. `""` = **not assessed** — GAS computes tombstones after this pull row is built, so the connector cannot know them yet |
| `diagnostics_json` | string (JSON object) | yes | Full raw diagnostics blob, for anything not broken out above. Includes a `harness` key: `{weeks_complete, weeks_verified_empty}`, the declared week list from the completeness gate — makes a regression that silently disables absence detection visible in the Sheet even though it isn't a dedicated column |

**Always written**, even when zero `ShopSpend` rows changed — this is what makes
history reproducible: the upstream API **recomputes totals live from a pricing
sheet**, so re-pulling the same week can legitimately return different numbers
on a later pull. `ShopSpendPulls` is the audit trail of every pull attempt and
its diagnostics, independent of whether `ShopSpend` itself changed.

### Tab `ShopSpend Report` (derived, rebuilt in place)

Not append-only — this tab is fully rebuilt each time from the current contents
of `ShopSpend` + `ShopSpendPulls`. A banner block at the top surfaces data-quality
signals (warnings, unpriced SKUs, amended counts, possible duplicate shop names,
absent shop-weeks, invalid week labels), followed by a grid of shops (rows) ×
ISO weeks (columns). Columns are sorted numerically by parsed `(year, weekNumber)`
from `week_label` — **never lexicographically on the label string** (lexicographic
sort breaks across a year boundary, e.g. `2026-W5` vs `2026-W31` vs `2027-W1`).
`week_start`/`week_end` values shown are passed through from `ShopSpend` as
pulled from the API — this report never recomputes week boundaries.
