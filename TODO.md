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

### shopspend-hardening — 4 minors carried out of the approved phase (2026-08-05)
Phase-end gate returned **approve**; these were noted, not blocking. None is a correctness bug.
All four closed by phase `dopost-auth-minors` (2026-08-05):

- [x] `runner.py` `compute_weeks_complete`: the `paging.truncated` branch now prints the same
      `WARNING` its five siblings do (step 2).
- [x] `connectors/gas/shopspend.gs:85`: degraded-mode log reworded to "for this request" (step 1).
- [x] `connectors/gas/Code.gs:208` `isValidWeekLabelArray_` now bounds the week number to 01-53
      (step 1).
- [x] `docs/api.md` — remediation curl gated on `token`; write-side auth documented (step 4).
- [x] doPost auth decision: option (a) — `weeks_verified_empty` token-gated on `API_READ_TOKEN`
      (phase `dopost-auth-minors`, 2026-08-05). Reusing the READ token was Jake's explicit call
      (over a separate write token) — a leaked read credential therefore also carries the
      tombstone-bypass write capability. Optional future hardening: split out an
      `API_WRITE_TOKEN` (poster + gate change only, no other connector touched).


### Roastery department — ✅ MIGRATED + DEPLOYED 2026-08-03 (version 23)
Branch `feat-roastery-department`. Phase 1 migration runbook executed end-to-end against the
live hub Sheet; `/exec` moved v22 → **v23** on the same deployment id (URL unchanged).
456 GAS tests green.

- [x] **Phase 1 migration Runbook — DONE 2026-08-03.** Backfill: `Suppliers` 715, `_staging` 0,
      `_archive` 319, `Sales` 24, `Labour` 30, `Summary` 96 — apply matched dry run exactly.
      Sweep after deploy: `blanksFilled: 0` on all 5 tabs (nothing wrote during the window).
      **Index-shift canary PASSED** — re-POST of an existing `mayers`/`3429816` row returned
      `rowsAdded:0, duplicatesSkipped:1`, so dedup survived the column add. Revenue upsert
      round-trip verified (`rowsAdded:1` then `rowsUpdated:1`).
      Deviations from the plan, all deliberate:
      - Restore point is a **named Google Sheets version** (`pre-department-migration`), NOT a
        Drive copy — Jake's call. Restore is therefore whole-spreadsheet, not the plan's
        per-tab *Copy to* recipe at lines 507-511.
      - Rollback anchor (code): `clasp redeploy <deploymentId> -V 22 -d 'rollback to 22'`.
      - The plan's canary connector `kent_paper.py` is **dead** — `LOGIN_URL` is still an
        unfilled TODO (`kent_paper.py:23`). Substituted the curl re-POST above, which tests the
        same dedup path against real data and writes nothing when it passes.
      - Required new code: `migrateAddDepartment_`/`sweepBlankDepartments_` are unreachable from
        the Apps Script editor (trailing `_` hides them from the Run dropdown; the Run button
        passes no args, so `dryRun !== false` always resolved to a dry run — the write path would
        have reported success and changed nothing). Added four public zero-arg wrappers
        (`runDepartmentMigration{DryRun,Apply}`, `runBlankDepartmentSweep{DryRun,Apply}`) in
        `Code.gs`, commit `b9d3dc6`.
- [ ] **(Jake) Test C — `doGet` department filter.** Not yet run; needs `API_READ_TOKEN`.
      `<exec>?token=…&from=2026-06-15&to=2026-06-21&department=Roastery` → expect zero rows
      (nothing Roastery has landed). Same URL without `&department=` → Cafe rows carrying
      `department` + `kind`, and `total` (not `total_spend`).
- [ ] **`weeklySummarize` round-trip verification** (plan line 697) — deliberately deferred: it
      writes to `Summary`, which is exactly what the blocking cleanup below rebuilds. Run it as
      step 0 of that cleanup, not standalone.
- [ ] **(Jake) Step 4.0 — inspect the coffee order app.** Blocks the rest of Phase 4. Checklist
      is in `docs/ingest-contract.md`: where order data lives, stable order ids?, do uploaded
      invoices carry structured date/vendor/amount or are they file-only, can the app POST out.
      **Waiting on the coffee-order-app API key (Jake, 2026-08-03) — parked until that arrives.**
- [ ] **(Jake) Script Properties** — see the "Shopify bring-up" section below for the Shopify
      pair and their ordering; `RECUR_RENT_ROASTERY` / `RECUR_SHOPIFY` are listed there too.
