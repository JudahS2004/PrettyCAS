import sympy as sp

from ..mathjson import _run_with_timeout
from .algebraic import PREFER_ALGEBRAIC, SOLVE_TIMEOUT, solve_isolated
from .numerical import try_numerical_system


def _is_rational_system(equations, symbols):
    try:
        return all((eq.lhs - eq.rhs).is_rational_function(*symbols) for eq in equations)
    except Exception:
        return False


def solve_system(equations, symbols):
    """Solve a system of equations (a list of Eq) for the given symbols.

    Returns a list of solution dicts ({symbol: value}), same shape sympy's
    own sp.solve(..., dict=True) returns: one dict per solution branch, and a
    dict with fewer keys than `symbols` if the system is underdetermined
    (some variables stay free). Raises NotImplementedError if no closed form
    and no numeric root is found.

    A square system (as many equations as unknowns) that isn't polynomial/
    rational in its unknowns (logs, roots, trig: e.g. microstrip width and
    effective permittivity) is "nasty": sp.solve on those can grind inside
    long GIL-holding calls that _run_with_timeout's thread join can't
    interrupt (confirmed: a Hammerstad-Wheeler microstrip pair hung for 2+
    minutes), and they rarely have a closed form anyway.

    - "Prefer algebraic solutions" off (default): nasty systems go straight
      to try_numerical_system, and sp.solve is never called on them.
    - On: sp.solve gets a go first in a killable subprocess
      (solve_isolated), then the numeric search if that finds nothing.

    Polynomial/rational systems keep sp.solve first (exact answers, and it
    handles them quickly), with the numeric search as the fallback.
    """
    square = len(equations) == len(symbols)
    if square and not _is_rational_system(equations, symbols):
        if PREFER_ALGEBRAIC.get():
            try:
                solutions = solve_isolated(equations, symbols, dict=True)
            except Exception:
                solutions = None
            if solutions:
                return solutions
        numeric = try_numerical_system(equations, symbols)
        if numeric is not None:
            return numeric
        raise NotImplementedError("no solution found")

    _TIMED_OUT = object()
    try:
        solutions = _run_with_timeout(
            lambda: sp.solve(equations, symbols, dict=True), on_timeout=_TIMED_OUT, timeout=SOLVE_TIMEOUT,
        )
    except NotImplementedError:
        solutions = _TIMED_OUT
    if (solutions is _TIMED_OUT or not solutions) and square:
        numeric = try_numerical_system(equations, symbols)
        if numeric is not None:
            return numeric
    if solutions is _TIMED_OUT:
        raise NotImplementedError("solving this took too long")
    return solutions
