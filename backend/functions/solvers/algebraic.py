import sympy as sp
from sympy.polys.polyroots import roots_cubic

from ..mathjson import _run_with_timeout

# sp.solve has no native timeout either (same story as sp.integrate — see
# mathjson.py's own comment on _run_with_timeout), and it can genuinely hang
# well past what's reasonable for an interactive calculator: confirmed live
# with an otherwise-ordinary equation (a base-10-log path-loss formula,
# solved for one variable with a second left symbolic) that a plain
# sp.solve() call didn't return within 30+ seconds — the explicit base-10
# log construction (log(x, 10) is log(x)/log(10) from construction on, see
# format_result.py's own comment on this) leaves the exact irrational
# log(10) mixed in among float coefficients substituted from workspace
# constants, and sp.solve's default strategy apparently doesn't handle that
# mixture gracefully. A slightly longer allowance than INTEGRATION_TIMEOUT's
# 2s: an equation solve is the primary thing most inputs to this app are
# waiting on (not a background retry the way the integral timeout mostly
# is), so it's worth giving sp.solve a bit more rope before giving up.
SOLVE_TIMEOUT = 4  # seconds


def _real_cubic_trig_form(expr, symbol):
    """A cubic with three distinct real roots (discriminant > 0 — the
    classic "casus irreducibilis") forces Cardano's formula through complex
    intermediate cube roots even though every final root is real; sp.solve
    can't cancel that away symbolically, so it comes back as unreadable
    nested complex radicals that are technically correct but useless to look
    at. The trigonometric form of the same formula (via arccos) stays real
    throughout for exactly this case — but it's only worth reaching for when
    the plain solve actually hit that problem (see try_algebraic below):
    forcing it unconditionally on every 3-real-root cubic used to make a
    cubic with simple rational roots (e.g. x^3-7x+6=0, cleanly (x-1)(x-2)
    (x+3)) come back as an unreadable trig expression instead of the plain
    "1, 2, -3" a regular solve already gives — strictly worse, for a case
    that was never actually broken. Returns None whenever this doesn't
    apply, or on the rare case where even the trig identities don't fully
    clear the complex terms either, so the caller keeps the plain (if ugly)
    solve result instead of a partially-real-but-still-complex swap.
    """
    try:
        poly = sp.Poly(expr.lhs - expr.rhs, symbol)
    except sp.PolynomialError:
        return None
    if poly.degree() != 3 or not all(c.is_real for c in poly.all_coeffs()):
        return None
    if sp.discriminant(poly.as_expr(), symbol) <= 0:
        return None
    try:
        roots = roots_cubic(poly, trig=True)
    except Exception:
        return None
    return None if any(r.has(sp.I) for r in roots) else roots


def try_algebraic(expr, symbol):
    """Attempt a closed-form solve of the equation `expr` for `symbol`.

    Returns a list of sympy solutions on success, or None if sympy has no
    closed-form algorithm for this equation (or finds no solutions), so the
    caller should fall back to a numerical method.
    """
    try:
        solutions = _run_with_timeout(sp.solve, expr, symbol, on_timeout=None, timeout=SOLVE_TIMEOUT)
    except (NotImplementedError, TypeError):
        return None
    if solutions is None:
        return None

    if isinstance(solutions, dict):
        # sp.solve returns {symbol: value} instead of a list when it solves
        # via a system internally (e.g. an equation between two matrices
        # decomposes into one scalar equation per entry).
        solutions = [solutions[symbol]] if symbol in solutions else list(solutions.values())

    if not solutions:
        return None

    if any(s.has(sp.I) for s in solutions):
        # Only reached for a solve that actually came back with a complex
        # term — the casus-irreducibilis cubic this trig form exists for,
        # or (rarely) some other equation shape it doesn't apply to and
        # correctly declines. A cubic with nice rational/simple-radical
        # roots never reaches this branch at all, so it keeps sp.solve's
        # own plain answer instead of being swapped for something uglier.
        trig_roots = _real_cubic_trig_form(expr, symbol)
        if trig_roots is not None:
            return trig_roots

    return solutions