- [ ] **(Jake) Gmail label `roastery/invoices`** + filter, then install the roastery trigger.
- [ ] `recurring` is unwatched by the staleness watchdog — monthly cadence vs the 96h threshold
      would cry wolf ~26 days a month. Needs per-source thresholds in `staleness.gs`.
- [ ] `mayers.gs` entry point (`mayersPull`) was never wrapped in `withScriptLock_` — it fell
      outside every phase's declared `Files:` list. Every other entry point is wrapped.
- [ ] Decide: `validateIngest_` accepts a numeric-string `amount` (`"340.00"`) via
      `isNaN(Number(...))`. The plan listed "amount as a string" as a rejection case. Tightening
      it would reject a plausible coffee-order-app payload.
- [ ] `roastery_email.gs` ships ONE vendor parser ("Sample Bean Co", synthetic). Real vendor
      layouts need their own parsers — deliberately no generic fallback.

### Shopify weekly Roastery figure — ⚠️ NOW LIVE (v23, 2026-08-03) — CLEANUP HAS A DEADLINE
`aggregateSupplierRows_` groups `kind='revenue'` rows by **source** when `channel='online'`
(one weekly row per source) and keeps per-customer grain on every other channel. No Shopify
connector change; no new tab.

**This shipped in version 23 on 2026-08-03 as part of the department deploy — it is no longer
"pre-deploy".** The `weeklySummarize` trigger was reinstalled the same day (Monday 04:00
Australia/Sydney), so:

> **Hard deadline: the cleanup below must be done before Monday 2026-08-10 04:00 AEST.**
> That is the next scheduled `weeklySummarize`. If it fires first, the new source-keyed rows
> land alongside the old customer-keyed ones and `doGet` double-counts those weeks.
> If the cleanup can't happen in time, delete the `weeklySummarize` trigger to buy a week
> (`installWeeklySummarizeTrigger` in `Code.gs` restores it).

