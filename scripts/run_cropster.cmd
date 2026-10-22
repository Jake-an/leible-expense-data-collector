@echo off
REM Scheduled runner for the Cropster (roasting production) connector.
REM Registered weekly (Mon 05:30) by scripts\register_cropster_task.ps1.
REM On expired session / CAPTCHA, exits code 2 -- check Task Scheduler history or the log.

cd /d "%~dp0.."

if not exist logs mkdir logs

REM Load env from .env if present. `eol=#` skips comment lines. The connector also
REM resolves its own credentials via get_credential, so this is an override hook.
if exist .env (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
        if not "%%A"=="" set "%%A=%%B"
    )
)

set "LOG=logs\cropster.log"
echo ===== [%DATE% %TIME%] run_cropster start ===== >> "%LOG%"
python -u connectors\playwright\cropster.py >> "%LOG%" 2>&1
set EXIT_CODE=%ERRORLEVEL%
echo ===== [%DATE% %TIME%] run_cropster exit=%EXIT_CODE% ===== >> "%LOG%"

if %EXIT_CODE% equ 2 (
    echo [%date% %time%] BLOCKED -- Cropster session expired or CAPTCHA, run --attended to re-login >> "%LOG%"
    echo Cropster session expired. Run: python connectors\playwright\cropster.py --attended
)

exit /b %EXIT_CODE%
