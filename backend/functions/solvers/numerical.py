"""Numeric root finding for equations and square systems with no usable
closed form.

Everything is evaluated with numpy-vectorized lambdas so a wide global scan
is cheap, then candidate points are polished locally:

- One unknown (try_numerical): scan a linear range plus log-spaced points on
  both sides of zero, bracket sign changes and bisect them, and also polish
  near-zero local minima of |f| with Newton so tangent roots (no sign
  change, e.g. (x-2)^2) are found too.
- Several unknowns (try_numerical_system): evaluate the residuals on a
  log-spaced grid covering many orders of magnitude, take the best grid
  points as starting guesses, and polish each with Levenberg-Marquardt
  (damped Newton that falls back toward gradient descent when Newton steps
  overshoot or land outside the domain).

Residuals are measured relative to the size of each equation's own terms,
so an equation in meters (W ~ 1e-3) and one in ohms (Z0 ~ 50) are judged on
the same footing.
"""

import time

import numpy as np
import sympy as sp

SCAN_MIN = -50
SCAN_MAX = 50
SCAN_STEPS = 4000
FINE_MIN_EXP = -15
FINE_MAX_EXP = 8
FINE_STEPS = 800
DEDUPE_TOL = 1e-6
MAX_SOLUTIONS = 10
MAX_SYSTEM_SOLUTIONS = 6
ROOT_TOL = 1e-9  # max relative residual for a point to count as a root
TIME_BUDGET = 3.0  # seconds for the whole system search

# Log-spaced grid for seeding a system search: magnitudes 10^GRID_MIN_EXP
# to 10^GRID_MAX_EXP, both signs, plus zero.
GRID_MIN_EXP = -8
GRID_MAX_EXP = 8
GRID_POINTS_PER_DECADE = {1: 8, 2: 4, 3: 2}
# Plus evenly spaced points on [-10, 10], where most everyday roots live and
# where a log grid is sparse (e.g. 0.52 and 2.62 for sin x = 1/2).
GRID_LINEAR_POINTS = {1: 201, 2: 41, 3: 11}
# Extra roots further than this many times the smallest root's size are
# dropped (periodic systems otherwise list roots out at 1e7).
ROOT_SPREAD = 100
GRID_RANDOM_SAMPLES = 60000  # used instead of a full grid for 4+ unknowns
SYSTEM_SEEDS = 60


# ---------- Vectorized evaluation ----------


def _make_vectorized(expr, symbols):
    """A function of len(symbols) float arrays returning a float array, with
    nan wherever expr is undefined or complex. Uses numpy when it can, else
    a (slower) per-point mpmath fallback for functions numpy doesn't know."""
    try:
        f = sp.lambdify(symbols, expr, modules=["numpy"])
        with np.errstate(all="ignore"):
            np.asarray(f(*[np.array([1.5, -0.5])] * len(symbols)), dtype=complex)

        def vec(*arrays):
            with np.errstate(all="ignore"):
                out = np.asarray(f(*arrays), dtype=complex)
            out = np.broadcast_to(out, np.broadcast(*arrays).shape)
            return np.where(np.abs(out.imag) < 1e-12 * (1 + np.abs(out.real)), out.real, np.nan)

        return vec
    except Exception:
        pass

    g = sp.lambdify(symbols, expr, modules=["mpmath"])

    def scalar(*values):
        try:
            v = complex(g(*values))
        except Exception:
            return np.nan
        return v.real if abs(v.imag) < 1e-12 * (1 + abs(v.real)) else np.nan

    vectorized = np.vectorize(scalar, otypes=[float])

    def vec(*arrays):
        return vectorized(*arrays)

    return vec


class _Residual:
    """lhs - rhs for one equation, plus the sum of its terms' magnitudes
    used to make the residual scale-free."""

    def __init__(self, eq, symbols):
        expr = eq.lhs - eq.rhs
        terms = list(sp.Add.make_args(eq.lhs)) + [-t for t in sp.Add.make_args(eq.rhs)]
        scale = sp.Add(*[sp.Abs(t) for t in terms])
        self.value = _make_vectorized(expr, symbols)
        self.scale = _make_vectorized(scale, symbols)

    def relative(self, *arrays):
        v = self.value(*arrays)
        s = self.scale(*arrays)
        with np.errstate(all="ignore"):
            return np.where(v == 0, 0.0, v / s)


def _finite(x):
    return np.isfinite(x)


# ---------- One unknown ----------


