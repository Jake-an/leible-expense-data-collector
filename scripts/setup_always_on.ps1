<#
.SYNOPSIS
    LEIBLE Expense Collector - make this laptop a genuine always-on, logged-out host.

.DESCRIPTION
    Implements the two changes from plan
    "resume-leible-expense-data-collector-pla-shimmering-sunbeam.md":

    (a) Power baseline + config
        - Snapshots the current power baseline (powercfg /query, standby-timeout-ac,
          powercfg /a hibernate state) to logs\power_baseline_<timestamp>.txt so rollback
          has concrete values.
        - Applies on AC: sleep = never, hibernate = off (also disables Fast Startup,
          intentional), lid close = "Do nothing".
        - Disables per-NIC power management (powercfg does not cover this) for each
          physical, Up network adapter, via Disable-NetAdapterPowerManagement where
          available, falling back to the PnPCapabilities registry value, with a
          read-back confirmation either way. If neither works, prints the exact
          Device Manager path as a required manual step - never silently continues.

    (b) Flips the 3 existing scheduled tasks (name list below) to
        "Run whether user is logged on or not" (LogonType=Password), keeping RunLevel
        as-is, unchecks "Stop if the computer switches to battery power"
        (DontStopIfGoingOnBatteries) and checks "Wake the computer to run this task"
        (WakeToRun). Prompts for the account password ONCE via Get-Credential; the
        password is never written to disk, logged, or echoed - only held in memory for
        the duration of the Set-ScheduledTask call. Task Scheduler stores it DPAPI-encrypted.
        Existing task objects (from Get-ScheduledTask) are mutated in place and passed back
        via Set-ScheduledTask - New-ScheduledTaskSettingsSet is never used, so nothing
        else about the tasks is reset to defaults.

    (c) Read-back assertion: after applying, re-reads all three tasks and asserts each
        has LogonType=Password. Fails loudly (non-zero exit) listing any task that did
        not take - never a silent 2-of-3.

    Idempotent: safe to re-run. Already-correct settings are detected and reported as
    "already set" rather than re-applied. Only edits the three named tasks (no create/delete).
    Does not touch .cmd runners, base_connector.py, sessions\, .env, or config\deployment.json.

.NOTES
    Must be run from an elevated ("Run as Administrator") Windows PowerShell 5.1 session -
    both the powercfg/NIC changes and the scheduled-task -Principal change require it.
    This script only CONFIGURES the machine/tasks - it does not run any connector, does not
    reboot, and does not touch the network live beyond the local power/NIC/task-scheduler
    settings described above.
#>

[CmdletBinding()]
param()

# ----------------------------------------------------------------------------
# Setup: paths, logging helpers, elevation check
# ----------------------------------------------------------------------------

$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Write-SectionHeader {
    param([string]$Title)
    Write-Host ""
    Write-Host "===== $Title =====" -ForegroundColor Cyan
}
function Write-Info { param([string]$Msg) Write-Host "  $Msg" -ForegroundColor Gray }
function Write-Ok   { param([string]$Msg) Write-Host "  [OK] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "  [!]  $Msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$Msg) Write-Host "  [FAIL] $Msg" -ForegroundColor Red }

