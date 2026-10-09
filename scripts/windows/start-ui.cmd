@echo off
rem Starts the PR Review Assistant web UI. Used by install-autostart.ps1, and fine to double-click.
rem Ollama's own Windows installer already starts Ollama at login; this only starts the UI.
cd /d "%~dp0\..\.."
title PR Review Assistant

rem Use the same port as the server: PR_REVIEW_UI_PORT from .env, otherwise 4500.
set "UI_PORT=4500"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b "PR_REVIEW_UI_PORT=" ".env"`) do if not "%%b"=="" set "UI_PORT=%%b"
)

rem Open the page a few seconds from now, once the server is up.
start "" /b cmd /c "ping -n 7 127.0.0.1 >nul & start http://127.0.0.1:%UI_PORT%"
call npm run ui
echo.
echo The UI stopped (or could not start - read the message above). Press any key to close this window.
pause >nul
