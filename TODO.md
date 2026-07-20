# TODO — LEIBLE Expense Data Collector

## Done — at a glance
- Project scaffolded (git, gitignore, CLAUDE.md, docs, harness framework)
- Scaffold revised to the two-tab schema (`Suppliers` + `Sales`); Order-app `.claude` hook suite + team-share `.gitignore` adopted
- **Phase 0 GAS hub LIVE** — Sheet, GAS project, doPost, dedup, deploy pipeline all operational (proven by FDCo + Ordermentum + Square data in production)
- Playwright base + 4 portal skeletons scaffolded
- **Food and Dairy Co connector built + live-tested 2026-06-18** (326 invoices, dedup verified)
- **Ordermentum connector live-tested 2026-06-18** — Butterboy fix verified (tradingName match), 114 rows (74 Tuga + 40 Butterboy); cleanup deployed to relabel "Wholesale Cookies PTY LTD" → "Butterboy" and delete out-of-filter suppliers
- **Fresh and Chill connector built + live-tested 2026-06-22** — Zupply web app (not WhatsApp); York 36 orders, dedup verified; 3 shops left to seed
- **Read API + weekly summary built 2026-06-22** — token-gated `doGet`, `weeklySummarize()` with 6-month archive/purge
- **Summary dedup bug found + fixed + live-repaired 2026-07-17** — `String(week_start)` never matched a Sheet's
  Date, so every run re-appended the whole week (06-15 written 4×; `doGet` over-reported spend 4×). Fixed at all
  3 dedup sites, live tab repaired (24 dupes deleted, 2 weeks backfilled, verified 0 remaining), weekly trigger
  installed. **237 tests green** — the mock now coerces dates on write, which is what had hidden it under 209 green tests.
- **Phases 7 + 8 fully closed 2026-07-17** — `API_READ_TOKEN` + `LABOUR_SHEET_ID` set, weekly trigger live,
  one-shots removed. The hub is end-to-end operational.

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
- [x] Daily `mayersDailyPull` trigger installed 2026-07-17 (6am AEST) — every source is now unattended.
- [ ] **(Jake)** After the FIRST auto-forwarded invoice lands, sanity-check it parsed (Outlook rule format may
      differ from the manually-forwarded one that was verified).

### Phase 3 — Ordermentum (Tuga Pastry + Butterboy + Fuel Bakery) — ✅ LIVE (2026-06-18; Fuel added 2026-07-20)
- Connector + session + `docs/clickpath-ordermentum.md` exist (API-first).
- [x] **Butterboy fixed (2026-06-18):** `tradingName` match + relabel. See clickpath "Supplier identity gotcha".
- [x] **Live POST verified (2026-06-18):** run 1 → `rowsAdded:1, duplicatesSkipped:113`; run 2 → `rowsAdded:0, duplicatesSkipped:114` (dedup idempotent).
- [x] **`cleanupOrdermentumRows()` run 2026-07-17** — reported `renamed=0, deleted=0` (nothing left to fix in
      `Suppliers`), and the function has been deleted from `Code.gs` as intended. Caveat: it only ever scanned
      `Suppliers`, and an `archiveAndPurge_` ran earlier the same day (93 rows older than 2026-01-15 → `_archive`),
      so any pre-2026 rows still labelled "Wholesale Cookies PTY LTD" are now frozen in `_archive` under the old
      name. Cosmetic only — `_archive` is cold raw data, `doGet` serves `Summary`, and no pre-2026 week is
      summarized. Worth a relabel pass only if `_archive` is ever used for historical analysis.
- [x] Registered `scripts/run_ordermentum.cmd` as Win task "LEIBLE Expense - Ordermentum" — daily 03:20, LogonType=Interactive (runs while logged in). Session ~15-day JWT refresh; re-run `--attended` when it `blocks`.
- [x] 🟢 **OUTAGE RESOLVED 2026-07-20** — Jake re-authed (`--attended`), backfill POSTed all 160 rows,
      re-run proved dedup (`rowsAdded:0, duplicatesSkipped:160`). One-shot `runOrdermentumBackfillJul2026`
      (since deleted, deploy v21) deleted the stale/frozen Ordermentum Summary rows for weeks 06-29 / 07-06 /
      07-13 and rebuilt them via `weeklySummarize` — **all 14 rebuilt rows verified against per-invoice totals
      computed directly from the Ordermentum API**. Labour + other suppliers untouched (kept 07-17 stamps).
      Note: Tuga has **zero invoices after week 06-29** — Fuel Bakery replaced them, so missing Tuga rows in
      later weeks is reality, not lost data.
