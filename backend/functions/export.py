import io

import matplotlib
matplotlib.use("Agg")  # headless: no display server, just render to a buffer
import matplotlib.pyplot as plt
import numpy as np

from .sample import sample_curve, sample_surface

MIME_TYPES = {
    "svg": "image/svg+xml",
    "pdf": "application/pdf",
    "eps": "application/postscript",
    "png": "image/png",
}

# Plotly line-dash names (used by the interactive plot) -> matplotlib's.
LINESTYLES = {"solid": "-", "dash": "--", "dot": ":", "dashdot": "-."}

# Matches the app's own light-theme tokens (styles.css :root) and the
# interactive Plotly chart's actual look (axisTheme() in plot.js): no boxed
# spines or tick marks, no axis titles, just faint gridlines and a
# transparent background — a Plotly export, not a matplotlib-textbook one.
GRID_COLOR = "#e1e3ec"
TICK_COLOR = "#6b6f80"
TEXT_COLOR = "#1b1d29"

plt.rcParams["font.family"] = "sans-serif"
plt.rcParams["font.sans-serif"] = ["DejaVu Sans"]
plt.rcParams["font.size"] = 11


def _style_2d_like_web(ax):
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.tick_params(length=0, colors=TICK_COLOR, labelsize=10)
    ax.set_axisbelow(True)
    ax.grid(True, color=GRID_COLOR, linewidth=1)


def _grid_from_z(z):
    """sample_curve/sample_surface use JSON-safe None for out-of-domain
    points; matplotlib wants NaN (a real float it can treat as a gap)."""
    return np.array([[np.nan if v is None else v for v in row] for row in z], dtype=float)


def _render_2d(rows, view, resolution, constants, functions, angle_mode):
    fig, ax = plt.subplots(figsize=(8, 6), dpi=150)
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)

    labeled_count = 0
    for spec in rows:
        if spec["kind"] == "vline":
            ax.axvline(spec["value"], color=spec["color"], linewidth=2.5, label=spec.get("label"))
            labeled_count += 1
            continue
        if spec["kind"] == "hline":
            ax.axhline(spec["value"], color=spec["color"], linewidth=2.5, label=spec.get("label"))
            labeled_count += 1
            continue
        data = sample_curve(
            spec["mathjson"], spec["var"], spec["domain"], resolution,
            angle_mode=angle_mode, constants=constants, functions=functions, scale=view.get("xScale", "linear"),
        )
        y = [np.nan if v is None else v for v in data["y"]]
        ax.plot(
            data["x"], y, color=spec["color"], linewidth=2.5,
            linestyle=LINESTYLES.get(spec.get("lineStyle", "solid"), "-"),
            label=spec.get("label"),
        )
        labeled_count += 1

    if view.get("xScale") == "log":
        ax.set_xscale("log")
    if view.get("yScale") == "log":
        ax.set_yscale("log")
    ax.set_xlim(view["xMin"], view["xMax"])
    if not view.get("outputAuto", True):
        ax.set_ylim(view["outputMin"], view["outputMax"])

    _style_2d_like_web(ax)
    # A single curve is unambiguous without one (matching the interactive
    # view, which never shows an on-chart legend at all — colors are keyed
    # to the sidebar instead); with multiple curves the exported file has no
    # sidebar to fall back on, so a legend earns its place.
    if labeled_count > 1:
        ax.legend(loc="best", fontsize=9, frameon=False, labelcolor=TEXT_COLOR)
    fig.tight_layout()
    return fig


