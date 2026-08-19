import sympy as sp

from .algebraic import try_algebraic
from .numerical import try_numerical


def solve_equation(expr, symbol):
    """Solve `expr` (an Eq in one symbol), preferring a closed-form answer.

    Tries an algebraic solve first; if sympy can't find one (or finds none),
    falls back to a numerical search for real roots. Always returns a dict
    with "method" ("algebraic", "numerical", or "unsolved") and "solutions"
    (a list, empty for "unsolved").
    """
    solutions = try_algebraic(expr, symbol)
    if solutions is not None:
        return {"method": "algebraic", "solutions": solutions}

    if _has_undefined_functions(expr):
        # e.g. f(x) = 0 for an abstract f: there's no concrete definition to
        # plug numbers into, so a numerical scan can't do anything useful
        # with it (and would just blow up trying to evaluate f numerically).
        return {"method": "unsolved", "solutions": []}

    return {"method": "numerical", "solutions": try_numerical(expr, symbol)}


def _has_undefined_functions(expr):
    return bool(expr.atoms(sp.core.function.AppliedUndef))