- [x] **Fuel Bakery added 2026-07-20** — new pastry supplier (replaces Tuga). `"fuel"` appended to
      `SUPPLIER_FILTER`; verified via API probe: legal name = tradingName = "Fuel Bakery" (no Butterboy-style
      mismatch), matches exactly one supplier, active at York/Pitt/Crowsnest (North has no filtered suppliers —
      legitimate). History starts week 2026-06-29; all 3 completed weeks summarized (see above). No GAS changes
      needed (per-row supplier name).
- **This is exactly what the watchdog is for** — it ran blocked for ~2 weeks and nothing said a word, which is
  the same failure `staleness.gs` was written after. The 2026-07-18 11:00 alert on `ordermentum` is the
  watchdog working correctly on its first day.
- [x] **(decision closed 2026-07-20)** Widen `SUPPLIER_FILTER` to ALL Ordermentum suppliers? **No — keep the
      narrow allowlist.** A new supplier is one keyword; the filter is what keeps one-off/test suppliers out
      of the Sheet.
- **Auto-login — ✅ LIVE-VERIFIED (Ordermentum) 2026-07-20.** Headless form-fill fallback fires when the
  session is auth-dead: reads creds from gitignored `.env`, logs in, re-saves session, continues. Reusable
  base primitive (`base_connector.py`) wired into **both** Ordermentum and Fresh & Chill. Kills the
  fortnightly `--attended` ritual; `--attended` stays as manual fallback; 96h watchdog stays as backstop.
  - [x] **LIVE-PROVEN end-to-end (Ordermentum) 2026-07-20:** forced auth-dead → headless auto-login →
        session saved → 161 rows POSTed (`rowsAdded:1, duplicatesSkipped:160`); re-run reused the saved
        session (no login) `rowsAdded:0, duplicatesSkipped:161`. Creds confirmed correct.
  - [x] **SPA async-auth race found + fixed live:** Ordermentum auth is an XHR that sets the cookie ~1s
        AFTER submit (`/v1/profiles/` 401@t+0 → 200@t+1, url→/dashboard), so the original single post-submit
        check false-reported correct creds as "rejected" + tripped the breaker. `credentials_login` now
        POLLS the success signal up to `LOGIN_SETTLE_TRIES`(15)×1s. Same defensive poll applied to F&C.
        See memory `gotcha-spa-login-async-auth-poll`.
  - [x] Ordermentum login form mapped (plain email+password, no MFA/CAPTCHA) → `docs/clickpath-ordermentum.md`
        "Login form" section. Selectors: `#email` / `#password` / `button[type=submit]` (avoid the decoy
        visibility-toggle `button[type=button]`).
  - [x] Base primitive: `.env` parser (first-`=` split, no inline-`#` strip, `os.environ` precedence,
        creds never logged), `auth_state` ok/dead/transient (fires ONLY on genuine 401/403; 5xx/timeout/
        network = transient → blocked, no attempt), per-key circuit-breaker (`sessions/<key>.autologin_blocked`,
        trips on cred-rejection only, cleared by `--attended` or new `--clear-breaker`), `TransientLoginError`.
  - [x] F&C: own DOM-based dead/transient classifier (no status code); per-shop breaker; partial-success
        loop preserved (one shop failing never aborts the others).
  - [x] Tests: **96 pass** (33 connector-suite: cred-parse/breaker/classifier + regression tests for the 3
        review bugs + 4 SPA-poll tests; 63 untouched still green). Independent Opus plan-review + security
        review, all findings folded in.
  - [x] Recurring 10-day "check auto-login health" reminder → Jake's personal calendar (2026-07-30 start).
  - [x] All creds saved to `.env` (Ordermentum + all 4 F&C pairs), confirmed present + well-formed 2026-07-20.
  - [ ] **(Jake)** `.env.example` needs the new var names appended — blocked by the global `Read(**/.env.*)`
        deny + Write-needs-Read deadlock (see memory `gotcha-env-file-read-deny-write-deadlock`). Jake edits it,
        or OKs a Bash-append (writes names only, reads no secrets).
  - [x] **F&C auto-login LIVE-VERIFIED 2026-07-20** — all 4 shops: emptied sessions → auto-login → save →
        scrape (York 58 / North 80 / Crowsnest 34 / Pitt 57 = 229 orders) → POST `rowsAdded:3`; re-run
        reused saved sessions (no login) `rowsAdded:0, duplicatesSkipped:229`. **Fixed a selector bug found
        live:** Zupply/Devise login field is a TEXT `#user_login` (not `type=email`) + `<input type=submit
        name=commit>` (not a button) — assumed-conventional selectors had timed out. Real selectors now in
        `docs/clickpath-fresh_and_chill.md` + `_auto_login_shop`.
  - [x] `.env.example` completed (11-var template, no values) via Bash write-only append (the `Read(**/.env.*)`
        deadlock blocks the Edit/Write tools).
