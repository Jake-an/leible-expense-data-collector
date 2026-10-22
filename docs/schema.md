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

**Since 2026-09-23 (ingest-validation hardening, see `docs/ingest-contract.md`):**
GAS owns every stamp — `doPost` overwrites a POSTed `extracted_at` (and every
shopspend row's `fetched_at` / the pull's `fetched_at`) with its own server
time before writing; a caller-supplied value is accepted and ignored. Every
row's `date` must be a real `YYYY-MM-DD`, no more than 14 days ahead of today
(Sydney), no lower bound. A row that omits `department` is ASSIGNED the
authenticated source's bound department (`INGEST_SOURCE_DEPARTMENTS_`), not a
blanket `Cafe` default.

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

**Stale-row detection (orphans) and runbook:** the hub gets no delete or
rename signal from the Order app — the API only ever returns what currently
exists. `greenBeanPull` closes that gap with **orphan detection**: every pull
re-fetches the entire ~3-month window, so any `Suppliers` greenbean row whose
stored date is inside the window but whose `invoice_ref` was NOT re-submitted
by the pull has lost its upstream counterpart — the intake row was renamed
(supplier edit), re-keyed (invoice-number edit), re-dated (see below), or
deleted. It raises a `greenbean_orphan` data-quality alert naming each stale
ref; the stale row's money double-counts against its replacement (or
over-counts a deletion) until fixed. Rows OLDER than the pull window are
legitimately absent from the pull and are never flagged — a deletion that old
still goes stale silently. Remediation is manual by design (the alert, not
the code, decides what the truth was): zero out the stale row's `total`, then
run `weeklySummarize('<week_start>')` for its week. A zeroed row drops out of
the orphan set, so completing the runbook clears the alert.

A **supplier rename** in `06_Stock_Intake` is the same pattern — the edited
cell changes `supplierKey`, so the invoice re-ingests under a NEW
`invoice_ref` while the old row stays behind. The orphan alert covers it,
including PARTIAL renames where other invoices still carry the old spelling,
and adds a "possibly renamed to <new ref>" hint when a new ref in the same
pull carries the same bare invoice number.

A **date correction** upstream (same invoice ref, moved date) self-heals:
`greenBeanPull` updates the Suppliers row's `date` and `extracted_at` in
place and resummarizes BOTH the old and new weeks — no manual step needed.
The exception is a **blank-invoice line**: its `noinv-<date>` ref embeds the
date, so a date edit mints a NEW identity instead of matching the stored row
— the stale old row then surfaces through the orphan alert above rather than
self-healing.

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

