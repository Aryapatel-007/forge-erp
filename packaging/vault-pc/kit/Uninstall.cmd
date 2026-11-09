@echo off
rem Removes the Forge Vault Explorer badges and the SOLIDWORKS add-in.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall
