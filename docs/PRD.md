# PRD: LEIBLE Expense Data Collector

## Goal
Centralize expense and sales data from all LEIBLE suppliers + POS into one Google Sheet with a lean two-tab schema (`Suppliers` invoice-level + `Sales` Square daily), replacing manual downloads and email-hunting.

## Users
Jake (LEIBLE owner/operator) and any colleague with Sheet access.

## Core Features
1. **Square sales pull** — daily sales data via API into the Sheet
2. **Supplier portal connectors** — automated login + data extraction from Food & Dairy Co, Fresh & Chill, Kent Paper, Ordermentum (Tuga Pastry + Butterboy)
3. **Email invoice parsing** — Myers chocolate invoices parsed from Gmail
4. **Normalization** — supplier sources → `Suppliers` (invoice-level: date, supplier, total, invoice_ref, location); Square → `Sales` (daily gross per location)
5. **doPost ingest endpoint** — GAS web-app that receives invoice rows from local connectors and writes to the Sheet
6. **Labour link** — reference `LEIBLE_Payroll`'s labour-cost output (owned there, not recomputed here — see ADR-007)

## Out of MVP Scope
- Dashboard / reporting UI (the Sheet itself is the view for now)
- Automated payment reconciliation
- Multi-user auth or role-based access beyond Sheet sharing
- Mobile app or notification system beyond Telegram
- Inventory tracking or stock management
- Line-item / GST / category breakdown of supplier invoices (invoice totals only — ADR-003a)
- Reimplementing labour/payroll cost (owned by `LEIBLE_Payroll` — ADR-007)
