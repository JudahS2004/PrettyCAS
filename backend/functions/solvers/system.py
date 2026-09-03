import sympy as sp

from ..mathjson import _run_with_timeout
from .algebraic import SOLVE_TIMEOUT


def solve_system(equations, symbols):
    """Solve a system of equations (a list of Eq) for the given symbols.

    Returns a list of solution dicts ({symbol: value}), same shape sympy's
    own sp.solve(..., dict=True) returns: one dict per solution branch for a
    nonlinear system, at most one dict for a linear system, and a dict with
    fewer keys than `symbols` if the system is underdetermined (some
    variables stay free). Raises NotImplementedError if sympy has no
    algorithm for this system, or on a timeout (see algebraic.py's
    try_algebraic/SOLVE_TIMEOUT for why sp.solve needs one at all — this is
    actually the more commonly hit path in practice for an equation with
    more than one free symbol and no explicit solve_for target, since the
    Compute page never sends solve_for; only the Plot page does).
    """
    _TIMED_OUT = object()
    solutions = _run_with_timeout(
        lambda: sp.solve(equations, symbols, dict=True), on_timeout=_TIMED_OUT, timeout=SOLVE_TIMEOUT,
    )
    if solutions is _TIMED_OUT:
        raise NotImplementedError("solving this took too long")
    return solutions
