import numpy as np
import sympy as sp

from .mathjson import to_sympy, substitute_functions, sympify_constant


def _linspace(lo, hi, n):
    return np.linspace(lo, hi, max(int(n), 2))


def _logspace(lo, hi, n):
    # Mirrors the plot frontend's own fallback: a configured lower bound
    # that isn't valid for log (<= 0) samples from a few decades below the
    # max instead of refusing to render.
    lo = lo if lo > 0 else hi / 1e4
    return np.logspace(np.log10(lo), np.log10(hi), max(int(n), 2))


def _build_callable(mathjson, var_names, angle_mode, constants, functions=None):
    expr = to_sympy(mathjson, angle_mode)
    if functions:
        expr = substitute_functions(expr, functions, angle_mode)
    if constants:
        expr = expr.subs({sp.Symbol(name): sympify_constant(value) for name, value in constants.items()})
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


def _real_or_none(value):
    """The same real-vs-complex/NaN test _to_clean_list applies per-sample,
    but for one scalar value at a time — so _refine_boundary below can
    check a bisection midpoint against exactly the same rule that decided
    the original grid samples were valid or not."""
    try:
        v = complex(value)
    except (TypeError, ValueError):
        return None
    if np.isfinite(v.real) and abs(v.imag) < 1e-9:
        return v.real
    return None


def _safe_call(f, x):
    try:
        return f(x)
    except Exception:
        return None


def _refine_boundary(f, x_valid, x_invalid, reference_y, iterations=40):
    """Bisects between one sample where `f` is real (`x_valid`) and an
    adjacent one where it isn't (`x_invalid`) to locate where the curve's
    real domain actually ends, instead of leaving it wherever the nearest
    coarse grid point happened to land short of it. 40 iterations halves
    the bracket 40 times — far tighter than the original grid spacing ever
    was, regardless of the domain's scale.

    Returns (x, y) at the refined edge, or None if this wasn't actually a
    domain edge to snap to. Two distinct ways that can happen: `f` never
    settles into a real value at all as the bracket shrinks (rare); or —
    the case that actually showed up testing this against 1/x at x=0 —
    it's a genuine asymptote, not a domain edge: 1/x stays technically
    finite (never NaN/inf) for any x however close to 0, so unguarded
    bisection happily converges to some absurd value like -1e13 instead of
    recognizing there's no real limit to snap to. `reference_y` (the
    original, un-refined sample at x_valid) is what tells the two apart: a
    genuine edge (sqrt(5-x^2) as x->sqrt(5)) settles to a value comparable
    to or smaller than what the curve was already doing nearby; a
    diverging one blows up far past it.
    """
    lo, hi = x_valid, x_invalid
    for _ in range(iterations):
        mid = (lo + hi) / 2
        y = _safe_call(f, mid)
        if y is not None and _real_or_none(y) is not None:
            lo = mid
        else:
            hi = mid
    value = _real_or_none(_safe_call(f, lo))
    if value is None:
        return None
    if abs(value) > 1000 * abs(reference_y) + 1e6:
        return None
    return (lo, value)


def _insert_boundary_points(f, xs, ys):
    """Where two adjacent samples flip between real (plottable) and not
    (None) — a curve's domain genuinely ending mid-grid, e.g. sqrt(...)
    going complex past a circle's edge — refine to the actual boundary and
    splice that exact point in, so the rendered line reaches all the way to
    where the curve really stops instead of stopping at the nearest coarse
    grid sample short of it.

    This is what closes the visible gap an implicit equation's y=f(x)
    branches (see plot.js — solving x^2+y^2=5 for y gives two such
    branches, ±sqrt(5-x^2)) otherwise leave right at a vertical tangent:
    each branch is sampled as an ordinary function-of-x curve on the same
    uniform grid as anything else, with nothing about that grid aware that
    the curve is about to end. Confirmed live on x^2+y^2=5 at the default
    domain/resolution: the last grid sample before the true edge landed
    about 0.5 units short of it on each branch — a large, obviously visible
    notch, not a subtle rounding gap.
    """
    out_x, out_y = [xs[0]], [ys[0]]
    for i in range(len(xs) - 1):
        valid_here, valid_next = ys[i] is not None, ys[i + 1] is not None
        if valid_here != valid_next:
            x_valid, x_invalid = (xs[i], xs[i + 1]) if valid_here else (xs[i + 1], xs[i])
            reference_y = ys[i] if valid_here else ys[i + 1]
            refined = _refine_boundary(f, x_valid, x_invalid, reference_y)
            if refined is not None:
                out_x.append(refined[0])
                out_y.append(refined[1])
        out_x.append(xs[i + 1])
        out_y.append(ys[i + 1])
    return out_x, out_y


def sample_curve(mathjson, var, domain, resolution, angle_mode="rad", constants=None, functions=None, scale="linear"):
    """Evaluate a 1-variable expression over `domain` for a 2D line plot.

    Returns {"x": [...], "y": [...]} with non-finite/complex samples as
    None (a gap in the rendered line) rather than a value. A handful of
    extra points get spliced in at any real/complex boundary the grid
    crossed (see _insert_boundary_points) so the line actually reaches
    those edges instead of stopping short of them.
    """
    xs = _logspace(domain["min"], domain["max"], resolution) if scale == "log" else _linspace(domain["min"], domain["max"], resolution)
    f = _build_callable(mathjson, [var], angle_mode, constants, functions)
    with np.errstate(all="ignore"):
        raw = f(xs)
        ys = _to_clean_list(raw, xs.shape)
        out_x, out_y = _insert_boundary_points(f, xs.tolist(), ys)
    return {"x": out_x, "y": out_y}


def sample_surface(mathjson, vars, domain_x, domain_y, resolution, angle_mode="rad", constants=None, functions=None):
    """Evaluate a 2-variable expression over a domain_x x domain_y grid for
    a 3D surface plot. Returns {"x": [...], "y": [...], "z": [[...], ...]}
    (z as a resolution x resolution grid, row-major over y then x, matching
    what Plotly's surface trace expects)."""
    xs = _linspace(domain_x["min"], domain_x["max"], resolution)
    ys = _linspace(domain_y["min"], domain_y["max"], resolution)
    X, Y = np.meshgrid(xs, ys)
    f = _build_callable(mathjson, vars, angle_mode, constants, functions)
    with np.errstate(all="ignore"):
        raw = f(X, Y)
    flat = _to_clean_list(raw, X.shape)
    n = len(xs)
    z = [flat[i * n:(i + 1) * n] for i in range(len(ys))]
    return {"x": xs.tolist(), "y": ys.tolist(), "z": z}
