# Rules — now & future

Operating rules for this project and the broader "Claude-as-OpenClaw" setup.

## Now (this project)

1. **Never commit credentials or payroll/PII data.** `.env`, `credentials/`,
   `downloads/`, and `*.csv|*.xlsx|*.pdf` are gitignored. Keep it that way.
2. **Only operate on Jake's own / authorized BrightHR account.**
3. **Never bypass MFA or CAPTCHA.** Jake passes those manually when present.
4. **Password never goes through chat.** Preferred: Jake types it into the browser
   at the prompt, or it lives in a gitignored `.env`.
5. **Hybrid order:** Opus maps + hardens the click-path first; only then hand it to Haiku.

## Future (the wider setup)

6. **Folders for this work live only under `C:\Users\mioja\.claude\projects`.**
   Do not scatter project folders elsewhere (e.g. not at `C:\Users\mioja\` root).
7. **Plan with Opus, execute with Haiku.** Reserve Opus for planning, hardening, and
   fixing breakage; let Haiku run proven recipes on a schedule or on-demand.
8. **Recipes must fail safe.** A scheduled Haiku job that hits an unexpected page should
   **stop and notify Jake (Telegram) / escalate to Opus**, not blindly click on.
9. **Telegram is the inbound channel.** Front desk = `~/.claude/channels/telegram`
   (bot + allowlist already configured). Keep the allowlist tight.
10. **Secrets stay out of the repo and out of chat** — tokens, API keys, passwords.
11. **Commit after meaningful changes** so everything is rollback-able (`git log` → checkout).

## How to apply

When in doubt: is it secret or PII? → gitignore it. Is it risky/irreversible/outward-facing?
→ confirm with Jake first. Is the task hard reasoning? → Opus. Is it a proven repeat? → Haiku.
