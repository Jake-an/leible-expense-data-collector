@echo off
REM Double-click to ingest the newest Downloads\rota*.csv, or drag a CSV onto this file.
REM Runs Post-Roster.ps1 (bypassing the PS execution policy for this one process only).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Post-Roster.ps1" %*
