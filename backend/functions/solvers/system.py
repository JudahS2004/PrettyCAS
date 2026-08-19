import sympy as sp


def solve_system(equations, symbols):
    """Solve a system of equations (a list of Eq) for the given symbols.

    Returns a list of solution dicts ({symbol: value}), same shape sympy's
    own sp.solve(..., dict=True) returns: one dict per solution branch for a
    nonlinear system, at most one dict for a linear system, and a dict with
    fewer keys than `symbols` if the system is underdetermined (some
    variables stay free). Raises NotImplementedError if sympy has no
    algorithm for this system.
    """
    return sp.solve(equations, symbols, dict=True)
