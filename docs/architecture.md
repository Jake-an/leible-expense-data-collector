Generated: 2026-07-24 by /cartography

# Architecture

## Entry Points

| Path | Type | Purpose |
|---|---|---|
| `connectors/gas/Code.gs` → `doPost(e)` | GAS web-app HTTP POST | The single ingest endpoint. Receives raw supplier rows from Playwright connectors, runs `validateIngest_` → `normalizeSupplierRow` → dedup → appends to the `Suppliers` tab. Every non-Square/Mayers write flows through here. |
| `connectors/gas/Code.gs` → `doGet(e)` | GAS web-app HTTP GET | Read/summary endpoint for downstream consumers (see `docs/api.md`). |
| `connectors/gas/square.gs` → `squareDailyPull(dateStr)` | GAS function (time-trigger / manual) | Pulls one day's gross sales per Square location → `Sales` tab. |
| `connectors/gas/mayers.gs` | GAS function (Gmail-triggered) | Parses Mayers PDF-invoice email attachments via Drive OCR → `Suppliers` tab. |
| `connectors/gas/staleness.gs` | GAS watchdog | Heartbeat + staleness alerting when a source stops reporting. |
| `connectors/playwright/<name>.py` | Python CLI (`--attended` opt) | Per-portal login → download raw invoice rows → POST to `doPost`. One file per source (ordermentum, food_dairy_co, fresh_and_chill, kent_paper). |
| `scripts/execute.py <phase-dir>` | Python CLI | Harness step executor; runs a phase's steps sequentially with TDD red→green enforcement. |
| `scripts/pre_push_sync.py` | Python CLI | "lets stop here" teammate-safe gate: fetch + rebase-if-behind, then exits (does **not** push). |
| `scripts/deploy.sh` | Bash | Deploy GAS after coding is done: `clasp push` + redeploy the one deployment id. |

## Dependency Sketch

```
                          LOCAL MACHINE                         GOOGLE CLOUD
   ┌───────────────────────────────────────────┐   ┌──────────────────────────────────┐
   │  connectors/playwright/                    │   │  connectors/gas/                 │
   │  ┌─────────────────────────────────────┐   │   │  ┌────────────────────────────┐  │
   │  │ base_connector.py (session/login/   │   │   │  │ Code.gs                    │  │
   │  │   read/POST bridge)                 │   │   │  │  doPost ─ validateIngest_ ─┼──┼─┐
   │  │   ├── ordermentum.py (Tuga+Butterboy)│──┼───┼──┼─▶ normalizeSupplierRow ─    │  │ │
   │  │   ├── food_dairy_co.py              │   │   │  │   dedup(source+invoice_ref)│  │ │
   │  │   ├── fresh_and_chill.py            │   │   │  │  doGet  (read/summary API) │  │ │
   │  │   └── kent_paper.py                 │   │   │  └────────────────────────────┘  │ │
   │  └─────────────────────────────────────┘   │   │  ┌────────────┐ ┌─────────────┐  │ │
   │  scripts/ (execute.py, pre_push_sync.py)   │   │  │ square.gs  │ │ mayers.gs   │  │ │
   │  phases/  (index.json + stepN.md)          │   │  │ Square API │ │ Gmail+OCR   │  │ │
   │  config/  (clasp.json, deployment.json)    │   │  └─────┬──────┘ └──────┬──────┘  │ │
   │  sessions/ (saved browser auth, gitignored)│   │        │               │         │ │
   └───────────────────────────────────────────┘   │        ▼               ▼         │ │
                                                    │   ┌─────────────────────────┐   │ │
   HTTP POST (raw invoice rows) ───────────────────────▶│  Google Sheet           │◀──┼─┘
                                                    │   │  ├── Suppliers (invoice) │   │
                                                    │   │  └── Sales (Square daily)│   │
                                                    │   └─────────────────────────┘   │
                                                    └──────────────────────────────────┘

   Boundary rule: Playwright ONLY logs in + downloads + POSTs. GAS owns every Sheet
   write, Square pull, Mayers parse, and all normalization. No connector writes the
   Sheet directly; nothing appends outside doPost → validateIngest_.
```

