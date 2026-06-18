@echo off
REM Scheduled runner for the Ordermentum connector.
REM Register with Windows Task Scheduler (daily recommended).
REM On expired session, exits code 2 — check Task Scheduler history or the log.

cd /d "%~dp0.."

REM Load env from .env if present (GAS_EXEC_URL, etc.)
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        if not "%%A"=="" if not "%%A:~0,1%"=="#" set "%%A=%%B"
    )
)

python connectors\playwright\ordermentum.py 2>> logs\ordermentum.log

set EXIT_CODE=%ERRORLEVEL%

if %EXIT_CODE% equ 2 (
    echo [%date% %time%] BLOCKED — session expired, run --attended to re-login >> logs\ordermentum.log
    echo Ordermentum session expired. Run: python connectors\playwright\ordermentum.py --attended
)

exit /b %EXIT_CODE%
