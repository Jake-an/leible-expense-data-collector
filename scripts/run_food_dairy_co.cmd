@echo off
REM Scheduled runner for the Food and Dairy Co (Pepper) connector.
REM Register with Windows Task Scheduler (daily recommended).
REM On expired session, exits code 2 — check Task Scheduler history or the log.

cd /d "%~dp0.."

REM Load env from .env if present (GAS_EXEC_URL, etc.)
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        if not "%%A"=="" if not "%%A:~0,1%"=="#" set "%%A=%%B"
    )
)

python connectors\playwright\food_dairy_co.py 2>> logs\food_dairy_co.log

set EXIT_CODE=%ERRORLEVEL%

if %EXIT_CODE% equ 2 (
    echo [%date% %time%] BLOCKED — session expired, run --attended to re-login >> logs\food_dairy_co.log
    echo Food and Dairy Co session expired. Run: python connectors\playwright\food_dairy_co.py --attended
)

exit /b %EXIT_CODE%