## Domain Glossary

| Term | Definition |
|---|---|
| **Two-tab schema** | The contract: `Suppliers` (invoice-level) + `Sales` (Square daily gross). All data lands in one of these two tabs. See `docs/schema.md`. |
| **Suppliers tab** | Invoice-level rows; dedup key = `source` + `invoice_ref`. |
| **Sales tab** | Square daily gross per location; dedup key = `date` + `location`. |
| **doPost ingest** | The one GAS web-app endpoint (`/exec`) all connector data flows through. |
| **validateIngest_** | GAS guard that validates a POST payload before normalization/write. |
| **normalizeSupplierRow** | GAS function turning raw connector rows into the `Suppliers` schema and resolving the canonical supplier name. |
| **Dedup keys** | Composite keys (per tab) that make re-ingest idempotent — duplicates are silently skipped. |
| **Connector** | A GAS or Playwright module that pulls from one source; Playwright connectors must POST to `doPost` to get written. |
| **POST bridge contract** | The JSON shape Playwright sends to `doPost`: `{source, rows:[{date,total,invoice_ref,location?}], extracted_at}`. |
| **Normalization boundary** | Connectors emit **raw** rows; turning raw → schema is GAS's job, never the connector's. |
| **Two runtimes, one boundary** | GAS (cloud, always-on) vs Playwright (local, portal logins) — the architectural split. |
| **Harness phase/step** | Executable unit run by `scripts/execute.py`; a phase is a dir with `index.json` + `stepN.md`, run with TDD red→green. |
| **Session persistence** | Playwright saves browser cookies/storage to `sessions/<connector>.json` after an attended login and reuses it unattended. |
| **Ordermentum** | One login serving two supplier accounts (Tuga Pastry + Butterboy); the app differentiates by tradingName. |

## Gotchas & Anti-patterns

- **Two runtimes, one boundary (CRITICAL).** GAS owns all Sheet writes, Square pulls, Mayers PDF parses, and normalization. Playwright connectors **only** log in, download raw data, and POST. A connector that writes the Sheet or normalizes rows violates the contract.
- **All ingest through `doPost` → `validateIngest_` (CRITICAL).** Never append to a tab outside that path; the dedup keys (`source+invoice_ref`, `date+location`) are the contract.
- **Auto-login does NOT self-heal.** Ordermentum + Fresh & Chill reject stored `.env` creds on a dead session → breaker trips → BLOCKED. Unattended running relies on saved sessions staying alive; genuine expiry needs **attended** re-login. (Contradicts any "always-on" assumption.)
- **Backup daemon races harness runs.** A concurrent auto-backup can commit AND push mid-run, interleaving `backup:` commits and sweeping untracked files. Trust TDD evidence + fresh test runs over git-log order.
- **`pre_push_sync.py` only syncs — it does not push.** It fetches + rebases-if-behind then prints "Up to date" and exits. Run `git push` separately after; verify with `git rev-list --left-right --count`.
- **Sheet date coercion.** Sheet date cells come back as `Date` objects; coerce with local components (not `toISOString`) before comparing/emitting, or you get silent no-match + AEST off-by-one.
- **Git push ≠ deploy.** "lets stop here" = git push only. GAS deploy is a separate step (`bash scripts/deploy.sh`, the one deployment id) done when coding is finished — never `clasp create-script` again.
- **Never commit credentials, PII, or business data.** `.env`, `credentials/`, `downloads/`, `sessions/`, `*.csv|xlsx|pdf` are gitignored. Never bypass MFA/CAPTCHA — Jake passes those manually.

<!-- manual notes below -->

## Roastery department expansion (Phase 1, 2026-07-31)

Every tab (`Suppliers`, `Sales`, `Labour`, `_staging`, `_archive`, `Summary`) now
carries a `department` (`Cafe` | `Roastery`) column, appended last to keep
index-based dedup keys stable. A new `Revenue` tab (order-level, dedup
`source+order_ref`) holds non-Square revenue (wholesale orders, Shopify — later
phases). `doPost` routes on an explicit `kind` (`suppliers` default | `revenue`).
Ingest and `weeklySummarize` are now **upsert**, not append-with-skip — a changed
amount updates the existing row. `LockService` wraps every entry point
(`doPost`, `weeklySummarize`, `squareDailyPull`, `migrateAddDepartment_`) via a
single `withScriptLock_` helper. See `docs/schema.md`, `docs/api.md`, and
`docs/ADR.md` ADR-009 for full detail.

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