function Test-IsElevated {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

Write-Host ""
Write-Host "LEIBLE Expense Collector - Always-On Setup" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot"

if (-not (Test-IsElevated)) {
    Write-Host ""
    Write-Host "ERROR: This script must be run from an ELEVATED PowerShell session." -ForegroundColor Red
    Write-Host "  Both the power configuration (powercfg / NIC power management) and the" -ForegroundColor Red
    Write-Host "  scheduled-task principal change (-Principal / -User /-Password) require admin rights." -ForegroundColor Red
    Write-Host "  Right-click PowerShell -> 'Run as Administrator', then re-run this script:" -ForegroundColor Red
    Write-Host "    $PSCommandPath" -ForegroundColor Red
    Write-Host ""
    Write-Host "Nothing was changed (failing before any change, not half-applying)." -ForegroundColor Red
    exit 1
}
Write-Ok "Running elevated - proceeding."

$script:Failures            = New-Object System.Collections.Generic.List[string]
$script:ManualStepsRequired = New-Object System.Collections.Generic.List[string]

# ----------------------------------------------------------------------------
# Helper: extract the "Current AC Power Setting Index" hex value from a
# `powercfg /query ...` text block.
# ----------------------------------------------------------------------------
function Get-AcHexValue {
    param([string[]]$QueryOutput)
    $line = $QueryOutput | Where-Object { $_ -match 'Current AC Power Setting Index:\s*0x([0-9A-Fa-f]+)' } | Select-Object -First 1
    if ($line -and $line -match '0x([0-9A-Fa-f]+)') {
        return [Convert]::ToInt64($Matches[1], 16)
    }
    return $null
}

# ==============================================================================
# SECTION 1: Snapshot power baseline (for rollback)
# ==============================================================================
Write-SectionHeader "SECTION 1: Snapshot power baseline (for rollback)"

$logsDir = Join-Path $ProjectRoot "logs"
if (-not (Test-Path $logsDir)) {
    New-Item -Path $logsDir -ItemType Directory -Force | Out-Null
}

$timestamp    = Get-Date -Format "yyyyMMdd_HHmmss"
$baselineFile = Join-Path $logsDir "power_baseline_$timestamp.txt"

$powercfgQueryFull = powercfg /query
$standbyRaw         = powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
$lidRaw             = powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION
$hibernateRaw       = powercfg /a

$standbySecondsBaseline = Get-AcHexValue $standbyRaw
$standbyMinutesBaseline = if ($null -ne $standbySecondsBaseline) { [math]::Round($standbySecondsBaseline / 60) } else { $null }
$lidValueBaseline       = Get-AcHexValue $lidRaw
$hibernateOffBaseline   = (($hibernateRaw -join "`n") -match 'not been enabled|does not support')

$baselineContent = @()
$baselineContent += "LEIBLE Expense Collector - Power Baseline Snapshot"
$baselineContent += "Captured: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')"
$baselineContent += "Machine: $env:COMPUTERNAME"
$baselineContent += ""
$baselineContent += "--- Parsed values (for rollback) ---"
$baselineContent += "standby-timeout-ac (AC sleep timer), seconds: $standbySecondsBaseline"
$baselineContent += "standby-timeout-ac (AC sleep timer), minutes (rounded, for rollback command): $standbyMinutesBaseline"
$baselineContent += "Rollback: powercfg /change standby-timeout-ac $standbyMinutesBaseline"
$baselineContent += ""
$baselineContent += "Lid action (AC), raw index: $lidValueBaseline  (0=Do nothing, 1=Sleep, 2=Hibernate, 3=Shut down)"
$baselineContent += "Rollback (only if baseline index above was not 0): powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION $lidValueBaseline ; powercfg /setactive SCHEME_CURRENT"
$baselineContent += ""
$baselineContent += "Hibernate already OFF at baseline: $hibernateOffBaseline"
$baselineContent += "Rollback (only if baseline had hibernate ON, i.e. the line above is False): powercfg /hibernate on"
$baselineContent += ""
$baselineContent += "--- Raw: powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE ---"
$baselineContent += $standbyRaw
$baselineContent += ""
$baselineContent += "--- Raw: powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION ---"
$baselineContent += $lidRaw
$baselineContent += ""
$baselineContent += "--- Raw: powercfg /a (hibernate / sleep states) ---"
$baselineContent += $hibernateRaw
$baselineContent += ""
$baselineContent += "--- Raw: powercfg /query (full current scheme) ---"
$baselineContent += $powercfgQueryFull

$baselineContent | Out-File -FilePath $baselineFile -Encoding utf8

Write-Ok "Baseline snapshot written: $baselineFile"

# ==============================================================================
# SECTION 2: Apply power settings (sleep=never, hibernate=off, lid=do nothing, on AC)
# ==============================================================================
Write-SectionHeader "SECTION 2: Apply power settings (AC: sleep=never, hibernate=off, lid=do nothing)"

if ($standbySecondsBaseline -eq 0) {
    Write-Ok "standby-timeout-ac already 0 (Never) - already set, skipping."
} else {
    powercfg /change standby-timeout-ac 0
    Write-Ok "Set standby-timeout-ac = 0 (Never) [was $standbySecondsBaseline sec / ~$standbyMinutesBaseline min]"
}

if ($hibernateOffBaseline) {
    Write-Ok "Hibernate already off - already set, skipping."
} else {
    powercfg /hibernate off
    Write-Ok "Hibernate set to off (also disables Fast Startup - intentional)."
}

if ($lidValueBaseline -eq 0) {
    Write-Ok "Lid action (AC) already 'Do nothing' - already set, skipping."
} else {
    powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
    powercfg /setactive SCHEME_CURRENT
    Write-Ok "Lid action (AC) set to 'Do nothing' [was index $lidValueBaseline]"
}

# ==============================================================================
# SECTION 3: Disable per-NIC power management (physical, Up adapters)
# ==============================================================================
Write-SectionHeader "SECTION 3: Disable per-NIC power management (physical, Up adapters)"
Write-Info "powercfg does not control this - it is a per-NIC driver setting."

$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and -not $_.Virtual })

