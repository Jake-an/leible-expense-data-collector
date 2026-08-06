# PRD: LEIBLE Expense Data Collector

## Goal
Centralize expense and sales data from all LEIBLE suppliers + POS into one Google Sheet with a lean two-tab schema (`Suppliers` invoice-level + `Sales` Square daily), replacing manual downloads and email-hunting.

## Users
Jake (LEIBLE owner/operator) and any colleague with Sheet access.

## Core Features

Every feature carries a stable `PRD-N` ID. **IDs are permanent — never renumber, never reuse.**
Harness steps declare which IDs they implement via `steps[].covers` in
`phases/{task-name}/index.json`.

| ID | Feature | Status |
|----|---------|--------|
| PRD-1 | Square sales pull — daily sales data via API into the Sheet | built |
| PRD-2 | Supplier portal connectors — automated login + data extraction from Food & Dairy Co, Fresh & Chill, Kent Paper, Ordermentum (Tuga Pastry + Butterboy) | planned |
| PRD-3 | Email invoice parsing — Myers chocolate invoices parsed from Gmail | built |
| PRD-4 | Normalization — supplier sources → `Suppliers` (invoice-level: date, supplier, total, invoice_ref, location); Square → `Sales` (daily gross per location) | built |
| PRD-5 | doPost ingest endpoint — GAS web-app that receives invoice rows from local connectors and writes to the Sheet | built |
| PRD-6 | Labour link — reference `LEIBLE_Payroll`'s labour-cost output (owned there, not recomputed here — see ADR-007) | planned |
| PRD-7 | shopSpend ingest + snapshot store — typed Python client for the external `shopSpend` JSON API (per-shop, per-ISO-week order dollars), POSTing via `doPost` into append-only `ShopSpend` + `ShopSpendPulls` tabs, snapshotted so history stays reproducible | built |
| PRD-8 | shopSpend reporting + data-quality surfacing — `ShopSpend Report` tab (per-shop weekly spend over time) with mandatory banners for `warnings[]`, `unpricedSkus`, `amendedCount`, `possibleDuplicateShopNames`, absent shop-weeks and `emptyRangeWithInvalidLabels` | built |
| PRD-9 | weeks_verified_empty ingest is token-gated — a `doPost` payload carrying `weeks_verified_empty` (the breaker-bypass field) must present the shared `API_READ_TOKEN`; the shopSpend poster sends it from `GAS_READ_TOKEN` and degrades non-destructively (drops the field, warns, keeps pulling) when the token is unresolvable or rejected. Writes cannot bypass the blast-radius breaker anonymously | built |
| PRD-10 | Shopify online weekly revenue via Order-app read API — GAS time-triggered pull of the Order app's `?api=shopifySales` endpoint (last 4 completed ISO weeks re-pulled each run; the endpoint is a live snapshot, so settling orders self-correct via Summary upsert), writing Summary rows directly (`kind=revenue`, `supplier=shopify_orderapp`, `location=online`, `department=Roastery`) with fail-open consecutive-failure alerting. **Exclusive channel** for Shopify online revenue — no connector may POST online Shopify revenue rows. Supersedes the never-activated direct puller `connectors/gas/shopify.gs` (deleted; its Script Properties were never set) | planned |
| PRD-11 | Green bean committed spend via Order-app read API — GAS time-triggered pull of the Order app's `?api=greenBeanCost` endpoint (`status=ALL`, rolling 3-calendar-month window, offset paging), aggregating line-grain stock-intake rows to invoice grain (`invoice_ref = supplierKey/invoiceNum`) into the `Suppliers` tab (`source=greenbean`, `department=Roastery`), with snapshot-diff affected-week re-summarize (persisted overflow queue) and fail-open consecutive-failure alerting. **Exclusive channel** for stock-intake invoices — the reserved `coffee_order_app` bean-invoice ingest path is mechanically rejected | planned |

`Status`: `planned` → `built` (flip it when the covering phase completes) → or `dropped`.

## Out of MVP Scope
- Dashboard / reporting UI (the Sheet itself is the view for now)
- Automated payment reconciliation
- Multi-user auth or role-based access beyond Sheet sharing
- Mobile app or notification system beyond Telegram
- Inventory tracking or stock management
- Line-item / GST / category breakdown of supplier invoices (invoice totals only — ADR-003a)
- Reimplementing labour/payroll cost (owned by `LEIBLE_Payroll` — ADR-007)
