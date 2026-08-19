import mpmath
import sympy as sp

SCAN_MIN = -50
SCAN_MAX = 50
SCAN_STEPS = 4000
FINE_MIN_EXP = -12  # smallest magnitude probed by the near-zero log-spaced scan
FINE_STEPS = 400
DEDUPE_TOL = 1e-6
MAX_SOLUTIONS = 10


def try_numerical(expr, symbol):
    """Search for real roots of `expr` (an Eq) over a bounded range.

    Scans for sign changes in lhs - rhs and refines each bracket with
    mpmath's bisection solver. Points where the function is undefined or
    complex-valued (e.g. log of a negative number) are skipped rather than
    treated as errors. In addition to a uniform linear scan of
    [SCAN_MIN, SCAN_MAX], a log-spaced scan straddles zero, since functions
    like log(x) or 1/x often cross zero within a tiny sliver right next to a
    domain boundary that a uniform grid would step right over. Returns a
    sorted list of floats, which is empty if no real root was found.
    """
    f = sp.lambdify(symbol, expr.lhs - expr.rhs, modules=["mpmath"])

    samples = []
    for xi in _sample_points():
        yi = _safe_eval(f, xi)
        if yi is not None:
            samples.append((xi, yi))
    samples.sort(key=lambda point: point[0])

    roots = []
    for (x0, y0), (x1, y1) in zip(samples, samples[1:]):
        if y0 == 0:
            roots.append(x0)
        elif y0 * y1 < 0:
            root = _refine(f, x0, x1)
            if root is not None:
                roots.append(root)

    return _dedupe(roots)


def _sample_points():
    step = (SCAN_MAX - SCAN_MIN) / SCAN_STEPS
    points = {SCAN_MIN + i * step for i in range(SCAN_STEPS + 1)}

    edge = max(abs(SCAN_MIN), abs(SCAN_MAX))
    for magnitude in _log_spaced(10 ** FINE_MIN_EXP, edge, FINE_STEPS):
        points.add(magnitude)
        points.add(-magnitude)

    return points


def _log_spaced(lo, hi, n):
    log_lo, log_hi = mpmath.log(lo, 10), mpmath.log(hi, 10)
    step = (log_hi - log_lo) / (n - 1)
    return [float(10 ** (log_lo + i * step)) for i in range(n)]


def _safe_eval(f, x):
    try:
        y = complex(f(x))
    except (ValueError, ZeroDivisionError, OverflowError, TypeError):
        return None
    if y.imag != 0 or mpmath.isnan(y.real) or mpmath.isinf(y.real):
        return None
    return y.real


def _refine(f, x0, x1):
    try:
        root = mpmath.findroot(lambda v: complex(f(v)).real, (x0, x1), solver="bisect")
        return float(root)
    except Exception:
        return None


def _dedupe(roots):
    deduped = []
    for r in sorted(roots):
        if not any(_close(r, d) for d in deduped):
            deduped.append(_round_sig(r, 10))
    return deduped[:MAX_SOLUTIONS]


def _close(a, b):
    # Tolerance scales with magnitude so tiny roots (e.g. 1e-8) aren't
    # merged, or lost, at the same absolute scale as roots near 1.
    return abs(a - b) < DEDUPE_TOL * max(1.0, abs(a), abs(b))


def _round_sig(x, digits):
    if x == 0:
        return 0.0
    return float(f"{x:.{digits}g}")
