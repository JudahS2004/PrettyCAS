"""Single entry point for running PrettyCAS as a desktop app: starts the
Flask backend (which serves ../frontend too — see app.py) and opens it in
a native window via pywebview. One command, no separate static server.

    python backend/desktop.py

Forced onto pywebview's Qt backend (QtWebEngine, via the qtpy + PySide6
requirements) on Linux/Mac, deliberately, rather than letting it pick
per-OS defaults:
  - On Linux, pywebview tries GTK (WebKit2GTK) before Qt by default, and
    GTK is a system C library PyInstaller can't cleanly bundle into a
    standalone executable — see the WebKitGTK-specific bugs this project
    already hit once (localStorage disabled by default, a menu button that
    silently never un-hides itself) for why that's worth avoiding twice.
Qt is pip-installable everywhere (no system dev packages) and bundles
cleanly with PyInstaller.

**Windows is deliberately the one exception** (see `_pick_gui` below):
QtWebEngine has a confirmed, unfixed upstream bug where any element using
CSS `backdrop-filter: blur()` — which this app's settings drawer, history
panel, and most other panels all use throughout — flickers constantly on
Windows specifically (not Linux, not Mac; other QtWebEngine desktop apps
hit the exact same thing, e.g. ankitects/anki#4470, closed upstream as
"not planned"). pywebview's own default Windows backend (`winforms`,
hosting Microsoft Edge's WebView2 — a different Chromium embedding than
Qt's bundled one) doesn't have this bug, and needs no extra dependency:
`pythonnet` (what `winforms` actually needs) is already declared as an
automatic, Windows-only dependency of the `pywebview` package itself, so
`pip install -r requirements.txt` already pulls it in on Windows with no
change needed there — the qtpy/PySide6 lines stay for Linux/Mac.
"""

import platform
import sys
import threading

import webview
from werkzeug.serving import make_server

HOST = "127.0.0.1"
PORT = 5000


class ServerThread(threading.Thread):
    """Runs the Flask app in a background thread via werkzeug's own server
    (not app.run()), so it can be cleanly shut down when the window closes
    instead of leaving an orphaned process behind.

    Importing the app (which pulls in sympy, numpy, ... — measured at
    roughly 0.8s) and binding the server both happen in run(), on this
    thread, rather than in __init__ on the caller's thread — so main()
    below can kick this off and move straight on to setting up the Qt/
    WebEngine window, instead of waiting for this import to finish first.
    That window is normally the single largest chunk of startup time (a full
    embedded Chromium instance), so overlapping the two cuts wall-clock
    startup roughly to whichever one is slower, instead of paying for both
    back to back. main() still waits on self.ready right before actually
    pointing the window at the real URL — Qt doesn't retry a load that hits
    a refused connection, it just shows an error page — but by then this
    thread has had the entire window-setup time to finish in, so that wait
    is normally already over before it's reached.
    """

    def __init__(self):
        super().__init__(daemon=True)
        self.server = None
        self.ready = threading.Event()

    def run(self):
        from app import app
        # threaded=True: see the matching comment on app.run() in app.py's
        # own __main__ block — same server, same single-request-at-a-time
        # default otherwise, same fix.
        self.server = make_server(HOST, PORT, app, threaded=True)
        self.ready.set()
        self.server.serve_forever()

    def stop(self):
        self.ready.wait()
        self.server.shutdown()


def _fix_qt_clipboard_permission():
    """pywebview's Qt backend denies every feature permission request by
    default (including clipboard writes, which is why the Copy buttons did
    nothing) — and on top of that, its handler passes a raw int where this
    version of PySide6 requires an actual QWebEnginePage.PermissionPolicy,
    which crashes the instant a page requests any permission at all. Both
    are bugs in the installed pywebview/PySide6 pairing, not this app, so
    they're patched here rather than in site-packages — a plain `pip
    install -r requirements.txt` elsewhere should still get a working Copy
    button without needing to know any of this.

    Importing webview.platforms.qt here (instead of waiting for pywebview
    to lazily import it inside webview.start()) forces it to load early so
    there's something to patch; Python's module cache means pywebview's own
    later import of the same module just reuses this patched version.
    """
    from webview.platforms import qt as qt_platform
    from qtpy.QtWebEngineCore import QWebEnginePage

    def onFeaturePermissionRequested(self, url, feature):
        granted = feature in (
            QWebEnginePage.Feature.MediaAudioCapture,
            QWebEnginePage.Feature.MediaVideoCapture,
            QWebEnginePage.Feature.MediaAudioVideoCapture,
            QWebEnginePage.Feature.ClipboardReadWrite,
        )
        policy = (
            QWebEnginePage.PermissionPolicy.PermissionGrantedByUser
            if granted
            else QWebEnginePage.PermissionPolicy.PermissionDeniedByUser
        )
        self.setFeaturePermission(url, feature, policy)

    qt_platform.BrowserView.WebPage.onFeaturePermissionRequested = onFeaturePermissionRequested


def _pick_gui():
    """None on Windows (pywebview's own default there already tries
    winforms/WebView2 first — see this file's own docstring for why that's
    wanted instead of Qt specifically on Windows), "qt" everywhere else."""
    return None if platform.system() == "Windows" else "qt"


def main():
    # Started first, before any Qt/WebEngine setup below, so its import work
    # (see ServerThread) runs concurrently with — not before — that setup.
    server = ServerThread()
    server.start()

    gui = _pick_gui()
    if gui == "qt":
        _fix_qt_clipboard_permission()

    webview.create_window(
        "PrettyCAS", f"http://{HOST}:{PORT}/",
        width=1280, height=860, min_size=(760, 600),
    )
    try:
        # create_window() above only registers the window; it's webview.
        # start() below that actually fires off loading the URL it was given
        # — so this is the last possible moment to make sure the backend
        # exists first. Everything since server.start() (the Qt imports and
        # window setup above) has already been running concurrently with
        # that import, so this normally finds ready already set and returns
        # immediately; it only actually blocks if Qt genuinely won that race.
        server.ready.wait()

        # pywebview defaults to private_mode=True (like a browser's private
        # window) — on the Qt backend that's an in-memory-only
        # QWebEngineProfile with no persistent storage path set, and on the
        # GTK backend it disabled localStorage outright. Either way,
        # settings.js/history.js writing to localStorage would throw or
        # silently not persist, breaking the reactive settings pipeline
        # (background effects, sliders, etc. stop reacting to changes)
        # partway through a write. This is a normal desktop app, not an
        # incognito tab, so it should keep its settings between launches.
        webview.start(private_mode=False, gui=gui)
    except Exception as e:
        print(f"Couldn't open the desktop window ({e}).", file=sys.stderr)
        if gui == "qt":
            print("Make sure qtpy and PySide6 are installed (see requirements.txt).", file=sys.stderr)
        else:
            print("Make sure the Microsoft Edge WebView2 Runtime is installed.", file=sys.stderr)
    finally:
        server.stop()


if __name__ == "__main__":
    main()
