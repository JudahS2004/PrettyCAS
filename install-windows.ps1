# Builds PrettyCAS with PyInstaller and installs it as a real Start Menu
# app for the current user -- no admin rights needed. Re-run this any time
# after changing source or swapping icon.svg/icon.png/icon.ico for your
# own art (same three filenames, so nothing else needs updating).
#
# First-time setup (once venv + requirements are in place, just re-run
# this script for every rebuild):
#   cd path\to\PrettyCAS
#   python -m venv backend\.venv
#   backend\.venv\Scripts\pip install -r backend\requirements.txt
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Building with PyInstaller..."
& backend\.venv\Scripts\pyinstaller.exe --noconfirm prettycas.spec

$InstallDir = "$env:LOCALAPPDATA\PrettyCAS"
$StartMenuDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"

Write-Host "Installing to $InstallDir..."
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
Copy-Item -Recurse "dist\PrettyCAS" $InstallDir

$ShortcutPath = "$StartMenuDir\PrettyCAS.lnk"
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "$InstallDir\PrettyCAS.exe"
$Shortcut.WorkingDirectory = $InstallDir
$Shortcut.IconLocation = "$InstallDir\PrettyCAS.exe"
$Shortcut.Description = "Symbolic computation and graphing"
$Shortcut.Save()

Write-Host "Installed. PrettyCAS should now show up in your Start Menu."
