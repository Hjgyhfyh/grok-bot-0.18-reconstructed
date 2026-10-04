@echo off
rem Turnkey launcher: injects DPAPI-protected credentials, then starts the app.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-grokbot.ps1"
