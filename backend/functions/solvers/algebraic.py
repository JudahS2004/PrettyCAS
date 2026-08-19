import sympy as sp
from sympy.polys.polyroots import roots_cubic


def _real_cubic_trig_form(expr, symbol):
    """A cubic with three distinct real roots (discriminant > 0 — the
    classic "casus irreducibilis") forces Cardano's formula through complex
    intermediate cube roots even though every final root is real; sp.solve
    can't cancel that away symbolically, so it comes back as unreadable
    nested complex radicals that are technically correct but useless to look
    at. The trigonometric form of the same formula (via arccos) stays real
    throughout for exactly this case, so it's tried first whenever the
    equation qualifies — returns None (falls through to the regular solve)
    for every other shape of equation.
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
    trig_roots = _real_cubic_trig_form(expr, symbol)
    if trig_roots is not None:
        return trig_roots

    try:
        solutions = sp.solve(expr, symbol)
    except (NotImplementedError, TypeError):
        return None

    if isinstance(solutions, dict):
        # sp.solve returns {symbol: value} instead of a list when it solves
        # via a system internally (e.g. an equation between two matrices
        # decomposes into one scalar equation per entry).
        solutions = [solutions[symbol]] if symbol in solutions else list(solutions.values())

    if not solutions:
        return None

    return solutions
