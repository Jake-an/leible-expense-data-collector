# Architecture Decision Records

## Philosophy
Get expense data flowing into one Sheet as fast as possible. Minimize infrastructure. Reuse patterns Jake already runs in other LEIBLE projects (GAS + clasp). Accept human-in-the-loop for auth; don't fight Cloudflare.

---

### ADR-001: Google Apps Script + Google Sheet as the hub, reusing Square from GM Cost Monitor
**Decision**: All normalization, storage, and API-native connectors live in GAS. The Sheet is the single source of truth. The Square API wrapper is **reused** from `LEIBLE_GM_COST_MONITOR/SquareAPI.gs` (`callSquareAPI`/`searchOrders`/`listLocations`), not rewritten — its `Config.getSquareEnvironment()` dependency is dropped (prod base URL is used directly).
**Reason**: Jake's other LEIBLE projects (Order App, GM Cost Monitor) already use GAS + clasp. Same deploy workflow, same mental model. Zero infrastructure cost. Square is already proven in GM Cost Monitor — lifting it avoids re-testing auth, pagination, and the Square-Version header.
**Trade-offs**: GAS has execution time limits (6 min/run), no browser, limited debugging. Acceptable for the data volumes here. Carrying a copy of SquareAPI rather than a shared library means a future Square change must be applied in both projects.

### ADR-002: Playwright for portal logins (hybrid with Claude browser tools)
**Decision**: Claude browser tools map the click-path and handle attended first-login / re-auth. Playwright scripts run the proven path unattended with saved sessions.
**Reason**: Portals (Food & Dairy Co, Ordermentum, etc.) require browser login, often behind Cloudflare. Playwright with a persistent session is free, fast, and predictable for repeat runs. Claude tools handle the brittle "figure it out" part.
**Trade-offs**: Requires Jake's machine to be awake for portal runs. Sessions expire and need manual re-auth (the `blocked` status handles this). Future: move to an always-on box.

### ADR-003: POST-to-GAS bridge (not direct Sheets API)
**Decision**: Playwright connectors POST raw invoice-level rows to a GAS `doPost` web-app endpoint. GAS normalizes and writes to the `Suppliers` tab.
**Reason**: Keeps normalization in one place (GAS) for all sources. The Sheet stays the single write point. Avoids duplicating schema logic in Python and GAS.
**Trade-offs**: Extra hop (HTTP POST) vs. direct Sheet write. Adds a GAS web-app deployment to manage. Worth it for single-source-of-truth normalization.

### ADR-003a: Invoice-level supplier granularity (no line items, GST, or categories)
**Decision**: The `Suppliers` tab is invoice-level — `date, supplier, total, invoice_ref, location, source, extracted_at`. No line items, no GST split, no expense categories. Dedup key is `source + invoice_ref`.
**Reason**: The goal is "what did we spend with whom, when" — totals per invoice answer that. Line items and categories multiply connector complexity (every portal lays out line items differently) for analysis nobody asked for yet. An invoice number is a clean natural dedup key; `source+date+amount+description` was brittle.
**Trade-offs**: Can't break spend down by item or tax without a later schema change. Accepted — add it only if a real reporting need appears.

### ADR-004: Session persistence for Cloudflare / portal auth
**Decision**: Save browser session state (cookies, localStorage) to `sessions/` after attended login. Reuse for unattended runs. Mark `blocked` when expired.
**Reason**: Cloudflare Turnstile and portal MFA can't be solved by automation — Jake's rule: "never bypass MFA or CAPTCHA." Saved sessions carry the human-cleared pass. The harness's `blocked` status naturally models the re-auth cycle.
**Trade-offs**: Sessions expire (hours to weeks depending on portal). Jake must re-auth periodically. This is the only honest approach.

### ADR-005: Teammate-safe git push protocol
**Decision**: Push only on Jake's exact phrase "lets stop here." Before any push, `scripts/pre_push_sync.py` runs: `git fetch origin <branch>` (block if GitHub unreachable — never push blind), and if behind, `git pull --rebase --autostash`. On rebase conflict it aborts and stops for Jake. Never force-push.
**Reason**: Colleagues may work on this repo. Modeled after the LEIBLE Order App's `pre-deploy-sync.js`, added after the 2026-06-11 incident where a blind push overwrote a teammate's work.
**Trade-offs**: Slightly slower push cycle. Worth it to never lose work.

