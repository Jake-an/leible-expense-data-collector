# BrightHR Payroll Roster Automation

Automate logging into BrightHR and downloading the payroll roster (by date range).
First concrete use case of the wider **"Claude-as-OpenClaw"** setup (see core idea below).

## Core idea (one paragraph)

OpenClaw (the Gemini "lobster") and Claude Code are two separate runtimes. Everything
OpenClaw uniquely offered is now reproducible on Claude — cheaply with **Haiku**, with
**native browser tools** (no setup), and an **always-on inbound channel via the existing
Telegram bridge**. So instead of porting work to the lobster, the plan is: **Opus plans &
hardens recipes → Haiku runs them cheaply on a schedule / on-demand → Telegram is the front
desk.** Full writeup: `docs/architecture.md`.

## Target
- Site: `https://app.brighthr.com.au`
- Goal: login → reports → select date range → download payroll roster

## Absolute rules (full list: `docs/rules.md`)
- **Never commit credentials or payroll/PII data.** `.env`, `credentials/`, `downloads/`, `*.csv|xlsx|pdf` are gitignored.
- Only operate on Jake's own / authorized BrightHR account.
- Never bypass MFA or CAPTCHA — Jake passes those manually.
- Password never goes through chat. Secrets stay out of the repo.
- Project folders live **only** under `C:\Users\mioja\.claude\projects`.

## Approach (hybrid)
1. **Phase 1 — Map the path (Opus + browser tools):** prove the exact working click-path, confirm it pulls the right roster. Record in `docs/clickpath.md`.
2. **Phase 2 — Hand off to Haiku:** turn the proven path into a recipe Haiku runs on a cron, unattended. (Porting to the OpenClaw lobster is the fallback, only if a Gemini/WhatsApp front desk is specifically wanted.)

## Docs index (lazy-load)
- `docs/architecture.md` — full core idea & target architecture. *Load when reasoning about the overall setup.*
- `docs/rules.md` — complete now/future operating rules. *Load before automating or scheduling.*
- `docs/clickpath.md` — recorded BrightHR navigation. *Created in Phase 1; load before any run.*
- `TODO.md` — active steps.
