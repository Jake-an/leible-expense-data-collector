# Food and Dairy Co (FDCo) Click-Path & API Map

Discovered 2026-06-18 via attended login + chrome-devtools network capture.

FDCo's "native app" is a **white-labeled Pepper** app (usepepper.com). Its web
twin is **https://fooddairyco.pepr.app** — same account as the phone app. One
login covers all 4 Leible venues. API-first, no DOM scraping (mirrors Ordermentum).

> FDCo is **not** reachable via Jake's Ordermentum login (verified 2026-06-18 —
> absent from `/v2/marketplaces` across all venues). Pepper is its own route.

## Auth (AWS Cognito → Hasura)

- Login URL: `https://fooddairyco.pepr.app/` — **passwordless**: phone (SMS OTP) or
  email tab. Jake clears the OTP in the attended window (never automated).
- Tokens are stored by amazon-cognito-identity-js in **localStorage** (not cookies),
  keyed `CognitoIdentityServiceProvider.<clientId>.<user>.{idToken,accessToken,refreshToken}`.
  - Cognito client id: `58nt1t1batqs52tb8l7k3ipktr`
  - `idToken` (sent as `Authorization: Bearer`) is a Cognito JWT with Hasura claims
    (`x-hasura-default-role: restaurant-app`); **lifespan ~1 hour** (`exp-iat=3599s`).
  - `refreshToken` (~30-day Cognito default) → unattended re-auth. The connector
    obtains a fresh IdToken via: reuse-if-valid → direct Cognito
    `REFRESH_TOKEN_AUTH` (public client, no secret) → fall back to app auto-refresh.
- Playwright `storage_state` persists localStorage per origin, so the saved session
  carries the refresh token. After ~30 days idle it expires → connector `blocks`.

## Pepper GraphQL API

- Endpoint: `POST https://api-aus.usepepper.com/v1/graphql` (Hasura)
- Required headers (besides `authorization`):
  - `x-pepper-container-app: JALAPENO`
  - `x-pepper-app-platform: web`
  - `x-pepper-business-id: <supplier_id>`  (FDCo = `a5f819ac-970f-4b76-926d-4299cdaf1777`)
  - `x-pepper-business-organization-id: 860d911c-98d0-47be-8b2f-efc694a551e2`
  - `x-pepper-accept-language: en-US`

### 1. Discover venues + supplier (bootstrap)

`UserContext_Employee` → `employee_chats[]` gives, per venue:
`restaurant_uuid`, `restaurant_name`, `chat_uuid`, `supplier_uuid`, `status`.
Use to refresh the VENUES map if shops change. Captured 2026-06-18 (all ACTIVE):

| Pepper restaurant_name | restaurant_uuid | chat_uuid | Canonical shop |
|---|---|---|---|
| LEIBLE COFFEE NORTH SYDNEY BLUE | `18f98318-033e-46eb-bdbe-bb8496c7ca48` | `44433267-e298-4790-a3e5-f8ffd617987e` | Leible North |
| LEIBLE COFFEE PITT | `9e2232d5-c159-46b3-8ad0-759b7c00cea8` | `5034df16-32c3-4349-8e9b-ff78228b91e0` | Leible Pitt |
| LEIBLE COFFEE ROASTERS CROWS NEST | `f6181415-b32a-473e-a968-8a75e09f96d0` | `6410be40-68e0-48e2-aeca-3a0e1c65cc9b` | Leible Crowsnest |
| LEIBLE COFFEE YORK STREET | `c0bca7d8-fe22-496d-8de0-eb685433beb3` | `54e6f884-740f-4e68-963d-3d32b8513360` | Leible York |

### 2. App/Web invoices — `OrderHistory_SearchOrders`

```
searchOrderHistory(filters:[{operation:EQUALS,type:SCOPE,value:"PAST"}],
                   page_size, restaurant_id, supplier_id) {
  orders { order { status restaurant_desired_delivery_time
    order_invoices(limit:1,order_by:{created_at:desc}) {
      invoice_number
      order_invoice_line_items { ship_quantity unit_price_in_micros }
    } } } }
```

- Filter `SCOPE: PAST` = delivered/invoiced; `UPCOMING` = order sent, **no invoice yet** (skip).
- Skip any order with no `invoice_number`.
- `date` ← `restaurant_desired_delivery_time` (UTC, e.g. `…T14:00:00+00:00`) → **convert to Australia/Sydney** then take the date (UTC 06-12 → Sydney 06-13, matching the app).

### 3. "Other" ingested invoices — `OrderHistory_Invoices`

Phone/manual invoices ingested into Pepper, **not linked to an app order**
(disjoint from §2 — no double-count):

```
order_invoices(limit, order_by:[{invoice_date:desc}],
  where:{invoice_source:{_eq:"INGESTION"}, chat_uuid:{_eq:$chat},
         supplier_uuid:{_eq:$supplier}, order_uuid:{_eq:null},
         _not:{order_invoices_orders:{}}}) {
  invoice_date invoice_number
  order_invoice_line_items { ship_quantity unit_price_in_micros } }
```

- `date` ← `invoice_date` (also UTC → Sydney).

### Invoice total

```
total = Σ(ship_quantity × unit_price_in_micros) / 1e6     (round 2dp)
```

`unit_price_in_micros` is **GST-inclusive** — matches the app's displayed total
exactly (verified vs INV01046958=417.50, INV01045055=460.37, etc.). **Do NOT add
`unit_tax_in_micros`** — that over-counts by ~0.5–0.7.

## Field map → Suppliers row

| Pepper | Suppliers row |
|---|---|
| `invoice_number` | `invoice_ref` |
| delivery/invoice timestamp → Sydney date | `date` |
| Σ(qty × unit_price)/1e6 | `total` (GST-inc) |
| (constant) | `supplier` = "Food and Dairy Co" |
| restaurant → canonical | `location` |

## Connector flow (no DOM scraping)

1. Load `sessions/food_dairy_co.json` (storage_state with Cognito tokens in localStorage).
2. `page.goto(LOGIN_URL)` → obtain a fresh IdToken (valid / refresh / app-refresh).
3. For each venue: query §2 (App/Web PAST) + §3 (ingested) → union rows.
4. Skip non-invoiced; map to `{date,total,invoice_ref,supplier,location}`.
5. POST all rows to GAS `doPost` (GAS dedups on `invoice_ref` → go-forward, idempotent).

## Volume seen 2026-06-18 (validation)

App/Web PAST: North 34, Pitt 9, Crows Nest 24, York 20 (= 87). Plus "Other"
ingested (e.g. North +52, older/pre-app). All totals matched the app UI.

## Session longevity

IdToken ~1h (auto-refreshed). Refresh token ~30 days → expect re-auth roughly
monthly. On expiry the connector logs `BLOCKED` / exits 2 → re-run `--attended`.