- [ ] **(Jake) BLOCKING cleanup — see deadline above. Now scripted (v24).**
      The dedup key includes `supplier`, so any pre-existing customer-keyed `kind='revenue'`
      **online** Summary row is orphaned rather than updated → `doGet` double-counts that week.
      Run these three from the Apps Script editor **in order** (the Run dropdown keeps its last
      selection and re-runs it — check the log's leading text to know what actually ran):
      1. `runOnlineRevenueCleanupDryRun` — writes nothing. Reports `found`, the affected weeks,
         each week's total, and two warnings that must be cleared BEFORE applying:
         `resummarizable:false` (that week's `Revenue` rows are gone — re-summarizing regenerates
         nothing, restore from the backup tab by hand) and `channelCasings` with more than one
         entry (mixed `Online`/`online` collapses on rebuild — fix the casing in `Revenue` first).
         Record the row count and the distinct `week_start` values here.
      2. `runOnlineRevenueCleanupApply` — copies every matched row to
         `Summary_online_revenue_backup` before a single delete fires, then deletes. Scope is
         `kind='revenue'` AND `location='online'`, case-insensitive, and nothing else; wholesale
         revenue keeps its per-customer key and is not touched. Idempotent.
      3. `runOnlineRevenueResummarize` — reads its week list back from the backup tab and loops
         `weeklySummarize` once per week, oldest first. One call writes ONE week, so a single
         manual run would leave older weeks permanently missing and `doGet` would under-report.
      4. Spot-check `doGet?from=&to=` returns one online revenue row per source with the right
         total. Then drop the `Summary_online_revenue_backup` tab once the figures look right.
      Rollback: `clasp redeploy AKfycby...wnfM -V 23` for the code; the backup tab for the rows.
      Implementation `Code.gs:981`; tests `test_code.js` (`v23 grain cleanup` + `round trip`),
      mutation-checked both ways.
- [ ] **Square daily sales never reach the weekly report.** `Sales` is written by `squareDailyPull`
      and read only by `cleanupCorruptSalesRows` (`Code.gs:823`) and the staleness watchdog
      (`staleness.gs:113`). `weeklySummarize` aggregates `Suppliers` + `Revenue` only
      (`Code.gs:1239-1243`) and `doGet` serves `Summary` only (`Code.gs:955`) — so no Square figure
      is reachable via the API at all. Decide whether that's intended.
- [ ] **Mixed channel casing silently loses revenue (pre-existing).** The aggregator groups on the
      raw `location` string but Summary dedup lowercases it (`rowKey_`, `Code.gs:421`), so `"Online"`
      and `"online"` in one week collapse to one Summary row and the later group is dropped as an
      in-batch duplicate — 100 + 25 reports as **25**. Pinned by a test; documented in
      `docs/api.md` and `docs/ingest-contract.md`. A real fix would normalize channel casing on
      write, which changes wholesale dedup keys — deliberately not done here.

### Shopify bring-up — teed up for next session
Code is deployed (v23) but **inert**: `shopifyDailyPull` reads its Script Properties, finds them
unset, logs `missing SHOPIFY_SHOP_DOMAIN/SHOPIFY_ACCESS_TOKEN — skipping` and returns without
stamping a heartbeat (`shopify.gs:61-64`). Nothing is written and the staleness watchdog will
not cry wolf. No trigger exists for it yet.

Order for next session:

- [ ] **⚠️ FIRST — check `SHOPIFY_API_VERSION`.** `shopify.gs:24` pins **`'2024-10'`**, which is
      almost certainly out of support as of 2026-08. Shopify retires versions after ~12 months.
      The plan (line 529) explicitly said to confirm the current stable version against Shopify's
      docs at build time. **Verify against the live docs before pulling anything** — a retired
      version fails or silently changes shape. Do not bump it from memory.
- [ ] **(Jake) Create the custom app + token.** Shopify admin → Apps → develop apps → custom app.
      Minimum scope **`read_orders`**. (`read_all_orders` is only needed for orders >60 days old
      and requires Shopify approval — irrelevant with no historical backfill.)
- [ ] **(Jake) Set Script Properties:** `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`.
      Never in the repo, never in chat.
- [ ] **Smoke test before arming the trigger:** from the editor run `shopifyDailyPull` with no
      argument — it defaults to yesterday (`shopify.gs:53`), so it is safe to Run directly and
      needs no wrapper. Confirm rows land in `Revenue` with `department='Roastery'`,
      `channel='online'`.
- [ ] **Reconcile** that day's `Revenue` total against Shopify's admin sales report (plan line 702).
- [ ] **Only then** run `installShopifyTrigger()` (`shopify.gs:114`) — daily 03:00 Sydney,
      re-pulls the last 2 days.
- [ ] Remaining Script Properties for the recurring-costs phase: `RECUR_RENT_ROASTERY`,
      `RECUR_SHOPIFY`.

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

### Phase 0 review findings — backlog (triaged 2026-07-22)
Source: `phases/0-foundation/review-result.json` (3 criticals already FIXED + shipped in the
silent-ingest phase). The 15 below were **re-verified against branch HEAD** on 2026-07-22 — the review
ran off a stale phase-0 merge-base, so status here is current, not as-written. **Base for all fixes:
new branch off trunk (`feat/two-tab-foundation`) AFTER the two in-flight PRs land** (harness-v2 + the
3 fixes). Many findings live in files already inside those PRs — do NOT expand the approved PRs.

**P1 — prod-data / security risk**
- [ ] **#1 (IMP) `doPost` has ZERO auth** — `connectors/gas/Code.gs`. Anyone with the `/exec` URL (same URL
      published for the read side in `api.md`) can POST arbitrary rows into `Suppliers`/`Sales`. doGet is
      token-gated via `checkReadToken_`; doPost is not. Fix = shared-secret header/param, mirror the read gate;
      every connector must then send it → GAS redeploy. Effort: M.
- [ ] **#5 (IMP) Connector non-200 swallowed as empty** — `connectors/playwright/ordermentum.py:~130` +
      `food_dairy_co.py:~176`. PARTIAL: now *warns* but still `return []`/`{}`, so a 5xx for one supplier at one
      venue silently drops its invoices while others post; run reports success. Same class as the connector-POST
      bug just fixed — should raise/`mark_blocked`. Effort: S.
- [ ] **#4 (IMP) `deploy.sh` can mint a 2nd deployment** — `scripts/deploy.sh:~72`. First-deploy detection trusts
      `config/deployment.json` alone; if `deploymentId` is blanked, DID resolves empty → `clasp create-deployment`
      branch → 2nd live `/exec`, violating the one-deployment rule. Add a `clasp list-deployments` cross-check
      before minting. Effort: S.

