# TODO — LEIBLE Expense Data Collector

## Done — at a glance
- Project scaffolded (git, gitignore, CLAUDE.md, docs, harness framework)
- Scaffold revised to the two-tab schema (`Suppliers` + `Sales`); Order-app `.claude` hook suite + team-share `.gitignore` adopted
- Phase 0 GAS hub, Phase 1 Square pilot, Phase 2 Mayers built + Node-mock tested (code-complete; live deploy blocked on Jake's Step 0)
- Playwright base + 4 portal skeletons scaffolded (click-paths TODO, awaiting attended login)
- **Food and Dairy Co connector built + live-tested 2026-06-18** (Pepper web `fooddairyco.pepr.app`, Cognito+GraphQL; 326 invoices across 4 venues → GAS, dedup verified)

## Active

### Phase 0 — Foundation
- [ ] **(Jake)** Create the Google Sheet "LEIBLE Expense Hub" with `Suppliers` / `Sales` / `_staging` tabs + headers
- [ ] **(Jake)** Create the bound GAS project; share scriptId for `config/clasp.json`
- [ ] **(Jake)** Add Square tokens (`SQUARE_ACCESS_TOKEN_YORK/NORTH_SYDNEY/CROWSNEST/PITT`) to Script Properties
- [ ] `clasp push` the GAS hub; live-verify `doPost` → `Suppliers` (POST sample payload, confirm dedup)

### Phase 1 — Square pilot (GAS-native)
- [ ] Live-verify `squareDailyPull()` → one gross row per location in `Sales`; re-run → dedup skips
- [ ] Install daily ~3am trigger; confirm next-day auto-run

### Phase 2 — Mayers (PDF-invoice connector, GAS-native + Drive OCR)
- [ ] **(Jake)** Set up email forward: `jake@leiblecoffee.com.au` → `mio.jake+mayers@gmail.com` (normal forward, not "forward as attachment")
- [ ] Live-verify `mayersDailyPull()` — forward a real Mayers invoice, run from editor, confirm row in `Suppliers` + dedup on re-run
- [ ] If OCR text differs from fixture, tune `parseMayersInvoice_` regexes + update test fixture
- [ ] Install daily trigger (`installMayersTrigger()`)

### Phase 3 — Ordermentum (Tuga Pastry + Butterboy) — built; needs coverage fixes
- Connector + session + `docs/clickpath-ordermentum.md` exist (API-first).
- [ ] **NEXT SESSION — Butterboy:** active at Crowsnest but missing from the data. Root cause: Butterboy isn't returned by `GET /v2/marketplaces?disabled=false`, so that endpoint isn't a complete supplier list. Find the true supplier-discovery source (e.g. order history / `/v2/orders`) so the connector catches it.
- [ ] **Widen `SUPPLIER_FILTER`:** currently pulls only `tuga/alie/butterboy` (2 of ~11 active suppliers). Decide with Jake whether to capture ALL Ordermentum suppliers (PFD, Sonoma, Patricks, Brooklyn Boy Bagels, Wholesale Cookies, etc.) — they're all real expenses.

### Phase 4 — Food and Dairy Co — ✅ DONE (2026-06-18)
- Route resolved: **not** on Ordermentum; FDCo app is white-labeled **Pepper** → web twin `fooddairyco.pepr.app` (Cognito auth, `api-aus.usepepper.com/v1/graphql`).
- Built `connectors/playwright/food_dairy_co.py` (API-first, both App/Web + "Other" ingested invoices), `docs/clickpath-fdco.md`, `scripts/run_food_dairy_co.cmd`.
- Live-tested end-to-end: 326 invoices (North 86 / Pitt 96 / Crowsnest 65 / York 79) → GAS `rowsAdded:326`; re-run `duplicatesSkipped:326` (dedup OK).
- [ ] **(Jake)** Register `scripts/run_food_dairy_co.cmd` in Windows Task Scheduler (daily). Session ~30-day Cognito refresh; re-run `--attended` (phone OTP) when it `blocks`.

### Phase 5 — Fresh and Chill
- [ ] **(Jake)** Attended login + click-path map → `docs/clickpath-fresh_and_chill.md`
- [ ] Fill selectors in `fresh_and_chill.py`; test full flow

### Phase 6 — Kent Paper — ⏸️ DEFERRED (2026-06-18)
- Portal (`kentpaper.com.au/ecommerce`) does **not** expose full order history — only recent orders. Weak/incomplete source; skipped for now. Revisit only if a better data route (full history export, email invoices) turns up.
- [ ] **(Jake)** Attended login + click-path map → `docs/clickpath-kent_paper.md`
- [ ] Fill selectors in `kent_paper.py`; test full flow

### Phase 7 — Labour link (Payroll output)
- [ ] Document/reference `LEIBLE_Payroll`'s labour-cost output (date × location, gross+super+penalties, no tax). No recompute. Depends on Payroll reaching Gate 10.

## Future
- Move Playwright runners to an always-on box
- Telegram notifications when connectors go `blocked`
- Dashboard / reporting view on top of the Sheet
