import sympy as sp

from .algebraic import PREFER_ALGEBRAIC, try_algebraic
from .numerical import try_numerical


def solve_equation(expr, symbol):
    """Solve `expr` (an Eq in one symbol), preferring a closed-form answer.

    Tries an algebraic solve first; if sympy can't find one (or finds none),
    falls back to a numerical search for real roots. Always returns a dict
    with "method" ("algebraic", "numerical", or "unsolved") and "solutions"
    (a list, empty for "unsolved").

    Equations where the unknown sits inside two or more different
    non-polynomial pieces, at least one a log/exp/trig-style function
    (e.g. a microstrip impedance formula solved for W), skip sp.solve and go
    straight to the numeric search: they essentially never have a closed
    form, and sp.solve can grind on them inside GIL-holding calls that the
    thread timeout can't interrupt (confirmed: minutes-long hang). With the
    "Prefer algebraic solutions" setting on, they get an sp.solve attempt
    first anyway, in a killable subprocess.
    """
    tangled = (_is_tangled_transcendental(expr, symbol) and not _has_undefined_functions(expr)
               and not (expr.free_symbols - {symbol}))
    if not tangled or PREFER_ALGEBRAIC.get():
        solutions = try_algebraic(expr, symbol, isolated=tangled)
        if solutions is not None:
            return {"method": "algebraic", "solutions": solutions}

    if _has_undefined_functions(expr):
        # e.g. f(x) = 0 for an abstract f: there's no concrete definition to
        # plug numbers into, so a numerical scan can't do anything useful
        # with it (and would just blow up trying to evaluate f numerically).
        return {"method": "unsolved", "solutions": []}

    if expr.free_symbols - {symbol}:
        # A numerical bisection search needs every other symbol already
        # resolved to a concrete number — sp.lambdify(symbol, ...) builds a
        # function of `symbol` alone, but the expression body still
        # references whatever other name is left free (e.g. solving "d" in
        # "L_u = ... + coef*log(d)" while L_u itself has no assigned value),
        # so the first actual evaluation attempt would raise a bare
        # NameError instead of a clean "no solution found" the same way the
        # undefined-function case just above it does.
        return {"method": "unsolved", "solutions": []}

    return {"method": "numerical", "solutions": try_numerical(expr, symbol)}


def _is_tangled_transcendental(expr, symbol):
    generators = set()
    for node in sp.preorder_traversal(expr.lhs - expr.rhs):
        if not node.has(symbol):
            continue
        if isinstance(node, sp.Pow) and not node.exp.is_Integer:
            generators.add(node)
        elif isinstance(node, sp.Function):
            generators.add(node)
    has_function = any(isinstance(g, sp.Function) for g in generators)
    return has_function and len(generators) >= 2


def _has_undefined_functions(expr):
    return bool(expr.atoms(sp.core.function.AppliedUndef))