### ADR-006: Harness Framework for orchestration
**Decision**: Use the phase/step runner (`execute.py`) from the Harness Framework scaffold. Each connector is a phase; each step is self-contained with guardrail injection.
**Reason**: Proven pattern — sequential steps with self-correction (3 retries), context accumulation, and `blocked` for human-needed situations. Fits the "portal needs a human for auth" model perfectly.
**Trade-offs**: Adds structure overhead for simple connectors. Pays off when connectors break and need debuggable, retryable execution.

### ADR-007: Labour cost read from LEIBLE Onboarding app (not recomputed here)
**Decision**: This collector does **not** compute labour cost. Labour (ISO week × location: gross + super, no tax) is owned by the `LEIBLE_New_Staff_Onboarding_App`; the collector reads its `LABOUR_COST` sheet via `LABOUR_SHEET_ID` script property and pulls into the `Labour` tab + `Summary` tab during `weeklySummarize()`.
**Reason**: The labour-cost engine was ported from `LEIBLE_Payroll` into the Onboarding app (2026-06-23) because Payroll was parked. The Onboarding app is the authoritative compute source; this collector only reads its output. One-directional read keeps the boundary clean.
**Trade-offs**: The expense hub depends on a second project's output being current. Acceptable — the Onboarding app is Jake's, the link is read-only, and `labourWeeklyPull_` is empty-safe (skips gracefully if the source sheet is empty or the property is unset).
**Script property required**: `LABOUR_SHEET_ID` = Onboarding DEV spreadsheet ID (`1SUg3rE5V46HQ7JtZzqus960KdLjxJd6AdcrYDq8zyGs`) — set in Apps Script editor → Project Settings → Script Properties.

### ADR-008: Single environment (one Sheet, one GAS project)
**Decision**: One Sheet, one bound GAS project, one set of Square tokens. No dev/prod profile split. A `_staging` tab absorbs test ingestion before a connector is trusted.
**Reason**: This is a small internal tool for one operator. A two-environment setup (and the clasp profile-swap machinery the Order App carries) is overhead with no payoff here. A scratch tab gives the same "test without polluting real data" safety far more cheaply.
**Trade-offs**: A bad write hits the real Sheet's tabs (mitigated by `_staging` + dedup). No isolated place to rehearse a risky migration — accepted at this scale.

### ADR-009: `department` column + upsert dedup + LockService (Roastery expansion, Phase 1)
**Decision**: Add a `department` column (`Cafe` | `Roastery`) to every existing tab, appended **last** so `SUPPLIERS_KEY_COLS`-style index-based dedup keys never shift. A new `Revenue` tab (order-level, dedup `source+order_ref`) carries non-Square revenue. `doPost` gains an explicit `kind` discriminator (`suppliers` default | `revenue`) rather than inferring kind from `source`. Ingest and `weeklySummarize` move from append-with-skip dedup to **upsert**: an existing key with a changed amount updates in place instead of being silently skipped forever. `migrateAddDepartment_`/`sweepBlankDepartments_` are dry-run-by-default, idempotent, blank-only-fill migrations. `LockService` (previously unused in this repo — see `staleness.gs`'s comment on why it was skipped there) is now wrapped around every entry point (`doPost`, `weeklySummarize`, `squareDailyPull`, `migrateAddDepartment_`) via a single `withScriptLock_` helper with a depth counter, because every ingest path is scan-then-write and locking only the write half doesn't close the race.
**Reason**: Encoding department in `source`/`location` naming was rejected — the split would live in string conventions that every report has to re-derive. Separate Roastery tabs were rejected — duplicating dedup/summary logic per department multiplies the maintenance surface for no benefit. Upsert was required because the wholesale order app can amend an order after ingest; append-only dedup would let that correction vanish silently, especially once the week is already summarized. `staleness.gs`'s earlier "no LockService" call was about a heartbeat where a lost write self-heals next run; a column rewrite / dedup-then-write has no such self-healing property, so this is a deliberate departure from that precedent, not a reversal of it.
**Trade-offs**: `department` going last (rather than a "logical" position) is a readability cost accepted for dedup-key safety. Upsert makes `Summary`/`Suppliers`/`Revenue` mutable in a way plain append never was — a bug in `upsertRows_` can now silently corrupt an existing row's amount, not just add a duplicate; the Node-mock test harness had to be upgraded first (P0) so `getRange().setValue()` could actually fail a test. The migration is additive-only and not auto-reversible (see the plan's Rollback section) — a bad migration needs the Drive-copy restore procedure, not a code revert.