- [ ] ⚠️ **`_archive` double-count risk found 2026-07-20:** the 07-20 backfill re-ingested 2025 Butterboy
      invoices that `archiveAndPurge_` had already moved to `_archive` on 07-17 — dedup only reads `Suppliers`,
      so purged rows aren't remembered. Those rows now exist in BOTH tabs, and the next Monday trigger will
      re-archive them, creating true duplicates inside `_archive`. Cosmetic while `_archive` stays cold raw
      data, but fix before ever analyzing `_archive` (options: dedup `_archive` on write, or a cleanup pass).

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

### Phase 7 — Read API + Weekly Summary — ✅ LIVE + REPAIRED (2026-07-17)
- Token-gated `doGet` serves weekly summaries (supplier + location + total_spend) from `Summary` tab.
- `weeklySummarize()` aggregates last Mon–Sun into `Summary`, archives raw rows > 6mo to `_archive`, purges originals.
- Default (no params) = last completed week; override with `?from=...&to=...`.
- [x] Code + tests written (`Code.gs`, `test_code.js`)
- [x] API docs written (`docs/api.md`)
- [x] Deployed — live `/exec` returns the token gate (verified 2026-07-16, version 17).
- [x] **Summary dedup bug FIXED (2026-07-16)** — `weeklySummarize` keyed dedup on `String(week_start)`, but the
      Sheet returns that cell as a **Date**, so the key never matched its `yyyy-MM-dd` counterpart and every run
      re-appended the whole week. Live `Summary` shows the 06-15 week written **4×**; `doGet` sums `Summary`, so
      spend was over-reported 4×. Same bug fixed in `labourWeeklyPull_` (Labour tab + Summary keys).
      Root cause it survived 209 green tests: the Node mock stored appended dates as the strings they were
      written as, so `String(cell)` round-tripped cleanly in tests and only broke against a real Sheet. Mock now
      coerces bare `yyyy-MM-dd` on write, mirroring Sheets. See memory `sheet-date-coercion`.
- [x] **Live `Summary` repaired 2026-07-17** — one-shot `runSummaryRepair()` (since deleted): `deleted=24,
      conflicts=0`; backfilled 2026-06-22 (`summariesAdded=6, labour=5`) and 2026-06-29 (`summariesAdded=6,
      labour=5`). The 2026-07-06 week had already landed via a manual no-arg run.
      **Verified live:** the follow-up dry run reported `0 duplicate(s), 0 conflict(s)` — a fresh read of the
      real Sheet from inside GAS, which is the only trustworthy proof here. Drive's `contentSnippet` is a
      cached index and still showed the deleted rows ~minutes later; **never verify a just-finished GAS run
      with it.**
- [x] Weekly `weeklySummarize` trigger installed 2026-07-17 (Monday 4am AEST). Safe now that the dedup is
      fixed — it can no longer append a duplicate set each week.
