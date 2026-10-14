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
| PRD-9 | Ingest is token-gated per source — EVERY `doPost` payload must present that `source`'s own `INGEST_TOKEN_<SOURCE>` secret, resolved through the `INGEST_SOURCES_` code allowlist and fail-closed on unknown source / unset property / missing / wrong token. No shared token, no fallback to the `doGet` read secret, no degraded mode. Nobody can write anonymously, and no token holder can claim another connector's `source` and overwrite its rows in place | built |
| PRD-10 | Shopify online weekly revenue via Order-app read API — GAS time-triggered pull of the Order app's `?api=shopifySales` endpoint (last 4 completed ISO weeks re-pulled each run; the endpoint is a live snapshot, so settling orders self-correct via Summary upsert), writing Summary rows directly (`kind=revenue`, `supplier=shopify_orderapp`, `location=online`, `department=Roastery`) with fail-open consecutive-failure alerting. **Exclusive channel** for Shopify online revenue — no connector may POST online Shopify revenue rows. Supersedes the never-activated direct puller `connectors/gas/shopify.gs` (deleted; its Script Properties were never set) | built |
| PRD-11 | Green bean committed spend via Order-app read API — GAS time-triggered pull of the Order app's `?api=greenBeanCost` endpoint (`status=ALL`, rolling 3-calendar-month window, offset paging), aggregating line-grain stock-intake rows to invoice grain (`invoice_ref = supplierKey/invoiceNum`) into the `Suppliers` tab (`source=greenbean`, `department=Roastery`), with snapshot-diff affected-week re-summarize (persisted overflow queue) and fail-open consecutive-failure alerting. **Exclusive channel** for stock-intake invoices — the reserved `coffee_order_app` bean-invoice ingest path is mechanically rejected | built |

| PRD-12 | Summary self-heal window — the scheduled `weeklySummarize` re-computes the last N completed weeks (Script Property `SUMMARY_HEAL_WEEKS`, default 4, armed by `SUMMARY_HEAL_ENABLED`) instead of only the last one, so a late-arriving invoice corrects its week's `Summary` total instead of becoming permanent understatement. Every write routes through one guarded per-week path shared by the scheduled and override branches: snapshot-once backup to `Summary_heal_backup`, SPLIT refusal (any `_archive` row for that week), duplicate-live-key refusal, and orphan detection. Weeks past the 183-day purge line are deliberately out of scope | planned |
| PRD-13 | Summary drift guard — zero-arg `checkSummaryDrift()` on its own weekly trigger runs the read-only `auditSummaryDrift_` windowed to the 183-day purge line and raises a Google Calendar alert when a week inside that horizon disagrees with its sources. Separate trigger from `weeklySummarize` on purpose: a guard running inside the thing it watches cannot report that the thing never ran | planned |
| PRD-14 | Roastery wholesale revenue via Order-app read API — GAS time-triggered weekly pull of the Order app's `?api=wholesaleSales` endpoint (last `WHOLESALE_REPULL_WEEKS`=8 completed ISO weeks, one request per week, `orders[]` paged by `offset`) into the `Revenue` tab via `ingestRevenueRows` with `source='coffee_order_app'`, dedup key `source + order_ref`. The producer's four shop-classification buckets map 1:1 onto `channel`: `external`→`wholesale`, `internal`→`internal`, `ambiguous`→`ambiguous`, `unknown`→`unknown`, so only genuine external wholesale reaches the company headline downstream. `amount` is written GST-EXCLUSIVE as the producer emits it. A week is written only when all five `diagnostics.*Ok` are true, its per-channel totals cross-foot in integer cents against `summary[bucket].gross`, and it carries no `_archive` rows | built |

| PRD-15 | Labour clock-row normalisation — pure `labourRowsToShifts_` turns Zapier `CLOCK_RAW` rows (Blip clock-outs) into costable shifts: hours = Zapier hours or out − in − break, date = clock-in date in Australia/Sydney (string and Date cells), dedup on BrightHR record id (else `person|clock-in`, newest clock-out wins), RATES fallback when a row has no rate, and routing of unpaired / over-16h / negative / no-rate / unknown-location rows to an explicit exceptions list. Columns are read through one header-name map (`LABOUR_CLOCK_COLS`) so a Zap remap is a one-constant change. No Sheet/Properties/Url access | planned |
| PRD-16 | Labour award-penalty costing — pure `labourCostShift_` prices a shift as hours × rate × multiplier, multiplier chosen by priority public holiday > Sunday > Saturday > weekday and read from the Labour Sheet `CONFIG` tab keyed by the person's PINNED `PEOPLE` employment_type / level / rate_basis (casual-loaded vs unloaded). A missing multiplier is a thrown error, never 1.0; a person absent from `PEOPLE` is an exception, never a guess. `labourReadConfig_` validates tab headers and throws on drift. Researched values: `docs/labour-award-research.md` (Restaurant Industry Award MA000119; roastery not hard-coded) | planned |
| PRD-17 | Labour superannuation guarantee — super = gross × the SG rate in force on the SHIFT date, from a dated in-code table (11.5% from 2024-07-01, 12% from 2025-07-01); total = gross + super. Boundary-tested at 2025-07-01 | planned |
| PRD-18 | Labour week × location grouping — pure `labourGroup_` emits one row per ISO week × location: hours, base, penalty uplift, gross, super, total, department (`Cafe`/`Roastery` from `LOCATIONS`), shift count, exception count | planned |
| PRD-19 | Labour data-quality checks and alerts — pure check functions return alert objects (title + one line per item) for the existing alert path: zero clock rows in a week (stop), exceptions above 10% (refuse to write), a person's rate differing from the prior week, a location below 70% of its 4-week median (explicit `drop check UNCHECKED` when history is under 4 weeks), person missing from `PEOPLE`, an annual 1 July "re-verify award multipliers" alert (once per year), and an alert-only pay-guide cross-check that reports ambiguous level matches and never re-classifies anyone | planned |
| PRD-20 | NSW public-holiday table — `HOLIDAYS` seeded from the OFFICIAL nsw.gov.au 2026–27 list in `docs/labour-award-research.md` (including weekend-falling days such as Sat 25 Apr 2026 and Sat 26 Dec 2026 that Nager.Date omits), with an alert 60 days before the table runs out and an alert when a year has zero holidays | planned |

`Status`: `planned` → `built` (flip it when the covering phase completes) → or `dropped`.

## Out of MVP Scope
- Dashboard / reporting UI (the Sheet itself is the view for now)
- Automated payment reconciliation
- Multi-user auth or role-based access beyond Sheet sharing
- Mobile app or notification system beyond Telegram
- Inventory tracking or stock management
- Line-item / GST / category breakdown of supplier invoices (invoice totals only — ADR-003a)
- Reimplementing labour/payroll cost (owned by `LEIBLE_Payroll` — ADR-007)
