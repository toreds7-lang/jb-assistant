@echo off
rem Todoro launcher: starts the tray icon (which runs the server with no console
rem window) and opens the app window. If Todoro is already in the tray, this just
rem brings its window forward. To run the server in a console instead:
rem   node server.mjs --open
start "" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tray.ps1" -Open
