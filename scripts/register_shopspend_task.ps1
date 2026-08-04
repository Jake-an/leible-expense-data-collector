<#
.SYNOPSIS
    Registers (or replaces) the "LEIBLE ShopSpend Weekly" scheduled task.

.DESCRIPTION
    Runs `python -m connectors.shopspend.runner --backfill` every Monday 05:00 local time,
    with the working directory set to the repo root (python -m connectors.shopspend.runner
    needs the repo root on sys.path). --backfill self-heals a machine that was off on
    Monday: it asks the hub (fn=shopspendCoverage) which of the last 4 closed ISO weeks
    are already covered and requests only the gap, degrading to a full 4-week pull if the
    coverage read itself fails (connectors/shopspend/runner.py).

    No secret is ever placed in the task Arguments or XML. C:\Windows\System32\Tasks\* is
    plain XML, readable by any local admin — the runner resolves its own credentials
    (SHOPSPEND_ENV, SHOPSPEND_URL_<ENV>, SHOPSPEND_TOKEN_<ENV>, GAS_READ_TOKEN) from the
    repo-root .env via connectors/playwright/base_connector.py's load_env_file /
    get_credential, entirely independent of this script.

    stdout/stderr are appended to logs\shopspend.log (gitignored) so the watchdog's alert
    body (which names logs\<source>.log) points at a real file.

    Idempotent: registering again replaces the existing task of the same name
    (Register-ScheduledTask -Force) rather than creating a duplicate.

.PARAMETER WhatIf
    Print the task definition (name, trigger, action, working directory, log path) that
    WOULD be registered, without calling Register-ScheduledTask. Standard PowerShell
    -WhatIf, enabled via SupportsShouldProcess.

.NOTES
    Does NOT run automatically as part of any build/step — Jake runs this manually, and
    only after: populating .env with real credentials, confirming
    `python -m connectors.shopspend.runner --backfill --dry-run` works, and running one
    attended off-hours backfill by hand (see docs/rules.md, "ShopSpend Weekly Backfill —
    Attended First Run"). Registering a task that then fails silently every Monday is
    worse than not registering it at all.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = "Stop"

$TaskName    = "LEIBLE ShopSpend Weekly"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogsDir     = Join-Path $ProjectRoot "logs"
$LogPath     = Join-Path $LogsDir "shopspend.log"

Write-Host ""
Write-Host "LEIBLE ShopSpend Weekly - Scheduled Task Registration" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot"

# Resolve the python interpreter now, at registration time, rather than trusting a bare
# "python" to resolve the same way whenever Task Scheduler eventually runs this - PATH can
# differ by session/context.
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) {
    Write-Host "ERROR: 'python' not found on PATH in this session. Activate the right" -ForegroundColor Red
    Write-Host "environment/PATH and re-run." -ForegroundColor Red
    exit 1
}
$pythonPath = $pythonCmd.Source
Write-Host "Python: $pythonPath"

if (-not (Test-Path $LogsDir)) {
    New-Item -Path $LogsDir -ItemType Directory -Force | Out-Null
}

# cmd.exe /c wraps the call so stdout/stderr can be redirected to logs\shopspend.log --
# New-ScheduledTaskAction has no native output-redirection option. NEVER add the shopSpend
# token (or GAS_READ_TOKEN) here: the runner resolves both from .env itself, and this
# Arguments string is exactly what Task Scheduler stores, in the clear, in
# C:\Windows\System32\Tasks\<TaskName> - readable by any local admin.
$comSpec = $env:ComSpec
if (-not $comSpec) { $comSpec = Join-Path $env:WINDIR "System32\cmd.exe" }
$argumentList = "/c `"$pythonPath`" -m connectors.shopspend.runner --backfill >> `"$LogPath`" 2>&1"

$action      = New-ScheduledTaskAction -Execute $comSpec -Argument $argumentList -WorkingDirectory $ProjectRoot
$trigger     = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -WeeksInterval 1 -At "05:00"
$settings    = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$description = "Weekly shopSpend backfill (python -m connectors.shopspend.runner --backfill). " +
    "Self-heals weeks missed while the machine was off. Registered by " +
    "scripts/register_shopspend_task.ps1 - see docs/rules.md 'ShopSpend Weekly Backfill - " +
    "Attended First Run'. The GAS watchdog (docs/ARCHITECTURE.md) alerts if this task " +
    "itself stops running."

Write-Host ""
Write-Host "Task definition:" -ForegroundColor Cyan
Write-Host "  Name             : $TaskName"
Write-Host "  Trigger          : Weekly, Monday 05:00 local"
Write-Host "  Working directory: $ProjectRoot"
Write-Host "  Action           : $comSpec $argumentList"
Write-Host "  Log file         : $LogPath"

if ($PSCmdlet.ShouldProcess($TaskName, "Register scheduled task (replaces an existing task of the same name)")) {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Description $description -Force | Out-Null
    Write-Host ""
    Write-Host "[OK] Registered '$TaskName'." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "[WhatIf] Would register/replace '$TaskName' as shown above. Nothing was changed." -ForegroundColor Yellow
}