- [x] One-shots removed from `Code.gs` after running clean (2026-07-17): `runSummaryRepair` (hardcoded
      June-2026 weeks — a footgun if re-run later) and `cleanupOrdermentumRows` (Phase 3; final run
      `renamed=0, deleted=0`). `cleanupDuplicateSummaryRows` is **kept** — dry-run by default, and it's the
      detector that proves the invariant if duplicates ever reappear.
- **Editor gotcha that cost a round-trip:** the Run button passes **no arguments**, so
  `cleanupDuplicateSummaryRows(false)` / `weeklySummarize('2026-06-22')` are not runnable from it — and forcing
  it by editing the signature to `function f(false)` is a SyntaxError that blocks saving. Any hand-run function
  taking arguments needs a zero-arg wrapper. See global memory `gas-runtime-limitation-global`.
- [x] `API_READ_TOKEN` set in Script Properties (confirmed by Jake 2026-07-17). Note for future sessions: a bare
      `/exec` returns `unauthorized` whether the property is set or missing, so this is **not** verifiable from
      outside — only `/exec?token=...` distinguishes the two.

### Phase 8 — Labour link (Onboarding app LABOUR_COST sheet) — ✅ LIVE
- [x] `labourWeeklyPull_()` implemented in Code.gs — reads Onboarding app `LABOUR_COST`, writes `Labour` tab + `Summary` rows (`supplier='Labour'`), empty-safe
- [x] `LABOUR_SHEET_ID` set — confirmed live: real Labour rows for week 2026-06-15 are in the hub Sheet (5 locations, $4,203–$7,245).
- [x] Deployed; `Labour` tab materialised.
- [x] **Test coverage added (2026-07-16)** — the labour path was running weekly against real data with **zero**
      tests (its only mention in the suite was a line switching it OFF). Now covered: dedup re-run, Date
      round-trip, and the missing-`LABOUR_SHEET_ID` skip path.
- Note: labour rows only ever landed once, so unlike the supplier rows they were not duplicated — the same
  latent Date-key bug was there, it just hadn't been re-run yet. Fixed before it could bite.

### Phase 9 — Ingest watchdog (staleness.gs) — ✅ ARMED (2026-07-17)
- `checkIngestStaleness` alerts (orange all-day Calendar events) when any of `food_dairy_co`, `fresh_and_chill`,
  `ordermentum`, `square`, `mayers` stops ingesting. Signal = max(newest sheet `extracted_at`, Script-Properties
  heartbeat) — the sheet alone measures last NEW DATA (dedup means a healthy quiet run writes nothing → cries
  wolf); the heartbeat alone doesn't exist until the first post-deploy run (→ everything alerts on day 1).
- `staleness.gs` is deployed and stable (shipped in v17–19, `/exec` healthy throughout).
- [x] `checkIngestStaleness` trigger installed 2026-07-17 (daily 11:00 AEST). The system is now automated AND
      monitored — closing the gap the file's own header warns about ("every scheduled ingest failed silently for
      a month" because nothing was watching).
- Threshold is **96h** — deliberately silent through a normal Fri→Mon (80h), so a weekend never cries wolf.
- Heartbeats are stamped by `doPost` (all Playwright sources), `mayers.gs`, and `square.gs`.
- [ ] **(Jake)** First real run is 11:00 on 2026-07-18. **Expect exactly ONE alert: `ordermentum`** — and it is
      **correct** (see Phase 3). The other four stamp heartbeats on any healthy run, including quiet ones
      (`mayers` stamps even with no invoice — a quiet day ≠ broken, and a broken Gmail scope throws rather than
      faking success; the Playwright sources stamp via `doPost` regardless of dedup). So: one expected alert,
      and **any OTHER alert is real** — investigate, don't dismiss.
- Deliberate asymmetry worth remembering: `square` stamps **only if at least one site had a token**. A revoked
  token makes every site `continue`, so an unconditional stamp there would mean "ran fine, wrote nothing,
  watchdog silent forever" — the month-of-silence failure in new clothes. No token → no heartbeat → alert fires.

## Future
- Move Playwright runners to an always-on box
- Telegram notifications when connectors go `blocked`