**P2 — data integrity, cheap**
- [ ] **#7 (IMP) Bare `NotImplementedError` crashes unattended run** — `connectors/playwright/base_connector.py`.
      Default `credentials_login()` raises `NotImplementedError` but `_attempt_auto_login` only catches
      `TransientLoginError`; connectors that don't override (FDCo/Kent) crash instead of `mark_blocked`. Effort: S.
- [ ] **#9 (MIN) Missing supplier merges Tuga + Butterboy** — `connectors/gas/Code.gs`. `validateIngest_` doesn't
      require `row.supplier` when `source==='ordermentum'` (SUPPLIER_NAMES intentionally omits it); a missing
      supplier falls through to the raw `'ordermentum'` label, merging both suppliers' spend. Effort: S.
- [ ] **#11 (MIN) `labourWeeklyPull_` silent zeros on header drift** — `connectors/gas/Code.gs`. Indexes
      `col['week_start']` with no existence check → `coerceDateStr_(undefined)` → every row skipped → returns
      zeros indistinguishable from "no labour data yet", traced only by a `Logger.log`. Effort: S.

**P3 — harness / gate safety (tooling, not prod data)**
- [ ] **#2 (IMP) Review gate binds to stale local `main`** — `scripts/execute.py`. `_resolve_review_base` only does
      local `git rev-parse --verify`; origin has no `main`, so every phase review diffs ~5 weeks of unrelated
      history with no warning — defeating the gate. Effort: M.
- [ ] **#3 (IMP) `test_cmd` runs `shell=True` unvalidated** — `scripts/execute.py:~400`. Unlike the deploy path
      (`_validate_deploy_cmd`), `test_cmd` is read fresh from `index.json` (editable by a
      `--dangerously-skip-permissions` session) and run unconditionally. Effort: S.
- [ ] **#12 (MIN) `pre_push_sync` waves through any git error** — `scripts/pre_push_sync.py:~40`. Any non-zero exit
      from `git rev-list --count HEAD..origin/<branch>` (not just true first-push) → exit 0, skipping the
      behind/rebase check. Effort: S.
- [ ] **#14 (MIN) `sync-from-remote.js` hook has never worked** — `.claude/hooks/sync-from-remote.js`. Hardcodes
      `git fetch origin main` throughout; origin default is `feat/two-tab-foundation`, so every SessionStart fetch
      fails and is swallowed. Effort: S.
- [ ] **#15 (MIN) `_eval_verdict` / `_run_probe` untested** — `scripts/test_execute.py`. The pass/fail/retry/escalate
      branching driving the live-verification gate has no direct unit tests (grep returns zero). Effort: M.

**P4 — low impact / robustness**
- [ ] **#8 (MIN) Mayers "Sub Total" may match before real "Total"** — `connectors/gas/mayers.gs:173`. First-match
      regex `/(?:^|\s)Total.../` — the space in "Sub Total" satisfies `\s`. Unconfirmed against a live sample;
      flagged as a regex-construction risk. Effort: S.
- [ ] **#10 (MIN) `ensureSheet` never validates existing headers** — `connectors/gas/Code.gs`. No comparison vs
      `SUPPLIERS_HEADERS`/`SALES_HEADERS` for pre-existing tabs; a manual column insert/reorder → every `appendRow`
      writes into the wrong columns silently. Effort: M.
- [ ] **#13 (MIN) Kent Paper skeleton crashes on `goto('')`** — `connectors/playwright/kent_paper.py:~22`.
      `LOGIN_URL=''` but `run()` calls `page.goto(LOGIN_URL)` before branching → uncaught invalid-URL error instead
      of the "not implemented" fail-safe. Not in use (Phase 6 deferred). Effort: S.

**Decision (no code) — needs Jake's sign-off**
- [ ] **#16 (MIN) `.gitignore` un-ignores `.claude/{settings.json,hooks/,commands/}`** to share team config,
      contradicting the global "`.gitignore` must exclude `.claude/`" rule. Justified in a comment; means anything
      dropped into those subpaths is committed by default. Confirm this is intended or tighten it.

**Verified FIXED (no action)**
- [x] **#6 (IMP) Force-push guard regex** — `.claude/hooks/block-dangerous.js`. Now catches flag-after-ref and bare
      `-f` (`/git\s+push\b[^\n]*\s(?:--force(?:-with-lease)?|-f)(?=\s|$)/i`); tripped live on a test string.

## Future
- Move Playwright runners to an always-on box
- Telegram notifications when connectors go `blocked`
