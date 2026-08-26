import os
import sys

from flask import Flask, request, jsonify, Response, send_from_directory, abort
from functions import compute
from functions.sample import sample_curve, sample_surface
from functions import maxima_bridge

app = Flask(__name__)

# matplotlib (imported by functions.export) alone adds ~0.8s to import —
# real cost, but only for the rarely-used "export plot to file" button, not
# for the app to become usable at all. Deferring the import into the route
# itself (Python caches it after the first call, so only the first export
# in a session pays this) keeps that cost off of every single app launch.
# Duplicated here (rather than importing functions.export.MIME_TYPES) so
# this early validation doesn't itself force that import before it's known
# the format is even valid — kept in sync by hand, but it's a frozen set of
# 4 file formats, not something that changes independently on either side.
EXPORT_MIME_TYPES = {"svg": "image/svg+xml", "pdf": "application/pdf", "eps": "application/postscript", "png": "image/png"}

MAX_DECIMALS = 1000
MAX_CURVE_RESOLUTION = 2000
MAX_SURFACE_RESOLUTION = 300

# The frontend is served from here too (no separate static file server) —
# just the handful of files it actually needs from ../frontend, plus
# node_modules for the three vendored JS libs. Backend source (this
# directory) stays off-limits.
#
# In a PyInstaller build there's no "../frontend" on disk next to this
# file — the frontend is bundled as a top-level "frontend" data directory
# alongside the frozen executable instead (see prettycas.spec), and
# sys._MEIPASS points at wherever that ended up (the dist folder itself
# for a --onedir build, a per-launch temp extraction dir for --onefile).
if getattr(sys, "frozen", False):
    FRONTEND_ROOT = os.path.join(sys._MEIPASS, "frontend")
else:
    FRONTEND_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
FRONTEND_FILES = {
    "index.html", "shell.js", "compute-engine.js", "app.js", "plot.js", "help.js",
    "api.js", "settings.js", "history.js", "workspace.js", "background-fx.js", "theme-init.js", "styles.css",
}


@app.get("/")
def index():
    return send_from_directory(FRONTEND_ROOT, "index.html")


FRONTEND_STATIC_DIRS = {"node_modules", "fonts"}


@app.get("/<path:filename>")
def frontend_files(filename):
    top = filename.split("/", 1)[0]
    if filename not in FRONTEND_FILES and top not in FRONTEND_STATIC_DIRS:
        abort(404)
    # node_modules (MathLive/compute-engine/Plotly) and fonts (the bundled
    # CMU Serif webfont) are vendored/static and only ever change via an
    # explicit `npm install` or a font swap, unlike the app's own files
    # above, which get edited constantly during development and need every
    # reload to see the latest version. Flask's default here is
    # "Cache-Control: no-cache" — not "don't cache", but "revalidate with
    # the server before reusing it" — so the browser still round-trips on
    # every single page navigation for the exact same multi-MB library
    # bundle. A real max-age lets it skip that entirely (and gives the
    # browser's JS engine a real shot at reusing its compiled-bytecode
    # cache for the same script across navigations, not just the raw
    # bytes) — the fix that actually matters for a multi-page app like
    # this one, where the same handful of large vendor scripts get
    # re-requested on every Compute/Plot/Help/Misc switch.
    max_age = 86400 if top in FRONTEND_STATIC_DIRS else None
    return send_from_directory(FRONTEND_ROOT, filename, max_age=max_age)


@app.get("/api/capabilities")
def capabilities_route():
    # Lets the frontend grey out (and never even try to select) the Maxima
    # engine-preference option when it isn't installed on this machine,
    # rather than the user finding out by picking it and getting silently
    # routed to sympy anyway. maxima_bridge.is_available() caches its own
    # check, so this is cheap to call once at startup regardless.
    return jsonify({"maxima_available": maxima_bridge.is_available()})


@app.post("/api/compute")
def compute_route():
    body = request.get_json(silent=True) or {}
    if "mathjson" not in body:
        return jsonify({"mode": "error", "result": "missing 'mathjson' in request body"}), 400

    decimals = body.get("decimals")
    if decimals is not None:
        try:
            decimals = max(1, min(int(decimals), MAX_DECIMALS))
        except (TypeError, ValueError):
            decimals = None

    options = {
        "angle_mode": "deg" if body.get("angle_mode") == "deg" else "rad",
        "decimals": decimals,
        "simplify_mode": body.get("simplify_mode"),
        "solve_for": body.get("solve_for"),
        "number_format": body.get("number_format"),
        # The frontend's session workspace (see workspace.js) — earlier
        # "name = ..." inputs, substituted into this one the same way a
        # plot row's slider constants already are for /api/sample.
        "constants": body.get("constants"),
        # Earlier "f(x) = ..." workspace function definitions, substituted
        # into calls like f(3) or f(x) found in this computation.
        "functions": body.get("functions"),
    }
    return jsonify(compute.handle(body["mathjson"], options))


@app.post("/api/sample")
def sample_route():
    body = request.get_json(silent=True) or {}
    if "mathjson" not in body:
        return jsonify({"error": "missing 'mathjson' in request body"}), 400

    angle_mode = "deg" if body.get("angle_mode") == "deg" else "rad"
    constants = body.get("constants") or {}
    functions = body.get("functions") or {}

    try:
        if body.get("kind") == "surface":
            resolution = max(2, min(int(body.get("resolution", 50)), MAX_SURFACE_RESOLUTION))
            result = sample_surface(
                body["mathjson"], body["vars"], body["domainX"], body["domainY"],
                resolution, angle_mode=angle_mode, constants=constants, functions=functions,
            )
        else:
            resolution = max(2, min(int(body.get("resolution", 300)), MAX_CURVE_RESOLUTION))
            result = sample_curve(
                body["mathjson"], body["var"], body["domain"],
                resolution, angle_mode=angle_mode, constants=constants, functions=functions,
                scale=body.get("scale", "linear"),
            )
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    return jsonify(result)


@app.post("/api/export")
def export_route():
    body = request.get_json(silent=True) or {}
    fmt = body.get("format", "svg")
    if fmt not in EXPORT_MIME_TYPES:
        return jsonify({"error": f"unsupported format '{fmt}' (use svg, pdf, eps, or png)"}), 400

    from functions.export import render_plot
    try:
        data, mime = render_plot(body, fmt)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    return Response(data, mimetype=mime, headers={
        "Content-Disposition": f'attachment; filename="prettycas-plot.{fmt}"',
    })


if __name__ == "__main__":
    # threaded=True: without it, Werkzeug's dev server handles one request
    # at a time — a slow /api/compute (a gnarly integral sympy churns on for
    # a while) blocks every other request, including an unrelated, cheap one
    # sent right after, until the slow one finishes. Confirmed live: a slow
    # request left the server completely unresponsive to a trivial "2+2"
    # sent a second later — it never got a response. Threaded lets Werkzeug
    # hand each request its own thread; Python's GIL means two CPU-bound
    # sympy calls still take turns rather than running in true parallel, but
    # the scheduler preempts between them, so a cheap request lands its
    # response quickly instead of queuing behind an expensive one.
    app.run(port=5000, debug=True, threaded=True)