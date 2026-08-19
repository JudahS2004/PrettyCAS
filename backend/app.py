import os
import sys

from flask import Flask, request, jsonify, Response, send_from_directory, abort
from functions import compute
from functions.sample import sample_curve, sample_surface
from functions.export import render_plot, MIME_TYPES

app = Flask(__name__)

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
    "index.html", "plot.html", "help.html", "misc.html", "app.js", "plot.js", "help.js", "misc.js",
    "api.js", "settings.js", "history.js", "workspace.js", "background-fx.js", "theme-init.js", "styles.css",
}


@app.get("/")
def index():
    return send_from_directory(FRONTEND_ROOT, "index.html")


@app.get("/<path:filename>")
def frontend_files(filename):
    top = filename.split("/", 1)[0]
    if filename not in FRONTEND_FILES and top != "node_modules":
        abort(404)
    return send_from_directory(FRONTEND_ROOT, filename)


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
    }
    return jsonify(compute.handle(body["mathjson"], options))


@app.post("/api/sample")
def sample_route():
    body = request.get_json(silent=True) or {}
    if "mathjson" not in body:
        return jsonify({"error": "missing 'mathjson' in request body"}), 400

    angle_mode = "deg" if body.get("angle_mode") == "deg" else "rad"
    constants = body.get("constants") or {}

    try:
        if body.get("kind") == "surface":
            resolution = max(2, min(int(body.get("resolution", 50)), MAX_SURFACE_RESOLUTION))
            result = sample_surface(
                body["mathjson"], body["vars"], body["domainX"], body["domainY"],
                resolution, angle_mode=angle_mode, constants=constants,
            )
        else:
            resolution = max(2, min(int(body.get("resolution", 300)), MAX_CURVE_RESOLUTION))
            result = sample_curve(
                body["mathjson"], body["var"], body["domain"],
                resolution, angle_mode=angle_mode, constants=constants,
                scale=body.get("scale", "linear"),
            )
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    return jsonify(result)


@app.post("/api/export")
def export_route():
    body = request.get_json(silent=True) or {}
    fmt = body.get("format", "svg")
    if fmt not in MIME_TYPES:
        return jsonify({"error": f"unsupported format '{fmt}' (use svg, pdf, eps, or png)"}), 400

    try:
        data, mime = render_plot(body, fmt)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    return Response(data, mimetype=mime, headers={
        "Content-Disposition": f'attachment; filename="prettycas-plot.{fmt}"',
    })


if __name__ == "__main__":
    app.run(port=5000, debug=True)