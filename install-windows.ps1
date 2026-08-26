# Sets up dependencies (Python virtual environment, pip packages, npm
# packages -- each step skipped if it's already done and up to date),
# builds PrettyCAS with PyInstaller, and installs it as a real Start Menu
# app for the current user -- no admin rights needed. Re-run this any time
# after changing source, backend\requirements.txt, frontend\package.json,
# or swapping icons\icon.svg / icons\icon.png / icons\icon.ico for your own
# art (same three filenames, so nothing else needs updating).

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Fail($message) {
    Write-Host "error: $message" -ForegroundColor Red
    exit 1
}

$VenvDir = "backend\.venv"
$Requirements = "backend\requirements.txt"
$ReqStamp = "$VenvDir\.requirements.sha256"
$NodeStamp = "frontend\node_modules\.install.sha256"

# --- Python virtual environment (skip if it already exists) ---
if (-not (Test-Path "$VenvDir\Scripts\python.exe")) {
    Write-Host "Setting up Python virtual environment..."
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
        Fail "python not found. Install Python 3.10+ (https://www.python.org/downloads/) and make sure 'Add python.exe to PATH' was checked during install, then re-run this script."
    }
    & python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -Recurse -Force $VenvDir -ErrorAction SilentlyContinue
        Fail "couldn't create the virtual environment. Re-run 'python -m venv $VenvDir' directly to see the full error."
    }
}

# --- Python packages (re-installed only when requirements.txt changed) ---
if (-not (Test-Path $Requirements)) { Fail "$Requirements not found -- is this script running from the repo root?" }
$ReqHash = (Get-FileHash $Requirements -Algorithm SHA256).Hash
$OldReqHash = if (Test-Path $ReqStamp) { Get-Content $ReqStamp -ErrorAction SilentlyContinue } else { $null }
if ($OldReqHash -ne $ReqHash) {
    Write-Host "Installing Python packages..."
    & "$VenvDir\Scripts\pip.exe" install -r $Requirements
    if ($LASTEXITCODE -ne 0) { Fail "pip install failed (see output above). Fix the issue and re-run this script." }
    Set-Content -Path $ReqStamp -Value $ReqHash
}

# --- npm packages (re-installed only when package.json changed) ---
$PkgHash = (Get-FileHash "frontend\package.json" -Algorithm SHA256).Hash
$OldPkgHash = if (Test-Path $NodeStamp) { Get-Content $NodeStamp -ErrorAction SilentlyContinue } else { $null }
if ((-not (Test-Path "frontend\node_modules")) -or ($OldPkgHash -ne $PkgHash)) {
    Write-Host "Installing frontend packages..."
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Fail "npm not found. Install Node.js (https://nodejs.org) and make sure it's on your PATH, then re-run this script."
    }
    Push-Location frontend
    & npm install
    $NpmExitCode = $LASTEXITCODE
    Pop-Location
    if ($NpmExitCode -ne 0) { Fail "npm install failed (see output above). Fix the issue and re-run this script." }
    Set-Content -Path $NodeStamp -Value $PkgHash
}

Write-Host "Building with PyInstaller..."
& "$VenvDir\Scripts\pyinstaller.exe" --noconfirm prettycas.spec
if ($LASTEXITCODE -ne 0) { Fail "PyInstaller build failed (see output above)." }

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
