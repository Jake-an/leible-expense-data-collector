# Fresh and Chill — Click-Path & Portal Map

Discovered 2026-06-22 via attended login + chrome-devtools snapshot on the York account.

Fresh & Chill uses **Zupply Chef** (`shop.zupply.com.au`), a Rails/Devise server-rendered
ordering portal. **One login per Leible shop** (4 separate accounts), unlike the single-login
model of Ordermentum/FDCo. No JSON API — pure HTML table scrape.

## Auth (Devise, plain user+password)

- Login URL: `https://shop.zupply.com.au/users/sign_in`
- Fields: email (textbox) + password (textbox) → "Log in" button.
- **No MFA, no CAPTCHA** — plain Devise. Sessions persist via Rails cookie.
- Password reset at `/users/password/new` (not used by the connector).
- After login, redirects to `/orders`.

### `is_logged_in` marker

Presence of the nav link `a[href='/orders']` (the ORDERS tab in the authenticated nav bar).
The logged-in nav also shows:
- Account name (e.g. "Leible Coffee - York St") as a link to `/`
- "Welcome, leibleys" dropdown button
- Links: HOME, PANTRY LIST, ORDERS, PAYMENTS, SETTINGS

### Session persistence

Playwright `storage_state` saves the Rails session cookie. Sessions are per-shop:
`sessions/fresh_and_chill_<key>.json` (york/north/crowsnest/pitt). No token refresh
needed — the cookie is valid until the server expires it.

## Orders page (`/orders`)

Direct URL: `https://shop.zupply.com.au/orders` — no navigation clicks needed.

### Tabs (filter by status)

- Draft: `/draft_orders`
- **All: `/orders`** ← we scrape this (default landing)
- Waiting for Delivery: `/orders?status=Waiting+for+Delivery`
- Delivered: `/orders?status=Delivered`
- Unpaid: `/orders?status=Unpaid`
- Recurring: `/orders?status=Recurring`
- **Credit Notes: `/invoices?status=credit`** ← separate page, NOT in orders table

### Table columns

| # | Header | CSS selector (within row) | Content format |
|---|---|---|---|
| 1 | Order | `td:nth-child(1)` | "Fresh and Chilled\nPO#00075105" — supplier name + PO ref |
| 2 | Order Date | `td:nth-child(2)` | "19/06/2026 13:48" (DD/MM/YYYY HH:MM) |
| 3 | Delivery Date | `td:nth-child(3)` | "22/06/2026\nWaiting for delivery" or "19/06/2026\nDelivered" |
| 4 | Total | `td:nth-child(4)` | "$143.26\nNot paid" or "$143.26\nPaid" |
| 5 | Service Fee | `td:nth-child(5)` | "$0.00" (always zero observed) |
| 6 | Total Charged | `td:nth-child(6)` | "$0.00" or "$170.22" (link to PDF download) |

### Extraction logic

- **`invoice_ref`**: regex `PO#(\d+)` from column 1 → keep as "PO#00075105" (globally unique).
- **`date`**: regex `(\d{2}/\d{2}/\d{4})` from column 3 (Delivery Date) → parse DD/MM/YYYY → YYYY-MM-DD.
- **`total`**: regex `\$([\d,]+\.\d{2})` from column 4 → strip `$` and commas → float.
- **`location`**: fixed per session (Leible York / North / Crowsnest / Pitt).
- Credit notes are on a separate page (`/invoices?status=credit`) — never appear in `/orders`.

### Pagination

- 25 orders per page.
- "Displaying orders 1 - 25 of 36 in total" shown below the table.
- Next page: `?page=2`, `?page=3`, etc. Detect via `a[href*='page=N+1']`.
- York has 36 orders total (2 pages as of 2026-06-22). Go-forward; recent page 1 is usually enough.

## Shop accounts (Zupply labels → canonical Leible names)

| Zupply account name | Shop key | Canonical location |
|---|---|---|
| Leible Coffee - York St | york | Leible York |
| (TBD on login) | north | Leible North |
| (TBD on login) | crowsnest | Leible Crowsnest |
| (TBD on login) | pitt | Leible Pitt |

## Network notes

- No XHR/fetch for order data — fully server-rendered HTML (Rails asset pipeline).
- Analytics only: New Relic (`bam.nr-data.net`), Branch.io, Google Maps.
- `client_id=127423` seen in a products request (Zupply internal shop ID for York).
- PDF invoice download available per order at `/orders/<id>/download_invoice_pdf`.