if ($adapters.Count -eq 0) {
    Write-Info "No physical 'Up' network adapters found - nothing to change."
} else {
    $hasDisableCmdlet = [bool](Get-Command -Name Disable-NetAdapterPowerManagement -ErrorAction SilentlyContinue)
    if (-not $hasDisableCmdlet) {
        Write-Warn "Disable-NetAdapterPowerManagement cmdlet not available on this system - will use registry fallback for every adapter."
    }

    foreach ($adapter in $adapters) {
        $name = $adapter.Name
        Write-Info "Adapter: $name ($($adapter.InterfaceDescription))"
        $confirmed = $false
        $classPath = $null

        # Resolve the adapter's registry Class key (ground truth for the Device Manager
        # "Power Management" tab checkboxes via the PnPCapabilities value).
        try {
            $pnpId     = $adapter.PnPDeviceID
            $driverKey = (Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Enum\$pnpId" -Name Driver -ErrorAction Stop).Driver
            $classPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\$driverKey"
        } catch {
            Write-Warn "Could not resolve registry Class key for '$name': $($_.Exception.Message)"
        }

        # Idempotency: check current state first.
        if ($classPath) {
            $current = (Get-ItemProperty -Path $classPath -Name PnPCapabilities -ErrorAction SilentlyContinue).PnPCapabilities
            if ($current -eq 24) {
                Write-Ok "Already set: PnPCapabilities = 24 (power-off + wake disabled) - skipping."
                $confirmed = $true
            }
        }

        # Try the cmdlet path first (as named in the plan), then re-check via registry.
        if (-not $confirmed -and $hasDisableCmdlet) {
            try {
                Disable-NetAdapterPowerManagement -Name $name -Confirm:$false -ErrorAction Stop
                Write-Info "Ran Disable-NetAdapterPowerManagement for '$name'."
            } catch {
                Write-Warn "Disable-NetAdapterPowerManagement failed for '$name': $($_.Exception.Message)"
            }
            if ($classPath) {
                $recheck = (Get-ItemProperty -Path $classPath -Name PnPCapabilities -ErrorAction SilentlyContinue).PnPCapabilities
                if ($recheck -eq 24) {
                    Write-Ok "Confirmed via registry read-back after cmdlet: PnPCapabilities = 24."
                    $confirmed = $true
                }
            }
        }

        # Registry fallback, with read-back.
        if (-not $confirmed -and $classPath) {
            try {
                Set-ItemProperty -Path $classPath -Name PnPCapabilities -Value 24 -Type DWord -ErrorAction Stop
                $readback = (Get-ItemProperty -Path $classPath -Name PnPCapabilities -ErrorAction Stop).PnPCapabilities
                if ($readback -eq 24) {
                    Write-Ok "Applied + confirmed via registry: PnPCapabilities = 24."
                    $confirmed = $true
                } else {
                    Write-Warn "Registry read-back mismatch for '$name' (got $readback, expected 24)."
                }
            } catch {
                Write-Warn "Registry write failed for '$name': $($_.Exception.Message)"
            }
        }

        if (-not $confirmed) {
            $manualStep = "Device Manager > Network adapters > $($adapter.InterfaceDescription) > Properties > Power Management tab > uncheck 'Allow the computer to turn off this device to save power'"
            Write-Fail "Could not disable power management headlessly for '$name'."
            Write-Fail "MANUAL STEP REQUIRED: $manualStep"
            $script:ManualStepsRequired.Add("$name -- $manualStep")
        }
    }
}

# ==============================================================================
# SECTION 4: Reconfigure scheduled tasks (run whether logged on or not)
# ==============================================================================
Write-SectionHeader "SECTION 4: Reconfigure scheduled tasks (run whether logged on or not)"

$taskNames = @(
    "LEIBLE Expense - Food and Dairy Co",
    "LEIBLE Expense - Ordermentum",
    "LEIBLE Expense - Fresh and Chill"
)

$taskObjects  = @{}
$missingTasks = New-Object System.Collections.Generic.List[string]

foreach ($tn in $taskNames) {
    $t = Get-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue
    if ($null -eq $t) {
        Write-Fail "Task not found: '$tn'. Confirm the exact name in Task Scheduler Library and re-run."
        $missingTasks.Add($tn)
    } else {
        $taskObjects[$tn] = $t
        Write-Info "Found task: '$tn' (path: $($t.TaskPath))"
    }
}

if ($missingTasks.Count -gt 0) {
    foreach ($mt in $missingTasks) { $script:Failures.Add("$mt : task not found") }
}

# Only prompt for a credential if at least one present task actually needs its
# LogonType changed - tasks that only need the Conditions update don't need it.
$needsCredential = $false
foreach ($tn in $taskObjects.Keys) {
    if ($taskObjects[$tn].Principal.LogonType -ne 'Password') { $needsCredential = $true }
}

$cred = $null
if ($needsCredential) {
    Write-Info "At least one task needs LogonType changed to 'Password' (run whether logged on or not)."
    Write-Info "Enter the Windows sign-in password for the account these tasks should run as."
    Write-Info "Nothing is stored to disk by this script - Task Scheduler stores the credential DPAPI-encrypted."
    $cred = Get-Credential -UserName "MicrosoftAccount\mio.jake@gmail.com" `
        -Message "LEIBLE Expense tasks: Windows account password (accept or edit the username)"
    if ($null -eq $cred) {
        Write-Fail "No credential supplied - task principal changes will be skipped."
        $script:Failures.Add("Task reconfiguration: no credential supplied.")
    }
}

foreach ($tn in $taskNames) {
    if ($missingTasks -contains $tn) { continue }
    $task = $taskObjects[$tn]
    Write-Info "Task: '$tn'"

    $currentLogonType  = $task.Principal.LogonType
    # NOTE: the CIM settings object exposes the INVERTED property StopIfGoingOnBatteries
    # (the cmdlet parameter DontStopIfGoingOnBatteries does NOT exist as a property and
    # throws on assignment). "Don't stop on battery" == StopIfGoingOnBatteries = $false.
    $currentStopOnBatt = $task.Settings.StopIfGoingOnBatteries
    $currentWakeToRun  = $task.Settings.WakeToRun

    $logonAlreadyOk      = ($currentLogonType -eq 'Password')
    $conditionsAlreadyOk = ($currentStopOnBatt -eq $false -and $currentWakeToRun -eq $true)

    if ($logonAlreadyOk -and $conditionsAlreadyOk) {
        Write-Ok "Already set: LogonType=Password, StopIfGoingOnBatteries=False, WakeToRun=True - skipping."
        continue
    }

    if (-not $logonAlreadyOk -and $null -eq $cred) {
        Write-Fail "'$tn' needs LogonType=Password but no credential is available - skipped."
        $script:Failures.Add("$tn : LogonType not changed (no credential).")
        continue
    }

    # Mutate the EXISTING settings object read from Get-ScheduledTask - never
    # New-ScheduledTaskSettingsSet, which would reset everything else to defaults.
    $settings = $task.Settings
    $settings.StopIfGoingOnBatteries = $false   # uncheck "Stop if the computer switches to battery power"
    $settings.WakeToRun = $true

    try {
        if (-not $logonAlreadyOk) {
            $plainPassword = $cred.GetNetworkCredential().Password
            try {
                Set-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath `
                    -Settings $settings -User $cred.UserName -Password $plainPassword `
                    -ErrorAction Stop | Out-Null
            } finally {
                $plainPassword = $null
            }
        } else {
            # LogonType already correct - only Conditions need updating, no credential needed.
            Set-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath `
                -Settings $settings -ErrorAction Stop | Out-Null
        }
        Write-Ok "Applied: LogonType=Password, battery-stop unchecked, wake-to-run checked."
    } catch {
        Write-Fail "Set-ScheduledTask failed for '$tn': $($_.Exception.Message)"
        $script:Failures.Add("$tn : Set-ScheduledTask failed - $($_.Exception.Message)")
    }
}