def _surface_grid(spec, resolution, constants, functions, angle_mode, view):
    """Returns (X, Y, Z) numpy grids for one 3D row — either a genuine
    2-variable surface, or a 1-variable curve extruded across the axis it
    doesn't depend on (mirrors the client's own build3dTraces tiling)."""
    if spec["kind"] == "surface":
        data = sample_surface(
            spec["mathjson"], spec["vars"], spec["domainX"], spec["domainY"],
            resolution, angle_mode=angle_mode, constants=constants, functions=functions,
        )
        X, Y = np.meshgrid(data["x"], data["y"])
        return X, Y, _grid_from_z(data["z"])

    data = sample_curve(
        spec["mathjson"], spec["var"], spec["domain"], resolution,
        angle_mode=angle_mode, constants=constants, functions=functions,
    )
    y = np.array([np.nan if v is None else v for v in data["y"]])
    own = np.array(data["x"])
    other = np.linspace(
        view["xMin"] if not spec["alongX"] else view["yMin"],
        view["xMax"] if not spec["alongX"] else view["yMax"],
        resolution,
    )
    if spec["alongX"]:
        X, Y = np.meshgrid(own, other)
        Z = np.tile(y, (resolution, 1))
    else:
        X, Y = np.meshgrid(other, own)
        Z = np.tile(y.reshape(-1, 1), (1, resolution))
    return X, Y, Z


def _render_3d(rows, view, resolution, constants, functions, angle_mode):
    fig = plt.figure(figsize=(8, 6), dpi=150)
    fig.patch.set_alpha(0)
    ax = fig.add_subplot(projection="3d")
    ax.patch.set_alpha(0)

    # Matches build3dTraces: a single surface is fully opaque, multiple
    # overlapping ones are lightened so they don't hide each other.
    opacity = 0.78 if len(rows) > 1 else 1.0
    for spec in rows:
        X, Y, Z = _surface_grid(spec, resolution, constants, functions, angle_mode, view)
        if not np.isfinite(Z).any():
            continue
        ax.plot_surface(X, Y, Z, color=spec["color"], alpha=opacity, linewidth=0, antialiased=True)

    ax.set_xlim(view["xMin"], view["xMax"])
    ax.set_ylim(view["yMin"], view["yMax"])
    if not view.get("outputAuto", True):
        ax.set_zlim(view["outputMin"], view["outputMax"])
    ax.set_xlabel("x")
    ax.set_ylabel("y")
    ax.set_zlabel("z")

    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.pane.set_facecolor((1, 1, 1, 0))
        axis.pane.set_edgecolor(GRID_COLOR)
        axis.line.set_color(GRID_COLOR)
        axis.line.set_linewidth(0.8)
        axis._axinfo["grid"]["color"] = GRID_COLOR
        axis._axinfo["grid"]["linewidth"] = 0.8
    ax.tick_params(colors=TICK_COLOR, labelsize=8)
    ax.xaxis.label.set_color(TEXT_COLOR)
    ax.yaxis.label.set_color(TEXT_COLOR)
    ax.zaxis.label.set_color(TEXT_COLOR)

    # Mirrors the interactive plot's "Axis scaling" setting: 'manual' uses
    # the same x:y:z ratio, everything else (auto/cube/data) just gets a
    # plain cube — matplotlib's 3D box aspect has no equivalent of Plotly's
    # data-proportional "auto"/"data" modes, so a cube is the closest
    # reasonable default for the modes that aren't an explicit ratio.
    if view.get("aspectMode") == "manual":
        ax.set_box_aspect((view.get("aspectX", 1), view.get("aspectY", 1), view.get("aspectZ", 1)))
    else:
        ax.set_box_aspect((1, 1, 1))

    fig.tight_layout()
    return fig


def render_plot(payload, fmt):
    mode = payload.get("mode", "2d")
    resolution = int(payload.get("resolution") or (50 if mode == "3d" else 300))
    constants = payload.get("constants") or {}
    functions = payload.get("functions") or {}
    angle_mode = "deg" if payload.get("angle_mode") == "deg" else "rad"
    rows = payload.get("rows") or []
    view = payload.get("view") or {}

    fig = _render_2d(rows, view, resolution, constants, functions, angle_mode) if mode == "2d" \
        else _render_3d(rows, view, resolution, constants, functions, angle_mode)

    buf = io.BytesIO()
    try:
        fig.savefig(buf, format=fmt, bbox_inches="tight", transparent=True)
    finally:
        plt.close(fig)
    return buf.getvalue(), MIME_TYPES[fmt]
