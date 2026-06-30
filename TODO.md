# TODO — LEIBLE Expense Data Collector

## Done — at a glance
- Project scaffolded (git, gitignore, CLAUDE.md, docs, harness framework)
- Scaffold revised to the two-tab schema (`Suppliers` + `Sales`); Order-app `.claude` hook suite + team-share `.gitignore` adopted
- **Phase 0 GAS hub LIVE** — Sheet, GAS project, doPost, dedup, deploy pipeline all operational (proven by FDCo + Ordermentum + Square data in production)
- Playwright base + 4 portal skeletons scaffolded
- **Food and Dairy Co connector built + live-tested 2026-06-18** (326 invoices, dedup verified)
- **Ordermentum connector live-tested 2026-06-18** — Butterboy fix verified (tradingName match), 114 rows (74 Tuga + 40 Butterboy); cleanup deployed to relabel "Wholesale Cookies PTY LTD" → "Butterboy" and delete out-of-filter suppliers
- **Fresh and Chill connector built + live-tested 2026-06-22** — Zupply web app (not WhatsApp); York 36 orders, dedup verified; 3 shops left to seed
- **Read API + weekly summary built 2026-06-22** — token-gated `doGet`, `weeklySummarize()` with 6-month archive/purge, 59 tests green

## Active

### Phase 0 — Foundation — ✅ DONE
- [x] Sheet "LEIBLE Expense Hub" created with `Suppliers` / `Sales` / `_staging` tabs + headers
- [x] Bound GAS project created; scriptId + deploymentId in `config/`
- [x] `doPost` → `Suppliers` dedup proven (FDCo 326 rows, Ordermentum 114 rows, re-runs skip)
- [x] Square tokens in Script Properties; `squareDailyPull()` already ran (4 Sales rows for 2026-06-16)
- [x] Square daily trigger installed (2026-06-30). Mayers trigger held — connector not live-verified yet (see Phase 2).

### Phase 1 — Square pilot (GAS-native) — ✅ LIVE (data present)
- [x] `squareDailyPull()` already ran — 4 Sales rows (York/North/Crowsnest/Pitt) for 2026-06-16 in Sheet
- [x] Daily `squareDailyPull` trigger installed 3am AEST (2026-06-30).

### Phase 2 — Mayers (PDF-invoice connector, GAS-native + Drive OCR)
- [x] Email forward set up from Outlook: `jake@leiblecoffee.com.au` → `mio.jake+mayers@gmail.com` (2026-06-30).
- [x] Live-verified on a real invoice — #3429816 (F.Mayer) delivered to `mio.jake+mayers@gmail.com` as a real `application/pdf` attachment, OCR-parsed and ingested (thread carries the success-gated `expense-ingested` label). Connector correctly ignores Outlook signature `image.png` attachments.
- [x] No OCR tuning needed — real-invoice parse succeeded.
- [ ] **(Jake)** Install daily trigger: run `installMayersTrigger()` from the editor (6am AEST). After the FIRST auto-forwarded invoice lands, sanity-check it parsed (Outlook rule format).

### Phase 3 — Ordermentum (Tuga Pastry + Butterboy) — ✅ LIVE (2026-06-18)
- Connector + session + `docs/clickpath-ordermentum.md` exist (API-first).
- [x] **Butterboy fixed (2026-06-18):** `tradingName` match + relabel. See clickpath "Supplier identity gotcha".
- [x] **Live POST verified (2026-06-18):** run 1 → `rowsAdded:1, duplicatesSkipped:113`; run 2 → `rowsAdded:0, duplicatesSkipped:114` (dedup idempotent).
- [ ] **(Jake)** Run `cleanupOrdermentumRows()` from the Apps Script editor — relabels "Wholesale Cookies PTY LTD" → "Butterboy", deletes out-of-filter suppliers (Sonoma, Brooklyn Boy, etc.). Then **delete the function** from Code.gs (one-shot).
- [x] Registered `scripts/run_ordermentum.cmd` as Win task "LEIBLE Expense - Ordermentum" — daily 03:20, LogonType=Interactive (runs while logged in). Session ~15-day JWT refresh; re-run `--attended` when it `blocks`.
- [ ] **(decision deferred)** Widen `SUPPLIER_FILTER` to ALL Ordermentum suppliers? Kept narrow for now.

