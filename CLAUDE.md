# LEIBLE Expense Data Collector

Central hub that pulls expense + sales data from multiple suppliers into one Google Sheet, normalized to a department-tagged schema (`Suppliers` invoice-level + `Sales` Square daily + `Revenue` order-level, all tagged `Cafe`/`Roastery`). Built on the Harness Framework (phase/step runner). See `docs/schema.md`.

## Tech Stack
- **Google Apps Script (GAS)** + clasp — Sheet writes, normalization, Square API, email parsing
- **Python 3 + Playwright** — browser automation for supplier portal logins
- **Claude browser tools** — attended login, click-path mapping, re-auth when sessions expire

## Data Sources

| Source | Type | Runtime |
|---|---|---|
| Square | API (key) | GAS |
| Mayers (chocolate) | PDF invoice (email attachment) | GAS (GmailApp + Drive OCR) |
| Food and Dairy Co | Portal login | Playwright |
| Fresh and Chill | Portal login | Playwright |
| Kent Paper | Portal login | Playwright |
| Tuga Pastry | Ordermentum app | Playwright |
| Butterboy | Ordermentum app | Playwright |

Labour/payroll is **not** computed here — the engine lives in `LEIBLE_New_Staff_Onboarding_App`; this collector reads its `LABOUR_COST` sheet via `LABOUR_SHEET_ID` script property (see `docs/ADR.md` ADR-007).

## Architecture Rules
- CRITICAL: **Two runtimes, one boundary.** GAS owns every Sheet write, Square API pull, Mayers PDF parse, and normalization. Playwright connectors ONLY log in, download raw data, and POST to the GAS `doPost` ingest endpoint — a connector never writes to the Sheet directly.
- CRITICAL: **All EXTERNAL ingest flows through `doPost` → `validateIngest_` → the two-tab contract** (`Suppliers` invoice-level + `Sales` Square daily). A connector never appends to a tab outside that path. GAS-native pulls (`square.gs`, `mayers.gs`, labour, `orderapp.gs`) are the sanctioned exception: they write through the internal normalizers/upserts (`ingestSupplierRows`/`upsertRows_`), which enforce the same dedup keys. The dedup keys are the contract — `source`+`invoice_ref` for `Suppliers`, `date`+`location` for `Sales` — see `docs/schema.md`.
- Connectors emit **raw** source rows; normalization is GAS's job (`normalizeSupplierRow`), not the connector's.

## Absolute Rules
- **Never commit credentials, PII, or business data.** `.env`, `credentials/`, `downloads/`, `sessions/`, `*.csv|xlsx|pdf` are gitignored.
- **Never bypass MFA or CAPTCHA** — Jake passes those manually.
- **Secrets stay out of chat and out of the repo.**
- **Git push only when Jake says "lets stop here."** Always fetch+rebase before push (teammate safety).
- Only operate on Jake's own / authorized accounts.

## Canonical IDs
- **Sheet:** `13h4BNTrj5UhHo-XCFdOjimaCOTx4hjhTxR-m-OkvFdI` · **scriptId:** `1Wc6QMqEGWX6cTTcVnrgE3Fynj7R-TeDudgzmjGALsOFYxc13qJ_jTBwn` (tracked in `config/clasp.json`).
- **One project, one deployment.** Never `clasp create-script` again; never mint a new deployment. The single deployment id lives in `config/deployment.json` and is updated in place (`clasp redeploy`).

## Git push vs Deploy (separate triggers)
- "**lets stop here**" = **git push only** (`python scripts/pre_push_sync.py` → fetch → if behind, rebase --autostash → abort on conflict; never force-push). Nothing else.
- **Deploy to GAS** happens **when GAS coding is finished** — its own step, not tied to the push phrase: `bash scripts/deploy.sh` (`clasp push` + redeploy the ONE deployment).

## Harness (this is a harness-driven project)
- Run / resume a phase: read `phases/index.json`, take the FIRST entry whose `"status"` is `"pending"`, then `python scripts/execute.py <that dir>`.
- If an earlier entry is `error`/`blocked`/`needs_context` **and** no later entry is `completed`, resolve that first — do not skip it. If a later entry IS `completed`, the earlier one is historical bookkeeping; confirm against `git log` and carry on.
- Trust `phases/{task}/index.json` + `git log` over recollection — a summary remembered from earlier in a long session may be stale.
- Self-test: `python -m pytest scripts/test_execute.py -q` — **never** `python scripts/test_execute.py` (it is a pytest module with no `__main__` guard, so it exits 0 having run nothing).

## Development Process
- CRITICAL: Steps marked `tdd: true` are test-first — follow the step file's "Test First" block exactly (red-green-refactor; the enumerated cases define "done"). The v2 harness enforces this mechanically: it confirms the test **fails** (RED) before implementation, requires it to **pass** (GREEN) after, and hard-errors a step where `tdd: true` has no `test_cmd`.
- Commit messages follow conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).

## Docs Index (lazy-load)
- `docs/architecture.md` — two-runtime design, data flow, POST bridge. *Load when reasoning about system design.*
- `docs/ADR.md` — why GAS, why Playwright, why hybrid. *Load when questioning a tech choice.*
- `docs/PRD.md` — goal, sources, scope. *Load when scoping new connectors.*
- `docs/rules.md` — full operating rules. *Load before automating or scheduling.*
- `docs/schema.md` — two-tab Sheet spec (`Suppliers` + `Sales`). *Load when writing connectors or normalization.*
- `docs/api.md` — read API (doGet) endpoint, auth, params, response format. *Load when building consumers or modifying the summary endpoint.*
- `docs/harness-workflow.md` — how to use the phase/step runner. *Load when creating or running phases.*
- `TODO.md` — active work items.
