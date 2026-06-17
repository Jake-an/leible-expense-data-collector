# Rules — Operating Rules for All Connectors

## Security & Data
1. **Never commit credentials, PII, or business data.** `.env`, `credentials/`, `downloads/`, `sessions/`, `*.csv|xlsx|pdf` are gitignored.
2. **Secrets stay out of chat and out of the repo.** API keys, passwords, tokens — only in `.env` or GAS Script Properties.
3. **Never bypass MFA or CAPTCHA.** Jake passes those manually. Automation reuses the resulting session.
4. **Only operate on Jake's own / authorized accounts.** Each connector targets a specific account Jake has access to.

## Browser Automation
5. **Session-first:** always try the saved session before a fresh login. If expired, mark `blocked` and stop.
6. **Attended first login:** the first run of any portal connector opens a visible browser. Jake logs in and clears any challenges. The session is saved for future unattended runs.
7. **Fail safe:** a connector that hits an unexpected page must stop and mark `blocked` or `error` — never blindly click onward.
8. **Click-path mapping:** Opus maps + hardens each portal's click-path first (recorded in `docs/clickpath-<connector>.md`). Only then codify into a Playwright script.

## Git & Collaboration
9. **Push only when Jake says "lets stop here."** No other trigger causes a push.
10. **Always fetch+rebase before push.** Run `scripts/pre_push_sync.py` (or its equivalent). Block on conflict — never force-push over a teammate's work.
11. **Conventional commits:** `feat(<phase>):`, `fix(<phase>):`, `chore(<phase>):`, `docs:`.
12. **Commit after meaningful changes** so everything is rollback-able.

## Execution
13. **Plan with Opus, execute with Sonnet/Haiku.** Reserve Opus for planning, hardening, and fixing breakage.
14. **Harness phases are self-contained.** Each step file must include all context — no "as discussed previously."
15. **Blocked = human needed.** API keys, manual auth, external setup — mark `blocked` with a clear reason and stop immediately.

## How to Apply
- Is it secret or PII? → gitignore it.
- Is it risky / irreversible / outward-facing? → confirm with Jake first.
- Is the task hard reasoning? → Opus.
- Is it a proven repeat? → Haiku/Sonnet.