def try_numerical(expr, symbol):
    """Real roots of `expr` (an Eq in one symbol), as a sorted list of
    floats (empty if none found)."""
    res = _Residual(expr, [symbol])

    xs = np.unique(np.concatenate([
        np.linspace(SCAN_MIN, SCAN_MAX, SCAN_STEPS + 1),
        np.logspace(FINE_MIN_EXP, FINE_MAX_EXP, FINE_STEPS),
        -np.logspace(FINE_MIN_EXP, FINE_MAX_EXP, FINE_STEPS),
    ]))
    vals = res.value(xs)
    rel = res.relative(xs)

    f = lambda x: float(res.value(np.array([x]))[0])
    frel = lambda x: float(res.relative(np.array([x]))[0])

    roots = []
    ok = _finite(vals)
    for i in range(len(xs) - 1):
        if not (ok[i] and ok[i + 1]):
            continue
        if vals[i] == 0:
            roots.append(xs[i])
        elif np.sign(vals[i]) != np.sign(vals[i + 1]):
            root = _bisect(f, xs[i], xs[i + 1], vals[i])
            # A sign change across a pole (1/x) isn't a root.
            if root is not None and abs(frel(root)) < 1e-6:
                roots.append(root)

    # Tangent roots: local minima of |rel| that get close to zero without
    # crossing it.
    a = np.abs(rel)
    for i in range(1, len(xs) - 1):
        if _finite(a[i]) and a[i] < 1e-2 and a[i] <= a[i - 1] and a[i] <= a[i + 1]:
            root = _newton_1d(frel, xs[i])
            if root is not None:
                roots.append(root)

    # sp.Float, not float: compute.py's renderer treats solutions as sympy
    # values (a bare float crashed _exact_mathjson).
    return [sp.Float(r) for r in _dedupe(roots)[:MAX_SOLUTIONS]]


def _bisect(f, a, b, fa):
    for _ in range(200):
        m = 0.5 * (a + b)
        if m == a or m == b:
            break
        fm = f(m)
        if not np.isfinite(fm):
            return None
        if fm == 0:
            return m
        if (fm < 0) == (fa < 0):
            a, fa = m, fm
        else:
            b = m
    return 0.5 * (a + b)


def _newton_1d(f, x):
    for _ in range(60):
        fx = f(x)
        if not np.isfinite(fx):
            return None
        if abs(fx) < ROOT_TOL:
            return x
        h = 1e-7 * max(abs(x), 1e-8)
        d = (f(x + h) - f(x - h)) / (2 * h)
        if not np.isfinite(d) or d == 0:
            return None
        x = x - fx / d
    return x if abs(f(x)) < ROOT_TOL else None


# ---------- Several unknowns ----------


def _axis_values(per_decade, linear=0):
    count = (GRID_MAX_EXP - GRID_MIN_EXP) * per_decade + 1
    mags = np.logspace(GRID_MIN_EXP, GRID_MAX_EXP, count)
    return np.unique(np.concatenate([-mags, [0.0], mags, np.linspace(-10, 10, linear)]))


def _seed_points(residuals, n):
    """Best starting guesses from a global scan, ordered best first."""
    if n in GRID_POINTS_PER_DECADE:
        axis = _axis_values(GRID_POINTS_PER_DECADE[n], GRID_LINEAR_POINTS[n])
        grids = np.meshgrid(*[axis] * n, indexing="ij")
        cols = [g.ravel() for g in grids]
    else:
        rng = np.random.default_rng(0)
        axis = _axis_values(4)
        cols = [rng.choice(axis, GRID_RANDOM_SAMPLES) for _ in range(n)]

    score = np.zeros_like(cols[0])
    for r in residuals:
        score = np.maximum(score, np.abs(r.relative(*cols)))
    score = np.where(np.isfinite(score), score, np.inf)

    order = np.argsort(score)
    seeds = []
    for idx in order:
        if not np.isfinite(score[idx]) or len(seeds) >= SYSTEM_SEEDS:
            break
        point = np.array([c[idx] for c in cols])
        if not any(_near_in_log(point, s) for s in seeds):
            seeds.append(point)

    for v in (1.0, 0.5, 2.0, 0.1, 10.0, -1.0):
        seeds.append(np.full(n, v))
    return seeds


def _near_in_log(a, b):
    # Seeds within about one grid cell of each other in every coordinate
    # would polish to the same root; keep only the first.
    la = np.sign(a) * np.log10(np.abs(a) + 1e-12)
    lb = np.sign(b) * np.log10(np.abs(b) + 1e-12)
    return bool(np.all(np.abs(la - lb) < 0.6))


