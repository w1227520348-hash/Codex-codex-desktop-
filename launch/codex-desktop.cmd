@echo off
rem ============================================================
rem  Codex Cockpit - universal launcher
rem  Works from any directory; the given folder becomes the workspace:
rem      codex-desktop            -> reuse last workspace
rem      codex-desktop .          -> use the current directory
rem      codex-desktop D:\repo    -> use that directory
rem  (Messages are ASCII on purpose: cmd.exe codepage would garble CJK.)
rem ============================================================
setlocal EnableDelayedExpansion

rem Resolve the app root (this file lives in <app>\launch\)
for %%I in ("%~dp0..") do set "APP_DIR=%%~fI"
set "ENTRY=%APP_DIR%\out\main\index.js"
set "ELECTRON=%APP_DIR%\node_modules\electron\dist\electron.exe"

if not exist "%ENTRY%" (
  echo [codex-desktop] Build output missing; building for the first run...
  pushd "%APP_DIR%"
  call npm run build
  popd
  if not exist "%ENTRY%" (
    echo [codex-desktop] Build failed. Run: cd /d "%APP_DIR%" ^&^& npm install ^&^& npm run build
    exit /b 1
  )
)

if not exist "%ELECTRON%" (
  echo [codex-desktop] Electron runtime missing; downloading via npmmirror...
  pushd "%APP_DIR%"
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  node "node_modules\electron\install.js"
  popd
  if not exist "%ELECTRON%" (
    echo [codex-desktop] Electron runtime unavailable. Run manually:
    echo   cd /d "%APP_DIR%"
    echo   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    echo   node node_modules\electron\install.js
    exit /b 1
  )
)

rem Forward the folder argument as an absolute path ("." resolves to the caller's cwd)
if "%~1"=="" (
  start "" "%ELECTRON%" "%ENTRY%"
) else (
  for %%I in ("%~1") do set "WORKDIR=%%~fI"
  start "" "%ELECTRON%" "%ENTRY%" "!WORKDIR!"
)

exit /b 0
