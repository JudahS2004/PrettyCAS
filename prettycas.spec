# -*- mode: python ; coding: utf-8 -*-
import os
import sys

ROOT = os.path.dirname(os.path.abspath(SPEC))
BACKEND = os.path.join(ROOT, "backend")
FRONTEND = os.path.join(ROOT, "frontend")
# .ico on Windows (multi-resolution, what EXE() expects there), .png
# elsewhere — swap icons/icon.svg, icons/icon.png, icons/icon.ico for your
# own art any time, same three filenames.
ICON = os.path.join(ROOT, "icons", "icon.ico" if sys.platform == "win32" else "icon.png")

a = Analysis(
    [os.path.join(BACKEND, "desktop.py")],
    pathex=[BACKEND],
    binaries=[],
    # The whole frontend/ tree is bundled as a top-level "frontend" data
    # directory next to the executable — app.py's FRONTEND_ROOT finds it
    # via sys._MEIPASS when frozen (see the comment there).
    datas=[(FRONTEND, "frontend")],
    # matplotlib.use("Agg") only covers on-screen/raster rendering — the
    # export endpoint's savefig(format='svg'/'pdf'/'eps') lazily imports a
    # separate writer backend per format at call time, which PyInstaller's
    # static analysis can't see coming from a matplotlib.use() call alone.
    hiddenimports=[
        "matplotlib.backends.backend_svg",
        "matplotlib.backends.backend_pdf",
        "matplotlib.backends.backend_ps",
        "matplotlib.backends.backend_agg",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="PrettyCAS",
    debug=False,
    strip=False,
    upx=False,
    console=False,
    icon=ICON,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="PrettyCAS",
)
