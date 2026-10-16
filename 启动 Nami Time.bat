@echo off
setlocal
cd /d "%~dp0"

rem ---- Nami Time launcher ----
rem ASCII-only on purpose: cmd codepage may be 936 or 65001, and mixing them garbles text.

if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] Electron runtime not found.
  echo Please open a terminal in this folder and run:  npm install
  echo.
  pause
  exit /b 1
)

rem %~dp0 ends with a backslash; appending "." avoids the trailing \" escape bug.
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0