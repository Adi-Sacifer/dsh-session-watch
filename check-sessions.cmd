@echo off
rem check-sessions.cmd - one-click cross-session stuck check (read-only).
rem
rem Double-click it, or run it from anywhere:
rem     check-sessions.cmd
rem     check-sessions.cmd --minutes 240 --stale 300
rem
rem Finds Node in this order: PATH, then a bundled DSH runtime on Windows.
rem No delayed expansion is used anywhere here, on purpose: paths ending in a backslash would
rem otherwise be mangled by quotes inside an expanded variable.
setlocal

where node >nul 2>nul
if not errorlevel 1 (
  node "%~dp0scripts\probe-sessions.mjs" %*
  goto :done
)

set "BUNDLED=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if exist "%BUNDLED%" (
  "%BUNDLED%" "%~dp0scripts\probe-sessions.mjs" %*
  goto :done
)

echo [check-sessions] Node was not found on PATH, and there is no bundled DSH runtime at:
echo     %BUNDLED%
echo Install Node 22 or newer, then run this again.

:done
echo.
pause
