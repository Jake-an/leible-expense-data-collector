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

### ADR-007: Labour cost owned by LEIBLE_Payroll, not reimplemented here
**Decision**: This collector does **not** pull BrightHR or compute labour cost. Labour (date × location: gross + super + weekend/PH penalties, no tax) is owned by the `LEIBLE_Payroll` project. The collector links to Payroll's output sheet.
**Reason**: Payroll already builds this (~85% done, 435 tests). Reimplementing it would duplicate a hard, well-tested calculation and risk divergence. There is no `brighthr.py` here.
**Trade-offs**: The expense hub depends on a second project's output. Acceptable — Payroll is Jake's and the link is one-directional (read Payroll's sheet). The link is meaningful only once Payroll reaches Gate 10.

### ADR-008: Single environment (one Sheet, one GAS project)
**Decision**: One Sheet, one bound GAS project, one set of Square tokens. No dev/prod profile split. A `_staging` tab absorbs test ingestion before a connector is trusted.
**Reason**: This is a small internal tool for one operator. A two-environment setup (and the clasp profile-swap machinery the Order App carries) is overhead with no payoff here. A scratch tab gives the same "test without polluting real data" safety far more cheaply.
**Trade-offs**: A bad write hits the real Sheet's tabs (mitigated by `_staging` + dedup). No isolated place to rehearse a risky migration — accepted at this scale.
