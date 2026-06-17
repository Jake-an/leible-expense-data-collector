# TODO — LEIBLE Expense Data Collector

## Done — at a glance
- Project scaffolded (git, gitignore, CLAUDE.md, docs, harness framework)
- Scaffold revised to the two-tab schema (`Suppliers` + `Sales`); Order-app `.claude` hook suite + team-share `.gitignore` adopted
- Phase 0 GAS hub, Phase 1 Square pilot, Phase 2 Mayers built + Node-mock tested (code-complete; live deploy blocked on Jake's Step 0)
- Playwright base + 4 portal skeletons scaffolded (click-paths TODO, awaiting attended login)

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

### Phase 3 — Ordermentum (Tuga Pastry + Butterboy)
- [ ] **(Jake)** Attended first login → seed `sessions/`; map click-path → `docs/clickpath-ordermentum.md`
- [ ] Fill `# TODO(attended-mapping)` selectors in `ordermentum.py`; test unattended run → POST → `Suppliers`

### Phase 4 — Food and Dairy Co
- [ ] **(Jake)** Attended login + click-path map → `docs/clickpath-food_dairy_co.md`
- [ ] Fill selectors in `food_dairy_co.py`; test full flow

### Phase 5 — Fresh and Chill
- [ ] **(Jake)** Attended login + click-path map → `docs/clickpath-fresh_and_chill.md`
- [ ] Fill selectors in `fresh_and_chill.py`; test full flow

### Phase 6 — Kent Paper
- [ ] **(Jake)** Attended login + click-path map → `docs/clickpath-kent_paper.md`
- [ ] Fill selectors in `kent_paper.py`; test full flow

### Phase 7 — Labour link (Payroll output)
- [ ] Document/reference `LEIBLE_Payroll`'s labour-cost output (date × location, gross+super+penalties, no tax). No recompute. Depends on Payroll reaching Gate 10.

## Future
- Move Playwright runners to an always-on box
- Telegram notifications when connectors go `blocked`
- Dashboard / reporting view on top of the Sheet
