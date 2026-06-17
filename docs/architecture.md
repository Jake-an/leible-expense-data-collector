# Architecture

## Overview

Two runtimes feeding one Google Sheet. GAS handles API-native and email sources plus all normalization/writes. Playwright handles browser-based portal logins locally and POSTs raw rows to a GAS web-app endpoint. The Sheet has two tabs: `Suppliers` (invoice-level) and `Sales` (Square daily gross). See `docs/schema.md`.

## Directory Structure
```
├── scripts/
│   ├── execute.py              # Harness step executor (runs phases)
│   ├── pre_push_sync.py        # Fetch+rebase teammate safety gate
│   └── test_execute.py         # Executor tests
├── connectors/
│   ├── gas/                    # Google Apps Script source (pushed via clasp)
│   │   ├── Code.gs             # doPost endpoint, normalization, dedup, ensureSheet
│   │   ├── square.gs           # Square API connector → Sales tab
│   │   ├── mayers.gs            # PDF-invoice parser (Drive OCR) → Suppliers tab
│   │   ├── test_code.js        # Node-mock unit tests (run locally, no clasp)
│   │   └── appsscript.json     # GAS manifest
│   └── playwright/             # Local browser automation
│       ├── base_connector.py   # Shared session/login/read/POST logic
│       ├── ordermentum.py      # Tuga Pastry + Butterboy (same app, two accounts)
│       ├── food_dairy_co.py    # Food and Dairy Co portal
│       ├── fresh_and_chill.py  # Fresh and Chill portal
│       └── kent_paper.py       # Kent Paper portal
├── phases/                     # Harness phase definitions (index.json + stepN.md)
├── docs/                       # Architecture, ADR, PRD, schema, rules, clickpath-*
├── config/                     # clasp.json (scriptId), gitignored secrets
└── sessions/                   # Saved Playwright browser sessions (gitignored)
```

Labour/payroll is **not** a connector here — it is owned by `LEIBLE_Payroll`. There is no `brighthr.py` in this repo; the collector links to Payroll's output (ADR-007).

## Two Runtimes

### Runtime A — Google Apps Script (cloud, always-on)
Runs on Google's servers via time-driven triggers or the `doPost` web-app endpoint.

**Handles:**
- **Square** — `UrlFetchApp` + API key → daily **gross** sales per location → `Sales` tab. The API wrapper (`callSquareAPI`/`searchOrders`/`listLocations`) is **reused from `LEIBLE_GM_COST_MONITOR/SquareAPI.gs`** (ADR-001).
- **Mayers** — `GmailApp` + Drive OCR → extract PDF-attachment invoice text → `Suppliers` tab
- **Normalization** — raw rows from any source → two-tab schema (see `docs/schema.md`)
- **Sheet writes** — append normalized rows; dedup before insert
- **doPost ingest** — web-app endpoint that receives raw supplier rows from Playwright connectors

**Cannot do:** log into third-party portals (no browser on Google's servers).

### Runtime B — Python + Playwright (local machine)
Runs on Jake's machine, triggered manually or by the harness.

**Handles:**
- **Portal logins** — Food & Dairy Co, Fresh & Chill, Kent Paper, Ordermentum (Tuga + Butterboy)
- **Session persistence** — saves browser cookies/storage to `sessions/` after attended login; reuses for unattended runs
- **Data extraction** — reads the on-screen invoice/order list table
- **POST to GAS** — sends raw invoice rows to the GAS `doPost` endpoint for normalization + `Suppliers` write

**Cannot do:** run 24/7 unattended unless the machine is awake (future: move to an always-on box).

## Data Flow
```
Portal sources (4 supplier connectors)
    ↓ Playwright logs in (saved session), reads invoice list
    ↓ HTTP POST (JSON, invoice-level rows)
    ↓
GAS doPost ──→ normalizeSupplierRow() ──→ dedup ──→ append to `Suppliers`
    ↑
    ├── Square: UrlFetchApp → /orders/search → sum gross/location/day → `Sales`
    └── Mayers: GmailApp → PDF attachment → Drive OCR → parseMayersInvoice_() → `Suppliers`
```

## Session Lifecycle (portal auth)

1. **First run (attended):** real browser window opens, Jake logs in + passes any Cloudflare/MFA challenge
2. **Save:** Playwright writes session state (cookies, localStorage) to `sessions/<connector>.json`
3. **Repeat runs (unattended):** Playwright loads the saved session, skips login, reads the invoice list
4. **Expiry:** session expires → connector can't get in → marks itself `blocked` → Jake re-auths

## POST Bridge Contract

Playwright connectors POST to the GAS web-app URL with this shape (invoice-level):
```json
{
  "source": "food_dairy_co",
  "rows": [
    {"date": "2026-06-15", "total": 245.50, "invoice_ref": "INV-10293", "location": "York St"}
  ],
  "extracted_at": "2026-06-17T09:30:00+10:00"
}
```
`location` is optional. GAS resolves the canonical `supplier` from `source`, normalizes each row to the `Suppliers` schema, and appends. Duplicates are detected by the **`source + invoice_ref`** composite key and silently skipped.

## State Management
- **Sheet** is the single source of truth (`Suppliers` + `Sales` tabs; `_staging` for test ingestion)
- **`phases/` JSON files** track harness execution state (pending/completed/error/blocked)
- **`sessions/`** holds browser auth state (gitignored — contains cookies)
