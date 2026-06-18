# Ordermentum Click-Path & API Map

Discovered 2026-06-18 via attended login + chrome-devtools network capture.

## Auth

- Login URL: `https://app.ordermentum.com` (redirects to `/dashboard` on success)
- Auth: Bearer JWT in `authorization` header, sourced from the `session` cookie
- JWT lifespan: ~15 days (`exp - iat ≈ 1,296,000s`)
- `refresh_token` cookie also present — may extend session silently
- Post-login landmark: `GET /v1/profiles/` returns 200 when session is valid

## API Endpoints (all Bearer JWT, same-origin)

### 1. List suppliers for a venue

```
GET /v2/marketplaces?retailerId={venue_id}&disabled=false
```

Returns `{ meta, data: [{ supplierId, supplier: { name }, retailerId, retailer: { tradingName } }] }`

### 2. List invoices for a supplier+venue

```
GET /v2/invoices?supplierId={supplier_id}&retailerId={venue_id}&sortBy[dueAt]=-1
```

Returns `{ meta: { totalResults, totalPages, pageSize, pageNo }, links: { next }, data: [...] }`

Paginated (25/page). Each invoice object:

| Field | Example | Use |
|---|---|---|
| `number` | `"OMI356886"` | → `invoice_ref` |
| `date` | `"2026-06-17T14:00:00.000Z"` | → `date` (YYYY-MM-DD) |
| `total` | `82.81` | → `total` (GST-inclusive) |
| `totalGST` | `7.41` | available if needed |
| `supplierName` | `"Tuga Pastries Australia Pty Ltd"` | → `supplier` |
| `retailerName` | `"Leible coffee York street"` | → `location` via venue map |
| `cancelled` | `false` | filter out if `true` |
| `status` | `"Paid"` / `"Unpaid"` | not captured per plan |

### 3. Session check

```
GET /v1/profiles/
```

Returns 200 with user profile if JWT is valid. Use for `is_logged_in()`.

## Active Venues (Jake-confirmed 2026-06-18)

| Venue ID | Ordermentum tradingName | Canonical location |
|---|---|---|
| `73cb4dc6-bc70-431c-bfad-186f05e8851b` | Leible coffee York street | Leible York |
| `c2942ee1-acb5-45a1-b8df-72c5e5f03aa3` | Leible coffee Pitt St. | Leible Pitt |
| `73904d83-094a-4764-9da9-cfa61231001c` | Leible coffee Roastery | Leible Crowsnest |
| `5dc2803b-51e2-4415-8484-edb4cdf40517` | Leible coffee blue street - North Sydney | Leible North |

Inactive (skip): Crows Nest (Old), North Sydney Blue, "Leible coffee" (0 suppliers).

## Connector Flow (no DOM scraping)

1. Load saved `sessions/ordermentum.json` (Playwright storage_state with cookies)
2. Extract `session` cookie → Bearer JWT
3. Hit `GET /v1/profiles/` to verify session; if 401 → `BlockedError`
4. For each active venue:
   a. `GET /v2/marketplaces?retailerId={venue}&disabled=false` → supplier list
   b. For each supplier:
      `GET /v2/invoices?supplierId={sid}&retailerId={venue}&sortBy[dueAt]=-1&pageNo=1`
      (page 1 only for go-forward; dedup handles overlaps)
   c. Filter out `cancelled: true`
   d. Map to `{ date, total, invoice_ref, supplier, location }`
5. POST all rows to GAS `doPost`

## Session Longevity

JWT expires ~15 days after creation. For a daily/weekly schedule, expect re-auth
roughly every 2 weeks. The `refresh_token` cookie may extend this — test by
running unattended after 1+ weeks. The connector logs `BLOCKED` and exits 2 when
the session expires, prompting Jake to re-run `--attended`.