**`coffee_order_app` source — BUILT, NOT YET LIVE** (nothing deployed, no trigger
installed, never run against the live Sheet as of 2026-09-04; step 8 of the
`roastery-wholesale` phase is the first supervised run) (`connectors/gas/orderapp.gs`, `wholesalePull` /
`wholesaleRevenueRows_`, PRD-14): a GAS-native time-triggered pull of the Order app's
`?api=wholesaleSales` endpoint, last `WHOLESALE_REPULL_WEEKS` (8) completed ISO weeks,
`department='Roastery'`. The producer's four shop-classification buckets map 1:1 onto
`channel`: `external`→`wholesale`, `internal`→`internal`, `ambiguous`→`ambiguous`,
`unknown`→`unknown`. Only `channel='wholesale'` is genuine external income — `internal`
is beans moved to Leible's own cafes, an inter-company transfer already counted via those
cafes' Square sales, and `ambiguous`/`unknown` are shops the producer itself couldn't
classify. See `docs/api.md` for which of the four reach `LEIBLE_GM_COST_MONITOR`'s
company-revenue headline. **`amount` is GST-EXCLUSIVE for `source='coffee_order_app'`
only** — written exactly as the producer emits it, no gross-up — mirroring the `greenbean`
precedent above (GST treatment is per-source and not asserted for any source beyond the
one it's verified for). No gross-up is applied on purpose: roasted coffee is GST-free food
in Australia, so multiplying by 1.1 would invent revenue that was never charged, on a
figure the producer states is never reconciled against Xero.

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

## Labour (`Labour` tab + `Summary` supplier `Labour`)

`Labour` columns: `week_start, week_end, location, total, iso_week, pulled_at, department`, upserted on `week_start||location` (a changed total or department is rewritten). Two producers, routed per location by `labourWeeklyRoute_` (ADR-011):
- **Legacy** (default; `LABOUR_SOURCE` unset): the Onboarding app's `LABOUR_COST` via `LABOUR_SHEET_ID` (ADR-007), department `Cafe`.
- **Clock** (`LABOUR_SOURCE=clock`, weeks ≥ `CLOCK_START_WEEK`, LOCATIONS rows with `live` = yes/true): computed in GAS from the Labour Sheet (`LABOUR_CLOCK_SHEET_ID`: CLOCK_RAW + rule tabs), also upserted into the Labour Sheet's `LABOUR_COST` (`iso_week … total, shift_count, exception_count, computed_at`); department from LOCATIONS (`Roastery` for the fixed-cost roastery).

`_labour_snapshot` (hub): `Summary` columns + `snapshot_at` — rows removed by `labourRunRoasteryCleanup()`, consumed by `labourRunRollback()`.

## Roster payload (`kind: 'roster'` — writes the Labour Sheet, not this hub)

`doPost` accepts `{source:'brighthr_roster', kind:'roster', token, rows:[{email, name, date:'YYYY-MM-DD', start:'HH:MM', end:'HH:MM', hours, location}]}` (ADR-010). It never touches `Suppliers`/`Sales`/`Revenue`; it opens only `LABOUR_CLOCK_SHEET_ID` and writes its `CLOCK_RAW` tab in the existing `LABOUR_CLOCK_COLS` shape (`clock_in = date start`, `clock_out` next day if `end < start`, `break_minutes = max(0, span − hours×60)`, blank `rate`, `record_id = roster:<email>|<date>|<start>`).

- Rules: 1–1000 rows (`roster_empty` / `roster_too_large`); `email` lowercase with `@`; `start`/`end` `HH:MM` (24h, not equal); `0 < hours ≤ 16` (a JSON number); `location` non-empty; **no `department` key** (it comes from LOCATIONS at costing). An unknown `location` is accepted and becomes the `unknown_location` exception at costing.
- Date-level replace: the dates in the payload replace existing `roster:` rows on those dates; other dates and non-`roster:` rows are untouched. Limitation: a day emptied by a roster edit keeps its stale rows.
- Response: `{result:'ok', rowsAdded, rowsReplaced, rowsReplacedByDate:{date:n}, dates:[...]}`; refusals carry `code` (`UNAUTHORIZED`, `clock_sheet_unset`, `clock_raw_missing`, `LOCKED`). `CLOCK_RAW` therefore holds roster rows, not Blip clock-outs.

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

## Tab `Roasting` (Cropster green-in / roasted-out kg per profile per week — kg only)

Written by `doPost` `{source:'cropster', kind:'roasting', token, rows, allow_shrink?}` (PRD-23, `cropster.gs`). **No `department` column and no dollars** — the `cropster` source is bound to `null` in `INGEST_SOURCE_DEPARTMENTS_`, so a `department` on a row is rejected.

| Column | Notes |
|---|---|
| `week_start` | Sydney Monday `YYYY-MM-DD` |
| `profile` | roast profile name (non-empty, ≤200 chars) |
| `green_kg_in` | kg, number in [0, 100000] |
| `roasted_kg_out` | kg, number in [0, 100000] |
| `weight_loss_pct` | number in [0, 100] or blank (null) |
| `batch_count` | integer ≥ 0 |
| `pulled_at` | server-stamped (`ingestServerStamp_()`); a client value is refused |

Each posted row is exactly `{date, week_start, profile, green_kg_in, roasted_kg_out, weight_loss_pct, batch_count}` with `date === week_start`; any other field is refused. A payload is refused whole (never truncated) for: >500 rows, >13 distinct weeks, a duplicate `week_start||profile`, a week after the current Sydney week or more than 16 weeks before it, or a non-boolean `allow_shrink`.

**Key `week_start||profile`; week-scoped replace.** A post replaces *every* row of each week it carries (a renamed profile leaves no orphan); weeks not in the post are untouched. The new tab body is built in memory and written in one `setValues`, then trailing blank rows are trimmed best-effort.

**Shrink guard.** If a week's new Σ `roasted_kg_out` is below 50% of the stored Σ, the whole payload is refused (nothing written) naming the week(s), unless `allow_shrink:true`.

## Tab `ShopCoffee` (coffee kg per shop per week — kg only, no dollars)

Written by `shopCoffeePull` (`connectors/gas/shopcoffee.gs`) from the Order app's
`shopCoffeeLines` endpoint; read via `doGet fn=shopCoffee` (`docs/api.md`).
Outside the two-tab ingest contract. Upsert key: `week_start||shop`, whole-row
rewrite on every pull so a repull self-heals.

Columns: `week_start`, `week_end`, `iso_week`, `shop`, `bar_kg`, `retail_kg`,
`unclassified_kg`, `excluded_lines`, `line_count`, `pulled_at`.

Shops reported: York, Pitt, Crowsnest, North (Leible Taiwan and external shops are not reported).

Bar rule (widened 2026-10-22): **bar** = Single Origin 1kg (`-1K`) + House Blend
tins (`-8K`) + House Blend partial tins (`-PT`, qty already kg) + Decaf 1kg +
Cold Brew 1kg. **retail** = every other coffee-bean line (House Blend 1K/200g,
Single Origin 200g, Decaf/Cold Brew 200g, Reserve Single Origin any parseable
size, SO 8K). Categories Drip Bag, Tea, Packaging, Misc are **excluded** (kg 0,
counted in `excluded_lines`). **unclassified_kg** = a coffee line whose size
suffix is unparseable (incl. Reserve SO SKUs ending -02..-05), or whose category
is null/unknown — surfaced rather than guessed into bar or retail.
