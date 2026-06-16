# BrightHR Payroll Roster Automation

Automate logging into BrightHR and downloading the payroll roster (by date range).

## Target
- Site: `https://app.brighthr.com.au`
- Goal: login → reports → select date range → download payroll roster

## Absolute rules
- **Never commit credentials or downloaded payroll/PII data.** `.env`, `credentials/`, `downloads/` are gitignored — keep it that way.
- Only operate on Jake's own/authorized BrightHR account.
- Do not attempt to bypass MFA or CAPTCHA — Jake passes those manually when present.

## Approach (hybrid)
1. **Phase 1 — Map the path (Claude + browser tools):** prove the exact working click-path, confirm it pulls the right roster.
2. **Phase 2 — Port to OpenClaw:** hand the proven recipe to the lobster as a skill so the always-on daemon can run it unattended.

See `TODO.md` for active steps and `docs/clickpath.md` (created in Phase 1) for the recorded navigation.
