@echo off
REM Double-click test runner for dsh-session-watch.
REM
REM Why this exists: the whole point of this repo is answering "is it stuck, or just idle",
REM and that is not a question you can settle by reading the code. This runs every test in
REM test\ and prints a report in plain Chinese, so verifying the watchdog does not require
REM opening a terminal or knowing npm.
REM
REM It uses python (always present on this machine, including the runtime bundled under .dsh)
REM rather than node directly, because that way it can find node itself, one test at a time,
REM and still write the report to a file if the window is closed early.
chcp 65001 >nul
setlocal
title dsh-session-watch test

set "OUTDIR=%~dp0"
set "PY=%OUTDIR%run-tests.py"
set "REPORT=%OUTDIR%sw-suite.txt"

echo ============================================================
echo   dsh-session-watch   test / verify
echo ============================================================
echo.

if not exist "%PY%" (
  echo ERROR: run-tests.py is missing next to this file.
  echo   expected: %PY%
  goto end
)

set "PYCMD="
where python >nul 2>nul && set "PYCMD=python"
if not defined PYCMD ( where py >nul 2>nul && set "PYCMD=py" )
if not defined PYCMD (
  if exist "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" (
    set "PYCMD=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
  )
)
if not defined PYCMD (
  echo ERROR: no python found on this machine.
  echo   Looked for: python, py, and the bundled runtime under .dsh
  goto end
)

echo Using: %PYCMD%
echo.

"%PYCMD%" "%PY%" 2>&1 | more

echo.
echo ============================================================
echo   done
echo ============================================================
if exist "%REPORT%" (
  echo Report file:
  echo   %REPORT%
) else (
  echo NOTE: the report file was not written; see the console output above.
)

:end
echo.
echo Press any key to close this window...
pause >nul
endlocal