def _levenberg_marquardt(F, x0, deadline, max_iter=200):
    """Minimize |F(x)|^2 from x0. Returns the final point, or None if it
    never got a finite residual."""
    x = np.array(x0, dtype=float)
    fx = F(x)
    if not np.all(np.isfinite(fx)):
        return None
    lam = 1e-3
    n = len(x)
    for _ in range(max_iter):
        if time.monotonic() > deadline:
            break
        cost = fx @ fx
        if np.sqrt(cost) < ROOT_TOL * 1e-3:
            break
        J = np.empty((len(fx), n))
        for j in range(n):
            h = 1e-7 * max(abs(x[j]), 1e-10)
            xp = x.copy()
            xp[j] += h
            fp = F(xp)
            if not np.all(np.isfinite(fp)):
                xp[j] = x[j] - h
                fp = F(xp)
                if not np.all(np.isfinite(fp)):
                    return x
                h = -h
            J[:, j] = (fp - fx) / h
        A = J.T @ J
        g = J.T @ fx
        diag = np.diag(A).copy()
        diag[diag == 0] = 1.0
        improved = False
        for _ in range(12):
            try:
                step = np.linalg.solve(A + lam * np.diag(diag), -g)
            except np.linalg.LinAlgError:
                lam *= 10
                continue
            xn = x + step
            fn = F(xn)
            if np.all(np.isfinite(fn)) and fn @ fn < cost:
                x, fx = xn, fn
                lam = max(lam / 3, 1e-12)
                improved = True
                break
            lam *= 4
        if not improved:
            break
        if np.all(np.abs(step) <= 1e-15 * (np.abs(x) + 1e-300)):
            break
    return x


def try_numerical_system(equations, symbols):
    """Real roots of a square system (as many equations as unknowns).

    Returns a list of solution dicts ({symbol: sp.Float}), the same shape
    sp.solve(dict=True) returns, or None if nothing converged. Finds several
    distinct roots when the scan turns them up, smallest magnitude first.
    """
    n = len(symbols)
    if len(equations) != n or not symbols:
        return None
    try:
        residuals = [_Residual(eq, symbols) for eq in equations]
    except Exception:
        return None

    deadline = time.monotonic() + TIME_BUDGET
    try:
        seeds = _seed_points(residuals, n)
    except Exception:
        return None

    def max_rel(x):
        cols = [np.array([v]) for v in x]
        return max(abs(float(r.relative(*cols)[0])) for r in residuals)

    roots = []
    for seed in seeds:
        if time.monotonic() > deadline:
            break
        # Weight each equation by its term scale at the seed so LM works on
        # comparable residuals, but keep the weights fixed during the run.
        cols = [np.array([v]) for v in seed]
        weights = []
        for r in residuals:
            s = float(r.scale(*cols)[0])
            weights.append(1.0 / s if np.isfinite(s) and s > 0 else 1.0)
        weights = np.array(weights)

        def F(x, weights=weights):
            c = [np.array([v]) for v in x]
            return np.array([float(r.value(*c)[0]) for r in residuals]) * weights

        x = _levenberg_marquardt(F, seed, deadline)
        if x is None:
            continue
        try:
            err = max_rel(x)
        except Exception:
            continue
        if not np.isfinite(err) or err > ROOT_TOL:
            continue
        if not any(np.all(np.abs(x - r) <= DEDUPE_TOL * np.maximum(1.0, np.abs(r))) for r in roots):
            roots.append(x)

    if not roots:
        return None
    roots.sort(key=lambda r: float(np.linalg.norm(r)))
    limit = ROOT_SPREAD * max(float(np.linalg.norm(roots[0])), 0.1)
    roots = ([roots[0]] + [r for r in roots[1:] if np.linalg.norm(r) <= limit])[:MAX_SYSTEM_SOLUTIONS]
    return [{sym: sp.Float(_round_sig(float(v), 12)) for sym, v in zip(symbols, r)} for r in roots]


# ---------- Shared helpers ----------


def _dedupe(roots):
    deduped = []
    for r in sorted(float(r) for r in roots):
        if not any(_close(r, d) for d in deduped):
            deduped.append(_round_sig(r, 10))
    return deduped


def _close(a, b):
    # Tolerance scales with magnitude so tiny roots (e.g. 1e-8) aren't
    # merged, or lost, at the same absolute scale as roots near 1.
    return abs(a - b) <= DEDUPE_TOL * max(abs(a), abs(b))


def _round_sig(x, digits):
    if x == 0:
        return 0.0
    return float(f"{x:.{digits}g}")