$cred = $null

# ==============================================================================
# SECTION 5: Read-back assertion (all 3 tasks must show LogonType=Password)
# ==============================================================================
Write-SectionHeader "SECTION 5: Read-back assertion (all 3 tasks must show LogonType=Password)"

$assertFailures = New-Object System.Collections.Generic.List[string]

foreach ($tn in $taskNames) {
    $t = Get-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue
    if ($null -eq $t) {
        Write-Fail "'$tn' : NOT FOUND"
        $assertFailures.Add("$tn : task not found")
        continue
    }
    if ($t.Principal.LogonType -eq 'Password') {
        Write-Ok "'$tn' : LogonType=Password (confirmed)"
    } else {
        Write-Fail "'$tn' : LogonType=$($t.Principal.LogonType) (expected Password)"
        $assertFailures.Add("$tn : LogonType=$($t.Principal.LogonType)")
    }
}

if ($assertFailures.Count -gt 0) {
    Write-Host ""
    Write-Host "ASSERTION FAILED - not all 3 tasks ended up with LogonType=Password:" -ForegroundColor Red
    foreach ($f in $assertFailures) { Write-Host "  - $f" -ForegroundColor Red }
}

# ==============================================================================
# SUMMARY
# ==============================================================================
Write-SectionHeader "SUMMARY"

