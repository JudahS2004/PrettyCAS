import numpy as np
import sympy as sp

from .mathjson import to_sympy


def _linspace(lo, hi, n):
    return np.linspace(lo, hi, max(int(n), 2))


def _logspace(lo, hi, n):
    # Mirrors the plot frontend's own fallback: a configured lower bound
    # that isn't valid for log (<= 0) samples from a few decades below the
    # max instead of refusing to render.
    lo = lo if lo > 0 else hi / 1e4
    return np.logspace(np.log10(lo), np.log10(hi), max(int(n), 2))


def _build_callable(mathjson, var_names, angle_mode, constants):
    expr = to_sympy(mathjson, angle_mode)
    if constants:
        expr = expr.subs({sp.Symbol(name): value for name, value in constants.items()})
    symbols = [sp.Symbol(name) for name in var_names]
    # complex128 output even for real-valued expressions: sqrt/log/asin of an
    # out-of-domain input should come back as a (filterable) complex number
    # instead of lambdify raising or numpy warning-and-NaN-ing under the hood.
    return sp.lambdify(symbols, expr, modules=["numpy"], cse=True)


def _to_clean_list(values, shape):
    # Broadcast first: an expression that doesn't depend on one of the
    # sampled variables (e.g. z = x, constant across y) lambdifies to a
    # scalar rather than an array the same shape as the domain.
    arr = np.broadcast_to(np.asarray(values, dtype=complex), shape)
    with np.errstate(all="ignore"):
        real = arr.real
        finite = np.isfinite(real) & (np.abs(arr.imag) < 1e-9)
    cleaned = np.where(finite, real, np.nan)
    flat = cleaned.reshape(-1).tolist()
    return [None if v != v else v for v in flat]  # v != v is the NaN check


def sample_curve(mathjson, var, domain, resolution, angle_mode="rad", constants=None, scale="linear"):
    """Evaluate a 1-variable expression over `domain` for a 2D line plot.

    Returns {"x": [...], "y": [...]} with non-finite/complex samples as
    None (a gap in the rendered line) rather than a value.
    """
    xs = _logspace(domain["min"], domain["max"], resolution) if scale == "log" else _linspace(domain["min"], domain["max"], resolution)
    f = _build_callable(mathjson, [var], angle_mode, constants)
    with np.errstate(all="ignore"):
        raw = f(xs)
    return {"x": xs.tolist(), "y": _to_clean_list(raw, xs.shape)}


def sample_surface(mathjson, vars, domain_x, domain_y, resolution, angle_mode="rad", constants=None):
    """Evaluate a 2-variable expression over a domain_x x domain_y grid for
    a 3D surface plot. Returns {"x": [...], "y": [...], "z": [[...], ...]}
    (z as a resolution x resolution grid, row-major over y then x, matching
    what Plotly's surface trace expects)."""
    xs = _linspace(domain_x["min"], domain_x["max"], resolution)
    ys = _linspace(domain_y["min"], domain_y["max"], resolution)
    X, Y = np.meshgrid(xs, ys)
    f = _build_callable(mathjson, vars, angle_mode, constants)
    with np.errstate(all="ignore"):
        raw = f(X, Y)
    flat = _to_clean_list(raw, X.shape)
    n = len(xs)
    z = [flat[i * n:(i + 1) * n] for i in range(len(ys))]
    return {"x": xs.tolist(), "y": ys.tolist(), "z": z}
