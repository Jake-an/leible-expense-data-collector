# Step 8: task-scheduler-registration

## Files to Read

- `docs/rules.md` — the operating rules for scheduled automation.
- `connectors/shopspend/runner.py` — the CLI built in step 5 (`--week`, `--from-week/--to-week`,
  `--backfill`, `--dry-run`).
- `connectors/playwright/base_connector.py` — `load_env_file` (**49-84**) and `get_credential`
  (**87-93**), so the credential path in the script's docs is accurate.
- `scripts/setup_always_on.ps1` — the existing PowerShell scheduled-task precedent in this repo.
  Follow its conventions; note the review finding that it handles a Windows password correctly
  (`Get-Credential` in memory only, cleared in a `finally`, never logged or written to disk).

## Background

A GAS time-trigger runs in Google's cloud and **cannot start a Python process on this machine** —
which is why the weekly pull is a Windows Scheduled Task and the GAS trigger from step 7 is only a
watchdog. The two are complementary: the task does the work, the watchdog notices when it didn't.

The task must be resilient to the machine being off on a Monday. That is already handled in the
runner: `--backfill` computes which of the last 4 closed weeks have no `ShopSpendPulls` coverage
and requests only the missing span. So the scheduled task always runs `--backfill`, never a bare
single-week pull.

**Token hygiene is the sharp edge of this step.** `C:\Windows\System32\Tasks\*` is plain XML,
readable by any local admin, and is not gitignored. The token must **never** appear in the task's
Arguments.

## Task

**1. `scripts/register_shopspend_task.ps1`.**

- Registers a scheduled task named `LEIBLE ShopSpend Weekly`, trigger **Monday 05:00 local**.
- Action runs the repo's Python against `-m connectors.shopspend.runner --backfill`.
- **Start-in / working directory = the repo root.** Reason: `python -m connectors.shopspend.runner`
  needs the repo root on `sys.path`. (Note: this is *not* about `.env` resolution — `ENV_FILE` is
  anchored to `Path(__file__).resolve().parents[2]` in `base_connector.py:38,42` and is entirely
  CWD-independent. Do not repeat the wrong rationale in a comment.)
- **No secret in Arguments.** The runner reads `.env` itself.
- Idempotent: re-running replaces the existing task rather than creating a duplicate.
- Writes stdout/stderr to `logs/shopspend.log` (already gitignored) so the watchdog's alert body,
  which points at `logs\<source>.log`, is accurate.
- `-WhatIf` / a `--dry-run`-equivalent switch that prints the registration without applying it.

**2. Document the attended first run** in `docs/rules.md`: how to populate `SHOPSPEND_ENV`,
`SHOPSPEND_URL_PROD`, `SHOPSPEND_TOKEN_PROD` (and the DEV pair) in `.env`, how to verify with
`--dry-run`, and the reminder that the first real backfill is run **attended and off-hours**
because it holds the shared GAS script lock in multi-chunk bursts.

**3. Do NOT execute the registration.** This step produces the script and the documentation. Jake
runs it, with a real token, as part of the attended integration pass.

## Acceptance Criteria

```bash
powershell -NoProfile -Command "$null = [ScriptBlock]::Create((Get-Content -Raw scripts/register_shopspend_task.ps1)); Write-Output 'parses ok'"
python -c "import pathlib; s=pathlib.Path('docs/rules.md').read_text(encoding='utf-8'); assert 'SHOPSPEND_TOKEN' in s and 'attended' in s; print('rules.md ok')"
```

Plus a manual read-through confirming:
- The token appears nowhere in the script or in any task argument.
- The working directory is set to the repo root.
- The task action invokes `--backfill`.

## Verification Procedure

1. Run both AC commands.
2. `grep -ri "AKfycb\|SHOPSPEND_TOKEN_PROD=" scripts/ connectors/` returns no literal secret value.
3. Confirm `.gitignore` still covers `.env` and `logs/`.
4. Run the full gate: `bash scripts/stop_gate.sh`.
5. Update `phases/shopspend/index.json` step 8. Expect `"status": "blocked"` with a
   `blocked_reason` naming what Jake must do (populate `.env` with the real token, run
   `--dry-run`, then deploy + attended backfill) — that is the correct terminal state here, not an
   error.

## Prohibitions

- Do not put the token in the task Arguments, in the task XML, or in any log line. Reason:
  `C:\Windows\System32\Tasks\*` is readable by any local admin.
- Do not run `Register-ScheduledTask` as part of this step. Reason: it needs Jake's decision and a
  live token; registering a task that then fails weekly is worse than none.
- Do not run `scripts/deploy.sh`, the live backfill, or any real endpoint call. Reason: those are
  the attended integration steps, and the deploy touches the ONE shared deployment serving all six
  existing connectors.
- Do not commit a populated `.env` or any downloaded data. Reason: it holds every customer's
  revenue figures.
