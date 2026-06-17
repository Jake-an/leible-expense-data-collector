# LEIBLE Expense Data Collector

Central hub that pulls expense + sales data from multiple suppliers into one Google Sheet, normalized to a two-tab schema (`Suppliers` invoice-level + `Sales` Square daily). Built on the Harness Framework (phase/step runner).

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

Labour/payroll is **not** a connector here — it's owned by `LEIBLE_Payroll`; this collector links to its output (see `docs/ADR.md` ADR-007).

## Architecture (two runtimes)
- **GAS** handles: Square API pulls, Mayers PDF-invoice parsing (Drive OCR), normalization, Sheet writes, `doPost` ingest endpoint, scheduling
- **Playwright** handles: portal logins with saved sessions → downloads raw data → POSTs to GAS endpoint
- Full detail: `docs/ARCHITECTURE.md`

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

## Commands
```
python scripts/execute.py <phase-dir>          # Run a connector phase
python scripts/pre_push_sync.py                # "lets stop here": teammate-safe git push only
bash scripts/deploy.sh                          # Deploy GAS after finishing code (one deployment id, no git)
```

## Docs Index (lazy-load)
- `docs/ARCHITECTURE.md` — two-runtime design, data flow, POST bridge. *Load when reasoning about system design.*
- `docs/ADR.md` — why GAS, why Playwright, why hybrid. *Load when questioning a tech choice.*
- `docs/PRD.md` — goal, sources, scope. *Load when scoping new connectors.*
- `docs/rules.md` — full operating rules. *Load before automating or scheduling.*
- `docs/schema.md` — two-tab Sheet spec (`Suppliers` + `Sales`). *Load when writing connectors or normalization.*
- `docs/harness-workflow.md` — how to use the phase/step runner. *Load when creating or running phases.*
- `TODO.md` — active work items.
