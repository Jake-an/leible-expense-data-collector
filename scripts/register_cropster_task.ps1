<#
.SYNOPSIS
    Registers (or replaces) the "LEIBLE Cropster Weekly" scheduled task.

.DESCRIPTION
    Runs scripts\run_cropster.cmd every Monday 05:30 local time. The .cmd cd's to the repo
    root, loads .env, runs connectors\playwright\cropster.py and appends output to
    logs\cropster.log (gitignored). Exit code 2 means BLOCKED (session expired / CAPTCHA).

    -StartWhenAvailable makes a machine that was off at 05:30 run the task when it next
    comes up. The connector refetches a window of weeks, so a missed Monday self-heals.

    No secret is ever placed in the task Arguments or XML. C:\Windows\System32\Tasks\* is
    plain XML, readable by any local admin; the connector resolves its own credentials
    from the repo-root .env.

    Idempotent: registering again replaces the existing task of the same name (-Force).

.PARAMETER WhatIf
    Print the task definition that WOULD be registered, without calling
    Register-ScheduledTask. Standard PowerShell -WhatIf (SupportsShouldProcess).

.NOTES
    Does NOT run automatically as part of any build/step. Register only after the first
    attended login and a verified live pull (docs/rules.md, "Cropster Weekly").
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = "Stop"

$TaskName    = "LEIBLE Cropster Weekly"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RunnerPath  = Join-Path $PSScriptRoot "run_cropster.cmd"
$LogPath     = Join-Path (Join-Path $ProjectRoot "logs") "cropster.log"

Write-Host ""
Write-Host "LEIBLE Cropster Weekly - Scheduled Task Registration" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot"

if (-not (Test-Path $RunnerPath)) {
    Write-Host "ERROR: runner not found: $RunnerPath" -ForegroundColor Red
    exit 1
}

# The runner is a .cmd, so cmd.exe /c invokes it; it handles its own cwd and log redirection.
$comSpec = $env:ComSpec
if (-not $comSpec) { $comSpec = Join-Path $env:WINDIR "System32\cmd.exe" }
$argumentList = "/c `"$RunnerPath`""

$action      = New-ScheduledTaskAction -Execute $comSpec -Argument $argumentList -WorkingDirectory $ProjectRoot
$trigger     = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -WeeksInterval 1 -At "05:30"
$settings    = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$description = "Weekly Cropster roasting production pull (scripts/run_cropster.cmd). " +
    "Registered by scripts/register_cropster_task.ps1 - see docs/rules.md 'Cropster Weekly'."

Write-Host ""
Write-Host "Task definition:" -ForegroundColor Cyan
Write-Host "  Name             : $TaskName"
Write-Host "  Trigger          : Weekly, Monday 05:30 local"
Write-Host "  Settings         : StartWhenAvailable, ExecutionTimeLimit 30 min"
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