### Phase 4 — Food and Dairy Co — ✅ DONE (2026-06-18)
- Route resolved: **not** on Ordermentum; FDCo app is white-labeled **Pepper** → web twin `fooddairyco.pepr.app` (Cognito auth, `api-aus.usepepper.com/v1/graphql`).
- Built `connectors/playwright/food_dairy_co.py` (API-first, both App/Web + "Other" ingested invoices), `docs/clickpath-fdco.md`, `scripts/run_food_dairy_co.cmd`.
- Live-tested end-to-end: 326 invoices (North 86 / Pitt 96 / Crowsnest 65 / York 79) → GAS `rowsAdded:326`; re-run `duplicatesSkipped:326` (dedup OK).
- [x] Registered `scripts/run_food_dairy_co.cmd` as Win task "LEIBLE Expense - Food and Dairy Co" — daily 03:00, LogonType=Interactive. Session ~30-day Cognito refresh; re-run `--attended` (phone OTP) when it `blocks`.

### Phase 5 — Fresh and Chill — ✅ LIVE (2026-06-22)
- Route resolved: **not** WhatsApp after all — F&C now has a web app **`shop.zupply.com.au`** (Zupply Chef, Rails/Devise, plain user+pass, no MFA). **One login per shop** (4 separate accounts).
- Built `connectors/playwright/fresh_and_chill.py` (DOM scrape of `/orders` table; per-shop session loop), `docs/clickpath-fresh_and_chill.md`.
- Delivery date + globally-unique `PO#` ref + GST-inc total from the orders list; credit notes on a separate page (excluded); pagination handled.
- **All 4 shops live 2026-06-22:** seeded (each has its own credentials) + full run → York 36 / North 35 / Crowsnest 23 / Pitt 35 = 129 orders; `rowsAdded:58, duplicatesSkipped:71` (York pre-loaded, dedup OK).
- [x] Added `scripts/run_fresh_and_chill.cmd` (loops all 4 shops) + registered Win task "LEIBLE Expense - Fresh and Chill" — daily 03:40, LogonType=Interactive (2026-06-30).

### Phase 6 — Kent Paper — ⏸️ DEFERRED (2026-06-18)
- Portal (`kentpaper.com.au/ecommerce`) does **not** expose full order history — only recent orders. Weak/incomplete source; skipped for now. Revisit only if a better data route (full history export, email invoices) turns up.
- [ ] **(Jake)** Attended login + click-path map → `docs/clickpath-kent_paper.md`
- [ ] Fill selectors in `kent_paper.py`; test full flow

### Phase 7 — Read API + Weekly Summary — ✅ BUILT (2026-06-22)
- Token-gated `doGet` serves weekly summaries (supplier + location + total_spend) from `Summary` tab.
- `weeklySummarize()` aggregates last Mon–Sun into `Summary`, archives raw rows > 6mo to `_archive`, purges originals.
- Default (no params) = last completed week; override with `?from=...&to=...`.
- 59 unit tests green (all existing + 40 new).
- [x] Code + tests written (`Code.gs`, `test_code.js`)
- [x] API docs written (`docs/api.md`)
- [ ] **(Jake)** Set `API_READ_TOKEN` in Script Properties (Apps Script editor → Project Settings → Script Properties)
- [ ] **(Jake)** Deploy: `bash scripts/deploy.sh` (clasp push + redeploy the ONE deployment)
- [ ] **(Jake)** Install weekly trigger: run `installWeeklySummarizeTrigger()` from the editor (Monday 4am AEST)
- [ ] **(Jake)** Run `weeklySummarize()` once manually from the editor to seed the first Summary rows, then confirm `doGet` returns them

### Phase 8 — Labour link (Onboarding app LABOUR_COST sheet)
- [x] `labourWeeklyPull_()` implemented in Code.gs — reads Onboarding app `LABOUR_COST`, writes `Labour` tab + `Summary` rows (`supplier='Labour'`), empty-safe
- [ ] **(Jake)** Set `LABOUR_SHEET_ID = 1SUg3rE5V46HQ7JtZzqus960KdLjxJd6AdcrYDq8zyGs` in Script Properties (Expense Collector editor)
- [ ] **(Jake)** Deploy: `bash scripts/deploy.sh`
- [ ] **(Jake)** Run `setupSheets()` to materialise the `Labour` tab
- [ ] Verify end-to-end: run `weeklySummarize()` once smoke-test data is in the Onboarding `LABOUR_COST` sheet

## Future
- Move Playwright runners to an always-on box
- Telegram notifications when connectors go `blocked`
