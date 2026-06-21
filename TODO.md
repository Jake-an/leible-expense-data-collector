# TODO — LEIBLE Expense Data Collector

## Done — at a glance
- Project scaffolded (git, gitignore, CLAUDE.md, docs, harness framework)
- Scaffold revised to the two-tab schema (`Suppliers` + `Sales`); Order-app `.claude` hook suite + team-share `.gitignore` adopted
- **Phase 0 GAS hub LIVE** — Sheet, GAS project, doPost, dedup, deploy pipeline all operational (proven by FDCo + Ordermentum + Square data in production)
- Playwright base + 4 portal skeletons scaffolded
- **Food and Dairy Co connector built + live-tested 2026-06-18** (326 invoices, dedup verified)
- **Ordermentum connector live-tested 2026-06-18** — Butterboy fix verified (tradingName match), 114 rows (74 Tuga + 40 Butterboy); cleanup deployed to relabel "Wholesale Cookies PTY LTD" → "Butterboy" and delete out-of-filter suppliers
- **Fresh and Chill connector built + live-tested 2026-06-22** — Zupply web app (not WhatsApp); York 36 orders, dedup verified; 3 shops left to seed

## Active

### Phase 0 — Foundation — ✅ DONE
- [x] Sheet "LEIBLE Expense Hub" created with `Suppliers` / `Sales` / `_staging` tabs + headers
- [x] Bound GAS project created; scriptId + deploymentId in `config/`
- [x] `doPost` → `Suppliers` dedup proven (FDCo 326 rows, Ordermentum 114 rows, re-runs skip)
- [x] Square tokens in Script Properties; `squareDailyPull()` already ran (4 Sales rows for 2026-06-16)
- [ ] **(Jake)** Install daily triggers: run `installSquareTrigger()` + `installMayersTrigger()` from the editor

### Phase 1 — Square pilot (GAS-native) — ✅ LIVE (data present)
- [x] `squareDailyPull()` already ran — 4 Sales rows (York/North/Crowsnest/Pitt) for 2026-06-16 in Sheet
- [ ] **(Jake)** Install daily trigger: run `installSquareTrigger()` from the editor (3am AEST); confirm next-day auto-run

### Phase 2 — Mayers (PDF-invoice connector, GAS-native + Drive OCR)
- [ ] **(Jake)** Set up email forward: `jake@leiblecoffee.com.au` → `mio.jake+mayers@gmail.com` (normal forward, not "forward as attachment")
- [ ] Live-verify `mayersDailyPull()` — forward a real Mayers invoice, run from editor, confirm row in `Suppliers` + dedup on re-run
- [ ] If OCR text differs from fixture, tune `parseMayersInvoice_` regexes + update test fixture
- [ ] Install daily trigger (`installMayersTrigger()`)

### Phase 3 — Ordermentum (Tuga Pastry + Butterboy) — ✅ LIVE (2026-06-18)
- Connector + session + `docs/clickpath-ordermentum.md` exist (API-first).
- [x] **Butterboy fixed (2026-06-18):** `tradingName` match + relabel. See clickpath "Supplier identity gotcha".
- [x] **Live POST verified (2026-06-18):** run 1 → `rowsAdded:1, duplicatesSkipped:113`; run 2 → `rowsAdded:0, duplicatesSkipped:114` (dedup idempotent).
- [ ] **(Jake)** Run `cleanupOrdermentumRows()` from the Apps Script editor — relabels "Wholesale Cookies PTY LTD" → "Butterboy", deletes out-of-filter suppliers (Sonoma, Brooklyn Boy, etc.). Then **delete the function** from Code.gs (one-shot).
- [ ] **(Jake)** Register `scripts/run_ordermentum.cmd` in Windows Task Scheduler (daily). Session ~15-day JWT refresh; re-run `--attended` when it `blocks`.
- [ ] **(decision deferred)** Widen `SUPPLIER_FILTER` to ALL Ordermentum suppliers? Kept narrow for now.

### Phase 4 — Food and Dairy Co — ✅ DONE (2026-06-18)
- Route resolved: **not** on Ordermentum; FDCo app is white-labeled **Pepper** → web twin `fooddairyco.pepr.app` (Cognito auth, `api-aus.usepepper.com/v1/graphql`).
- Built `connectors/playwright/food_dairy_co.py` (API-first, both App/Web + "Other" ingested invoices), `docs/clickpath-fdco.md`, `scripts/run_food_dairy_co.cmd`.
- Live-tested end-to-end: 326 invoices (North 86 / Pitt 96 / Crowsnest 65 / York 79) → GAS `rowsAdded:326`; re-run `duplicatesSkipped:326` (dedup OK).
- [ ] **(Jake)** Register `scripts/run_food_dairy_co.cmd` in Windows Task Scheduler (daily). Session ~30-day Cognito refresh; re-run `--attended` (phone OTP) when it `blocks`.

### Phase 5 — Fresh and Chill — ✅ LIVE (2026-06-22)
- Route resolved: **not** WhatsApp after all — F&C now has a web app **`shop.zupply.com.au`** (Zupply Chef, Rails/Devise, plain user+pass, no MFA). **One login per shop** (4 separate accounts).
- Built `connectors/playwright/fresh_and_chill.py` (DOM scrape of `/orders` table; per-shop session loop), `docs/clickpath-fresh_and_chill.md`.
- Delivery date + globally-unique `PO#` ref + GST-inc total from the orders list; credit notes on a separate page (excluded); pagination handled.
- **All 4 shops live 2026-06-22:** seeded (each has its own credentials) + full run → York 36 / North 35 / Crowsnest 23 / Pitt 35 = 129 orders; `rowsAdded:58, duplicatesSkipped:71` (York pre-loaded, dedup OK).
- [ ] **(Jake, later)** Add a `scripts/run_fresh_and_chill.cmd` + Task Scheduler entry if/when moving off manual runs.

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
