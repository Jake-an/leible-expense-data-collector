<#
.SYNOPSIS
  One-click weekly BrightHR roster ingest. Export the CSV, run this, press y.

.DESCRIPTION
  - Finds the newest rota*.csv in Downloads (or the one dragged onto Post-Roster.cmd).
  - First run: generates the roster token (.roster-token.txt, git-ignored), copies it to the
    clipboard, shows only a fingerprint, and clears the clipboard after you confirm the paste.
  - Shows a dry-run summary, asks to confirm, then posts to the collector (and, while
    ALSO_POST_ONBOARDING is True, to the legacy Onboarding endpoint). Each result is shown.

  Weekly routine: BrightHR > Reports > Roster > "Roster Details" > pick the week >
  Generate CSV > double-click Post-Roster.cmd > press y. Re-run after any roster change.

.PARAMETER CsvPath
  Optional. A specific CSV to ingest. If omitted, the newest Downloads\rota*.csv is used.
#>
[CmdletBinding()]
param([string]$CsvPath)

$ErrorActionPreference = 'Stop'
$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

function Pause-Exit($code) {
  Read-Host "`nPress Enter to close"
  exit $code
}

try {
  $py = $null
  foreach ($cand in @('python', 'py')) {
    if (Get-Command $cand -ErrorAction SilentlyContinue) { $py = $cand; break }
  }
  if (-not $py) {
    Write-Host 'Python not found on PATH. Install Python, then re-run.' -ForegroundColor Red
    Pause-Exit 1
  }

  $script = Join-Path $root 'post_roster.py'

  # First run: create the token, then stop so the Script Property can be set.
  $tokenFile = Join-Path $root '.roster-token.txt'
  if (-not (Test-Path $tokenFile)) {
    Write-Host 'First run: creating the roster token.' -ForegroundColor Yellow
    & $py $script --init-token
    if ($LASTEXITCODE -ne 0) { Write-Host 'Token setup failed.' -ForegroundColor Red; Pause-Exit $LASTEXITCODE }
    Write-Host 'Token ready. Re-run this shortcut once the Script Property is set.' -ForegroundColor Green
    Pause-Exit 0
  }

  if (-not $CsvPath) {
    $downloads = Join-Path $env:USERPROFILE 'Downloads'
    $latest = Get-ChildItem -Path $downloads -Filter 'rota*.csv' -File -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) {
      Write-Host "No rota*.csv found in $downloads." -ForegroundColor Red
      Write-Host 'Export it from BrightHR (Reports > Roster > Roster Details), or drag the CSV onto Post-Roster.cmd.' -ForegroundColor DarkGray
      Pause-Exit 1
    }
    $CsvPath = $latest.FullName
    Write-Host ("Using newest Downloads CSV: {0}  ({1})" -f $latest.Name, $latest.LastWriteTime) -ForegroundColor Cyan
  } else {
    if (-not (Test-Path $CsvPath)) { Write-Host "CSV not found: $CsvPath" -ForegroundColor Red; Pause-Exit 1 }
    Write-Host "Using CSV: $CsvPath" -ForegroundColor Cyan
  }

  Write-Host "`n--- Preview (dry-run) ---" -ForegroundColor DarkGray
  & $py $script $CsvPath --dry-run
  if ($LASTEXITCODE -ne 0) { Write-Host 'Parse failed - see above.' -ForegroundColor Red; Pause-Exit $LASTEXITCODE }

  Write-Host ''
  $go = Read-Host 'Post these shifts? (y/n)'
  if ($go -ne 'y' -and $go -ne 'Y') { Write-Host 'Aborted - nothing posted.' -ForegroundColor Yellow; Pause-Exit 0 }

  Write-Host "`n--- Posting ---" -ForegroundColor DarkGray
  & $py $script $CsvPath
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    Write-Host "`nDone." -ForegroundColor Green
  } else {
    Write-Host "`nA post failed (exit $code) - see the red line above. Re-run the shortcut." -ForegroundColor Red
  }
  Pause-Exit $code
}
catch {
  Write-Host "`nError: $($_.Exception.Message)" -ForegroundColor Red
  Pause-Exit 1
}
