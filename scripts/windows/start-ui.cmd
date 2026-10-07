@echo off
rem Starts the PR Review Assistant web UI. Used by install-autostart.ps1, and fine to double-click.
rem Ollama's own Windows installer already starts Ollama at login; this only starts the UI.
cd /d "%~dp0\..\.."
title PR Review Assistant
rem Open the page a few seconds from now, once the server is up.
start "" /b cmd /c "ping -n 7 127.0.0.1 >nul & start http://127.0.0.1:4500"
call npm run ui
echo.
echo The UI stopped. Press any key to close this window.
pause >nul
