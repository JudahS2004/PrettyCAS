#!/usr/bin/env bash
# Builds PrettyCAS with PyInstaller and installs it as a real launchable
# app for the current user — no sudo, nothing outside $HOME. Re-run this
# any time after changing source or swapping icon.svg/icon.png/icon.ico
# for your own art (same three filenames, so nothing else needs updating).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "Building with PyInstaller..."
backend/.venv/bin/pyinstaller --noconfirm prettycas.spec

INSTALL_DIR="$HOME/.local/share/prettycas"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$ICON_DIR" "$APPS_DIR"

echo "Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
cp -r dist/PrettyCAS "$INSTALL_DIR"
cp icon.png "$ICON_DIR/prettycas.png"

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
