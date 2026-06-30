# Live-verification — how to arm this app

This app has the live-verification gate **installed but dormant**. Two new files were added
and **nothing existing was changed**, so your current deploys behave exactly as before:

- `__test` endpoint file (e.g. `__test.gs` / `__test.js`) — the self-check endpoint, as a
  standalone `serveLiveTest_()` function **not yet wired into `doGet`** (so it does nothing yet).
- `scripts/verify_gate.sh` — the deploy-block script, **inert** because no hook references it.

Standard: `~/.claude/memory/live-verification.md`. Template + examples:
`~/.claude/templates/harness/examples/`.

## To ARM it (do these when you're ready — they are the per-app, creds-dependent steps)

1. **Write real checks.** In the `__test` file, replace `placeholder_logic` and
   `liveCheckDbConnected_` with real checks for THIS app, and set `covers:[...]` to its real
   features. Pass rule: `quality_score >= 90` AND every `critical:true` check passes.

2. **Set Script Properties** (Apps Script → Project Settings → Script Properties):
   - `SCRIPT_KEY` = a random secret (the test key).
   - `DEV_SHEET_ID` = the Dev spreadsheet id (only if you keep the sheet check).

3. **Wire the endpoint** — add ONE line at the very top of your existing `doGet(e)`:
   ```js
   if (e && e.parameter && e.parameter.fn === '__test') return serveLiveTest_(e);
   ```
   (If this app has no `doGet`/web app, deploy a Dev web app first, or call the test fn another way.)

4. **Deploy to Dev** (`clasp push` then deploy a Dev web app) and copy its `/exec` URL.

5. **Set env vars** (so the gate can reach the endpoint):
   - `HARNESS_TEST_URL` = `https://script.google.com/macros/s/<id>/exec?fn=__test`
   - `HARNESS_TEST_KEY` = the same value as `SCRIPT_KEY` (never printed by the script).

6. **Turn the block ON** — add a 2nd `PreToolUse` → `Bash` hook to `.claude/settings.json`
   (merge alongside any existing hooks; create the file if absent):
   ```json
   {
     "type": "command",
     "command": "bash \"$CLAUDE_PROJECT_DIR/scripts/verify_gate.sh\""
   }
   ```

7. **Prove it.** With `/__test` red → a `clasp deploy` / prod push is **blocked**. Fix it green
   → the deploy is **allowed**. `SKIP_VERIFY=1` bypasses for docs-only/emergency pushes.

## To REMOVE it (fully reversible)

Delete the `__test` endpoint file, `scripts/verify_gate.sh`, and this doc. If you armed it,
also remove the verify_gate hook line from `.claude/settings.json`.
