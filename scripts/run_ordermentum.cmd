@echo off
REM Scheduled runner for the Ordermentum connector.
REM Register with Windows Task Scheduler (daily recommended).
REM On expired session, exits code 2 -- check Task Scheduler history or the log.

cd /d "%~dp0.."

if not exist logs mkdir logs

REM Load env from .env if present. `eol=#` is how for /f skips comments -- the old
REM `if not "%%A:~0,1%"=="#"` had a stray % that broke the parser at block-parse
REM time, so every run exited 255 and python never started. With deployment.json
REM as base_connector's fallback this loader is now an override hook, not load-bearing.
if exist .env (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
        if not "%%A"=="" set "%%A=%%B"
    )
)

set "LOG=logs\ordermentum.log"
echo ===== [%DATE% %TIME%] run_ordermentum start ===== >> "%LOG%"
python -u connectors\playwright\ordermentum.py >> "%LOG%" 2>&1
set EXIT_CODE=%ERRORLEVEL%
echo ===== [%DATE% %TIME%] run_ordermentum exit=%EXIT_CODE% ===== >> "%LOG%"

if %EXIT_CODE% equ 2 (
    echo [%date% %time%] BLOCKED -- session expired, run --attended to re-login >> "%LOG%"
    echo Ordermentum session expired. Run: python connectors\playwright\ordermentum.py --attended
)

exit /b %EXIT_CODE%