### ADR-010: doPost's `roster` kind writes the Labour Sheet, not the hub (Amendment B)
**Decision**: `doPost` gains a fourth payload kind, `roster`, bound to the one source `brighthr_roster` (token `INGEST_TOKEN_BRIGHTHR_ROSTER`; `INGEST_SOURCE_KINDS_.brighthr_roster = ['roster']`, department binding `null`). It branches **before** `getHubSpreadsheet_()`, inside `withScriptLock_`, opens **only** `LABOUR_CLOCK_SHEET_ID` (refusing `clock_sheet_unset` if unset; never the hub, never `LABOUR_SHEET_ID`), and writes the Labour Sheet's `CLOCK_RAW` tab. This is a sanctioned exception to "all external ingest reaches the hub" — the roster is labour input, not an expense row.
**Reason**: Probing on 2026-10-15 showed no single BrightHR feed carries both hours and shop. Jake enters the roster weekly and the roster CSV carries both, so it is the source of truth. `labourRosterToClockRows_` converts each shift to the existing `LABOUR_CLOCK_COLS` shape (`break_minutes` = span − paid hours, blank `rate` → RATES fallback), so `labourRowsToShifts_` and the Phase 2 cost engine are unchanged.
**Write rule**: date-level replace. The dates present in the payload are replaced — only rows whose `record_id` starts `roster:` and whose clock-in Sydney date is in that set (date read through `labourSydneyParts_`, string or Date) — and other dates and non-roster rows are untouched. One `setValues` of the whole table, then only the leftover tail is cleared; `clock_in`/`clock_out` are forced to plain text and kept rows are re-normalised to `YYYY-MM-DD HH:MM`. An empty post is refused (`roster_empty`) so it can never wipe days.
**Trade-offs**: Roster hours are not clocked hours, so late finishes and no-shows are invisible. A day emptied by a roster edit keeps its stale rows (a day with zero shifts is never in the payload). `brighthr_roster` is watched by the staleness check at 192h (a skipped Monday upload alerts).
(Numbered ADR-010: ADR-008 and ADR-009 were already taken when Amendment B was written.)

### ADR-011: Labour cost computed from the Labour Sheet behind `LABOUR_SOURCE=clock` (labour-clock Phase 3; supersedes ADR-007 per location once live)
**Decision**: `weeklySummarize` calls `labourWeeklyRoute_` (`labour_weekly.gs`) instead of `labourWeeklyPull_`. Three separate script properties: `LABOUR_CLOCK_SHEET_ID` says **where** the Labour Sheet is (enough for the read-only `labourClockPreview()`); `LABOUR_SOURCE=clock` says **whether** the weekly run uses it; `CLOCK_START_WEEK` is the first week the new path may write (earlier weeks refuse `before_clock_start` and stay legacy/`Cafe`, a recorded decision). With the switch on, `labourWeeklyCompute_` costs the week from `CLOCK_RAW` + CONFIG/PEOPLE/RATES/FIXED/CASH_SHIFTS (opening **only** `LABOUR_CLOCK_SHEET_ID`, never `LABOUR_SHEET_ID`) and writes **only the `live` LOCATIONS rows**: Labour Sheet `LABOUR_COST` (upsert `week||location`), the hub `Labour` tab and `Summary` with the real department. The legacy pull skips exactly those (week ≥ start, live) pairs and keeps everything else. A blank/unrecognised `live` cell is not live. If the new path refuses outright (`clock_start_unset`, `clock_sheet_unset`, `config_error`) the legacy pull covers every location and a RED alert fires.
**Reason**: Labour cost must match actual pay (roster hours + fixed roastery + cash rules, ADR-010 / Amendment A); the Onboarding app's LABOUR_COST does not. Per-location `live` flags let Phase 4 compare one shop at a time and roll back without touching the others.
**Also changed**: the hub `Labour` tab now **rewrites** a changed total/department on `week_start||location` (both paths, `labourHubUpsert_`); the legacy append-only dedup froze a corrected total forever.
**Department change**: once the roastery location is live, its Summary rows are `Roastery`; the old `Cafe` rows for the same weeks would remain (department is in the upsert key). `labourRunRoasteryCleanup()` removes them (weeks ≥ start that have a Roastery row only), snapshotting each to `_labour_snapshot` first. `labourRunRollback()` unsets the switch, clears every `live` cell, deletes live-week Roastery rows and restores only the snapshot's rows whose key is absent (no double count); it refuses `legacy_removed` once `labourWeeklyPull_` is deleted. The GM cost monitor must be told the department split is changing before the roastery goes live.
**Trade-offs**: Two labour paths coexist until Phase 5. A week whose clock data is refused (>10% exceptions) or errors writes nothing for live cafe locations (fixed-cost rows still write) — loud alert, no silent fallback, because a fallback could write the stale Onboarding figure under the same key.
(Numbered ADR-011: the parent plan said "ADR-008", but ADR-008/009/010 were taken.)
