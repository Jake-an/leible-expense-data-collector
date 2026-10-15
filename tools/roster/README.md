# tools/roster

Weekly BrightHR roster upload (moved here from the Onboarding app's `tools/hours-runner/`).

**Monday:** export Reports > Roster > Roster Details (week) > Generate CSV, double-click
`Post-Roster.cmd` (or drag a CSV onto it), check the preview, press `y`. Re-run after any roster change.

- Posts `{source:'brighthr_roster', kind:'roster', token, rows}` to the `execUrl` in `config/deployment.json`.
- Token: `.roster-token.txt` (gitignored). First run generates it, copies it to the clipboard, shows an
  8-char fingerprint only, and clears the clipboard after you confirm the paste. Mismatch: `python post_roster.py --regen-token`.
- `ALSO_POST_ONBOARDING = True` also feeds the legacy `ingest-hours` endpoint (token read from the old
  `hours-runner\.hours-token.txt`, or a copy beside this script). Both posts always run; each result is shown.
  Set to `False` in Phase 5.
- A `LOCKED` response is retried once after 60s.
- Tests: `python -m pytest tools/roster -q`
