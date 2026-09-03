# Step 7: oauth-scopes

## STOP - DO NOT PERFORM THIS STEP IN THIS RUN

Jake is **not** at the keyboard for this run, and this step cannot be done unattended.
Your ONLY action is to set this step's status in
`phases/roastery-wholesale/index.json` to `"blocked"` with:

```
"blocked_reason": "Requires Jake at the keyboard - the re-consent window makes the /exec web app unavailable to every connector until a human completes it. See step7.md. Set to pending when Jake is ready, and not Mon 03:00-10:00 Australia/Sydney."
```

Then finish. Change no other file. Do not edit `appsscript.json`, do not upload code, do
not run the project's deployment script. The rest of this file is the procedure for when
Jake IS present - read it, act on none of it.

---
## Requirements Covered

- `PRD-14` — the new connector's failure alerts are worthless while every `CalendarApp`
  call dies at the permission boundary. This step declares the project's OAuth scopes so
  alerting actually works.

If the Task below contradicts the requirement, `docs/ADR.md`, or a CRITICAL rule in
CLAUDE.md, set `"status": "needs_context"` with the contradiction spelled out and stop.

## ⚠ Read this before touching anything

`connectors/gas/appsscript.json` declares **no `oauthScopes` key at all** today — scopes
are statically inferred. Adding the key on a deployment configured
`"access": "ANYONE_ANONYMOUS"` / `"executeAs": "USER_DEPLOYING"` invalidates the deploying
user's authorization. **Between `clasp push` and Jake completing the interactive re-auth,
`/exec` is DOWN** — that is `doPost` for every Playwright connector *and* the `doGet` that
`LEIBLE_GM_COST_MONITOR` reads. Time-based triggers also fail during that window, and a
clean run in this project logs nothing.

Two hard scheduling rules:
- **Do not run this step Monday 03:00–10:00 Australia/Sydney** — it would overlap
  `weeklySummarize` (04:00), `shopifyWeeklyPull` (05:00), `wholesalePull` (06:00) and the
  consumer's 08:00 read.
- Run it only when Jake is present and can complete the re-authorization immediately.
  If he is not, set `"status": "blocked"` with `blocked_reason` saying so. Do not push.

## Files to Read

- `connectors/gas/appsscript.json` (all 14 lines).
- Every `connectors/gas/*.gs` — you are enumerating their service call sites.
- `connectors/gas/staleness.gs:18-27` and `:277` — the header comment about scope
  inference, and its claim to be the sole `CalendarApp` source, which
  `orderapp.gs:176,212` already falsifies. Correct that comment while you are here.
- `scripts/deploy.sh`.

## Task

**1. Enumerate, do not guess.** Grep every `connectors/gas/*.gs` for service symbols and
build the list from the actual call sites: `SpreadsheetApp`, `GmailApp`, `DriveApp`, the
`Drive` advanced service, `UrlFetchApp`, `ScriptApp`, `CalendarApp`, `MailApp`, `Session`,
`PropertiesService`, `LockService`, `Utilities`. Map each to its scope. Expect at minimum
Sheets, Gmail read + label/modify, Drive **and** the Drive advanced service,
`script.external_request`, `script.scriptapp`, Calendar — and check specifically for
`MailApp` (`script.send_mail`) and `Session.*` (`userinfo.email`), which are easy to miss.
A single omitted scope silently breaks a working connector.

**2. Declare** the `oauthScopes` array in `appsscript.json`.

**3. The `tdd: true` half — a mechanical guard in `test_code.js`.** Assert that every
service symbol appearing in any `connectors/gas/*.gs` has a corresponding entry in
`appsscript.json`'s `oauthScopes`. Read both from disk, as the existing shipped-state
gates do. This is what turns a future silent runtime auth failure into a red suite.
⚠ **Insert it ABOVE the summary / `process.exit` block at the end of `test_code.js`** —
tests appended after that block never run, and the total stays put, which reads as passing.

**4. Deploy and verify** — `bash scripts/deploy.sh`, Jake re-authorizes, then run each of
these and record the actual result next to the expected one:

| check | expected |
|---|---|
| `mayersDailyPull` (Gmail read + label + Drive OCR) | runs, no permission error |
| `squareDailyPull` | runs, no permission error |
| labour pull reading `LABOUR_SHEET_ID` | opens the external sheet |
| `checkIngestStaleness()` | **creates a calendar event** — this is the whole point |
| one authenticated `doPost` via `base_connector` | `result:'ok'` |
| one `doGet` probe with `token` | `result:'ok'`, rows returned |

**Rollback:** `git checkout <sha> -- connectors/gas/appsscript.json && bash scripts/deploy.sh`.
`clasp redeploy <id> -V <prev>` restores `/exec` **only** — time-based triggers run project
HEAD, not the deployed version, so a version rollback alone leaves every trigger broken.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
bash scripts/lint.sh
```

Plus the six live checks above, all passing, recorded with their real output.

## Verification Procedure

1. Run both AC commands. Record pass/fail counts.
2. Confirm the new guard actually runs: note the suite's total before and after — it must
   increase. A total that did not move means the test landed below `process.exit`.
3. Mutation check: delete one scope from `appsscript.json` and confirm the guard reds.
   Revert.
4. Run all six live checks and paste their real output into this step's notes. A check you
   did not run is a check that failed.
5. Update this step in `phases/roastery-wholesale/index.json`.

## Prohibitions

- Do not deploy Monday 03:00–10:00 Australia/Sydney. Reason above.
- Do not deploy unattended. Reason: `/exec` stays down until a human completes the
  re-authorization, and nothing in this project logs its own silence.
- Do not compose the scope list from this step file's prose. Reason: it is a summary, not
  an inventory — grep the call sites.
- Do not use `clasp redeploy -V` as the rollback. Reason: it restores the web app only,
  not the manifest the triggers run against.
- Never `clasp create-script`; never mint a new deployment. Reason: one project, one
  deployment id (CLAUDE.md).
- Do not break existing tests.
