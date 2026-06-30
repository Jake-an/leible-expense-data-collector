@echo off
REM Scheduled runner for the Fresh and Chill (Zupply) connector.
REM Register with Windows Task Scheduler (daily recommended).
REM One unattended run loops all 4 shops from saved sessions.
REM On expired session, exits code 2 — check Task Scheduler history or the log.

cd /d "%~dp0.."

if not exist logs mkdir logs

REM Load env from .env if present (GAS_EXEC_URL, etc.)
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        if not "%%A"=="" if not "%%A:~0,1%"=="#" set "%%A=%%B"
    )
)

python connectors\playwright\fresh_and_chill.py 2>> logs\fresh_and_chill.log

set EXIT_CODE=%ERRORLEVEL%

if %EXIT_CODE% equ 2 (
    echo [%date% %time%] BLOCKED — session expired, run --attended --shop ^<york^|north^|crowsnest^|pitt^> to re-login >> logs\fresh_and_chill.log
    echo Fresh and Chill session expired. Run: python connectors\playwright\fresh_and_chill.py --attended --shop york  ^(repeat per shop^)
)

exit /b %EXIT_CODE%