## Order-app GAS pulls (orderapp.gs, PRD-10/11 — 2026-08-06)

A fourth flow, GAS-native (no Python, no doPost hop): `connectors/gas/orderapp.gs`
pulls two token-gated read APIs of the LEIBLE_Order_app on Google time triggers
and writes through the hub's internal upsert helpers — the sanctioned exception
to the doPost boundary (same class as square.gs/mayers.gs/labour).

```
GAS trigger Mon 05:00 Sydney -> shopifyWeeklyPull()
  -> Order app ?api=shopifySales (last 4 completed ISO weeks, live snapshot)
  -> Summary rows direct via upsertRows_    (kind=revenue, supplier=shopify_orderapp,
                                             location=online, department=Roastery)
GAS trigger Tue 05:00 Sydney -> greenBeanPull()
  -> Order app ?api=greenBeanCost (rolling 3 months, status=ALL, offset paging + rowNumber dedup)
  -> line->invoice grouping -> Suppliers via ingestSupplierRows (source=greenbean)
  -> snapshot-diff affected-week weeklySummarize (cap 5/run + persisted overflow queue)
```

Failure detection is two complementary layers. Runs that START and die: a
fail-open counter (`ORDERAPP_FAILCOUNT_*`) — increment at run start, reset only
on full success, orange Calendar alert at 2 consecutive incomplete runs;
not-armed (token unset) resets without heartbeat. Runs that never start (trigger
deleted/disabled/never installed — the counter can't see those): the staleness
watchdog watches both sources' heartbeats at a 168h per-source threshold
(`STALENESS_THRESHOLD_OVERRIDES`, staleness.gs), catching a missed weekly run at
the first daily 11:00 check after it. The retired direct puller `shopify.gs` was
deleted in the same phase (never activated).

## shopSpend flow (separate silo)

A third data flow, independent of the `Suppliers`/`Sales`/`Revenue` two-tab
pipeline above: a Python runner + typed client pull an **external** internal
Apps Script JSON API (`shopSpend`, per-shop per-ISO-week order dollars) and
POST into three new tabs (`ShopSpend`, `ShopSpendPulls`, `ShopSpend Report`).
See `docs/schema.md` for the tab specs.

```
Windows Task Scheduler (Mon 05:00)
  -> connectors/shopspend/runner.py   (resolve env, find missing closed ISO weeks)
  -> connectors/shopspend/client.py   (typed; follow redirects; branch on body.ok, NEVER on
                                       HTTP status; retry only INTERNAL / non-JSON / transport)
  -> our GAS doPost  kind:'shopspend' (chunks of 200 rows, one shared fetched_at,
                                       ShopSpendPulls row LAST = commit marker)
       -> ShopSpend        (append-only snapshots, only when changed)
       -> ShopSpendPulls   (one row per pull + diagnostics)
            -> buildShopSpendReport() -> "ShopSpend Report"
  GAS trigger Mon 14:00 AEST: shopSpendWatchdog() — "did last week's pull land?"
```

**Non-obvious facts, easy to get wrong later:**

- The external `shopSpend` API is `gstTreatment: EXCLUSIVE_PRIMARY`; the sibling
  green-bean cost API is `INCLUSIVE`. Never chart one against the other without
  asserting on `meta.gstTreatment`. `gst: 0` on a shop is normal — many coffee
  SKUs are GST-free.
- The API's main failure mode is **under-reporting real money**. Totals are a
  floor, not a truth: when `unpricedSkus` is non-empty those line items were
  skipped entirely.
- Scope is confirmed orders only (`Receipt Confirmed` + `Amendment Requested`),
  excluding Shopify/online shops. `amendedCount > 0` means those dollars are
  still provisional.