Write-Host "  Power baseline file : $baselineFile"

if ($script:ManualStepsRequired.Count -gt 0) {
    Write-Host ""
    Write-Host "  Manual steps required (NIC power management could not be set headlessly):" -ForegroundColor Yellow
    foreach ($m in $script:ManualStepsRequired) { Write-Host "    - $m" -ForegroundColor Yellow }
}

$allFailures = New-Object System.Collections.Generic.List[string]
$allFailures.AddRange($script:Failures)
$allFailures.AddRange($assertFailures)
foreach ($m in $script:ManualStepsRequired) { $allFailures.Add("NIC manual step pending: $m") }

if ($allFailures.Count -gt 0) {
    Write-Host ""
    Write-Host "  RESULT: FAILED / INCOMPLETE - $($allFailures.Count) item(s) need attention:" -ForegroundColor Red
    foreach ($f in $allFailures) { Write-Host "    - $f" -ForegroundColor Red }
    Write-Host ""
    Write-Host "  Fix the above and re-run this script (it is safe to re-run - already-correct" -ForegroundColor Red
    Write-Host "  settings are detected and skipped)." -ForegroundColor Red
    exit 1
} else {
    Write-Host ""
    Write-Host "  RESULT: DONE - power config applied/confirmed, all 3 tasks confirmed LogonType=Password." -ForegroundColor Green
    exit 0
}
