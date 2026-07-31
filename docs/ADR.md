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
