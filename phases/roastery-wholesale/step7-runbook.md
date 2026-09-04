# Step 7 — attended re-consent runbook

Everything in "Prepared" below is **already done and committed**. This file is the
minimal attended sequence, so the window where `/exec` is down is measured in minutes.

> `/exec` is the sole ingest path. Between the push and the completed re-authorization it
> is **DOWN** — that is `doPost` for every Playwright connector *and* the `doGet` that
> `LEIBLE_GM_COST_MONITOR` reads Monday 08:00. Time-based triggers also fail in that
> window, and a clean run in this project logs nothing.

## Prepared (unattended — no action needed)

| Item | State |
|---|---|
| `connectors/gas/appsscript.json` — explicit `oauthScopes` (6) | staged in the repo, **not pushed** |
| `test_code.js` oauthScopes coverage gate (17 assertions) | green, 1993 → 2010 |
| Mutation check (drop Calendar scope ⇒ suite reds) | verified, reverted |
| `staleness.gs` stale scope comments | corrected (line refs + inference claim) |

### The six scopes and what forces each

| Scope | Forced by |
|---|---|
| `…/auth/spreadsheets` | `SpreadsheetApp.openById` / `getActiveSpreadsheet` — hub + external `LABOUR_SHEET_ID` |
| `…/auth/gmail.modify` | `GmailApp.search` + `createLabel` + `thread.addLabel` — **read-only is insufficient** |
| `…/auth/drive` | `Drive.Files.insert` (advanced, OCR) **and** `DriveApp.getFileById(...).setTrashed` |
| `…/auth/calendar` | `CalendarApp` in `staleness.gs` **and** `orderapp.gs:455,491` — this is the alerting path |
| `…/auth/script.external_request` | `UrlFetchApp.fetch` |
| `…/auth/script.scriptapp` | `ScriptApp.newTrigger` / `deleteTrigger` / `getProjectTriggers` |

`MailApp` and `Session` — the two step 7 calls "easy to miss" — are **not used anywhere**,
so `script.send_mail` and `userinfo.email` are deliberately absent. The gate asserts their
absence, and will start *requiring* them the moment either symbol ships.

## ⚠ Prerequisite the step file does not mention

`bash scripts/deploy.sh` is blocked by the `security-deploy-gate.ps1` PreToolUse hook:

```
security-deploy-gate: BLOCKED - no security-review verdict recorded for this repo.
Unblock: run /security-audit in the target repo.
```

I hit this during step 7 prep. **Run `/security-audit` before the window opens**, not
during it — otherwise you discover it with `/exec` already down. Do not use the bypass
env var.

## ⚠ Verify `GAS_READ_TOKEN` BEFORE pushing

As of 2026-09-04 `doPost` requires a token on **every** payload, and the
connectors were updated in the same change to send it. The moment this code is
live, any connector that cannot resolve `GAS_READ_TOKEN` **stops ingesting** —
it fails loudly and posts nothing (deliberately: a tokenless POST would leak rows
to an endpoint that will only refuse them).

So before the push, confirm on the machine the Scheduled Tasks run on:

```bash
python -c "import sys; sys.path.insert(0,'connectors/playwright'); import base_connector as b; print('GAS_READ_TOKEN resolved:', bool(b.get_credential('GAS_READ_TOKEN')))"
```

It must print `True`. If it prints `False`, set it (same value as the GAS script
property `API_READ_TOKEN`) before going any further — and retype the value
rather than pasting, the GAS property UI clips long values.

## ⚠ Run step 8 in the same sitting

Step 5 armed `coffee_order_app` in `STALENESS_SOURCES`, but only step 8 ever stamps its
first heartbeat. `staleness.gs:259` short-circuits on a never-seen source **before** any
threshold is applied:

```js
if (seen === null) { out.push({ ..., stale: true, ... }); continue; }
```

So the 168h override gives **no** protection here. From the moment this push lands until
step 8's wet run succeeds, every `checkIngestStaleness` run alerts `coffee_order_app` as
"never seen since the watchdog was installed". Splitting steps 7 and 8 across days means
living with a daily false alarm — expect it, don't chase it.

## ⚠ `installOrderAppTriggers` also touches two LIVE triggers

It deletes and recreates all four handlers — `shopifyWeeklyPull`, `greenBeanPull`,
`wholesalePull`, `wholesalePullRetry` — not just the two new ones. That is idempotent
against the schedules written in code, but if either live trigger's timing was ever
adjusted by hand in the Triggers UI, **running this silently reverts it** to Mon 05:00 /
Tue 05:00. Check the Triggers page before running it; that page is the only source of
truth for what is actually installed.

## Attended sequence

Scheduling: **never Monday 03:00–10:00 Australia/Sydney** (collides with `weeklySummarize`
04:00, `shopifyWeeklyPull` 05:00, `wholesalePull` 06:00, and the consumer's 08:00 read).

1. `/security-audit` → verdict recorded. *(Do this first, ahead of time.)*
2. `bash scripts/deploy.sh --push-only`
   → pushes the manifest; live `/exec` keeps serving the **old** version, so nothing is
   down yet. This split is the whole reason `--push-only` exists.
3. Open the Apps Script editor, run any function, **complete the consent screen**.
   Grant all six scopes.
4. `bash scripts/deploy.sh` (full) → version + redeploy + unauthenticated smoke check.
   The smoke check proves the project *loads*; JSON back = healthy.
5. Run the six live checks below and record real output next to expected.

## The six live checks (step 7 §4)

| Check | Expected | Actual |
|---|---|---|
| `mayersDailyPull` (Gmail read + label + Drive OCR) | runs, no permission error | |
| `squareDailyPull` | runs, no permission error | |
| labour pull reading `LABOUR_SHEET_ID` | opens the external sheet | |
| `checkIngestStaleness()` | **creates a calendar event** — the whole point | |
| one authenticated `doPost` via `base_connector` | `result:'ok'` | |
| one `doGet` probe with `token` | `result:'ok'`, rows returned | |

For the calendar check: assert the event **exists** (title `LEIBLE expense stale: <source>`).
`eventsCreated:0` is dedup, not failure.

## Rollback

```bash
git checkout <sha> -- connectors/gas/appsscript.json && bash scripts/deploy.sh
```

**Not** `clasp redeploy -V`: a version rollback restores `/exec` only. Time-based triggers
run project HEAD, not the deployed version, so a version-only rollback leaves every
trigger broken while `/exec` looks fine.
