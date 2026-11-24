@echo off
cd /d "%~dp0.."
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0configure-notion.ps1"
if errorlevel 1 echo Configuration failed. No success was confirmed.
pause
