#!/usr/bin/env bash
# Sets up dependencies (Python virtual environment, pip packages, npm
# packages -- each step skipped if it's already done and up to date),
# builds PrettyCAS with PyInstaller, and installs it as a real launchable
# app for the current user -- no sudo, nothing outside $HOME. Re-run this
# any time after changing source, backend/requirements.txt,
# frontend/package.json, or swapping icons/icon.svg / icons/icon.png /
# icons/icon.ico for your own art (same three filenames, so nothing else
# needs updating).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

VENV_DIR="backend/.venv"
REQUIREMENTS="backend/requirements.txt"
REQ_STAMP="$VENV_DIR/.requirements.sha256"
NODE_STAMP="frontend/node_modules/.install.sha256"

fail() {
  echo "error: $1" >&2
  exit 1
}

# --- Python virtual environment (skip if it already exists) ---
if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "Setting up Python virtual environment..."
  command -v python3 >/dev/null 2>&1 || fail "python3 not found. Install Python 3.10+ (https://www.python.org/downloads/) and make sure it's on your PATH, then re-run this script."
  if ! python3 -m venv "$VENV_DIR"; then
    rm -rf "$VENV_DIR"
    fail "couldn't create the virtual environment. On Debian/Ubuntu this usually means the venv module is missing -- try 'sudo apt install python3-venv' and re-run this script."
  fi
fi

# --- Python packages (re-installed only when requirements.txt changed) ---
[ -f "$REQUIREMENTS" ] || fail "$REQUIREMENTS not found -- is this script running from the repo root?"
REQ_HASH=$(sha256sum "$REQUIREMENTS" | cut -d' ' -f1)
if [ ! -f "$REQ_STAMP" ] || [ "$(cat "$REQ_STAMP" 2>/dev/null)" != "$REQ_HASH" ]; then
  echo "Installing Python packages..."
  "$VENV_DIR/bin/pip" install -r "$REQUIREMENTS" || fail "pip install failed (see output above). Fix the issue and re-run this script."
  echo "$REQ_HASH" > "$REQ_STAMP"
fi

# --- npm packages (re-installed only when package.json changed) ---
PKG_HASH=$(sha256sum "frontend/package.json" | cut -d' ' -f1)
if [ ! -d "frontend/node_modules" ] || [ ! -f "$NODE_STAMP" ] || [ "$(cat "$NODE_STAMP" 2>/dev/null)" != "$PKG_HASH" ]; then
  echo "Installing frontend packages..."
  command -v npm >/dev/null 2>&1 || fail "npm not found. Install Node.js (https://nodejs.org) and make sure it's on your PATH, then re-run this script."
  (cd frontend && npm install) || fail "npm install failed (see output above). Fix the issue and re-run this script."
  echo "$PKG_HASH" > "$NODE_STAMP"
fi

echo "Building with PyInstaller..."
"$VENV_DIR/bin/pyinstaller" --noconfirm prettycas.spec || fail "PyInstaller build failed (see output above)."

INSTALL_DIR="$HOME/.local/share/prettycas"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$ICON_DIR" "$APPS_DIR"

echo "Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
cp -r dist/PrettyCAS "$INSTALL_DIR"
cp icons/icon.png "$ICON_DIR/prettycas.png"

cat > "$APPS_DIR/prettycas.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=PrettyCAS
Comment=Symbolic computation and graphing
Exec=$INSTALL_DIR/PrettyCAS
Icon=prettycas
Terminal=false
Categories=Education;Math;
StartupWMClass=PrettyCAS
EOF
chmod +x "$APPS_DIR/prettycas.desktop"

command -v update-desktop-database >/dev/null && update-desktop-database "$APPS_DIR"
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" || true

echo "Installed. PrettyCAS should now show up in your application launcher."
