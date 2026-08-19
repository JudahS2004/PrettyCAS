import sympy as sp
from .mathjson import to_sympy
from .solvers import solve_equation
from .solvers import matrix_equation
from .solvers.system import solve_system
from .format_result import to_display as _to_display, to_engineering as _to_engineering

SIMPLIFY_MODES = {"auto", "expand", "factor"}


def _format_number(value, decimals, number_format):
    """(text, latex) for a value, after decimal-mode rounding. Engineering
    notation only replaces the default sympy printing for a plain real
    number — anything else (symbolic, complex, an equation, a set, ...)
    keeps to_display's normal str()/latex() form."""
    display = _to_display(value, decimals)
    if number_format == "engineering" and decimals is not None:
        engineering = _to_engineering(display, decimals)
        if engineering is not None:
            return engineering
    return str(display), sp.latex(display)


def _apply_simplify_mode(expr, mode):
    # cos(2+i) etc.: sp.simplify() alone leaves a complex-argument trig call
    # exactly as entered, since "cos(2 + I)" is already its own valid form
    # as far as simplify() is concerned. expand_complex() is the step that
    # actually splits it into a+bi (here, using cosh/sinh) — a no-op for
    # already-real expressions, so it's safe to always try first.
    if expr.has(sp.I):
        expr = sp.expand_complex(expr)
    if mode == "expand":
        return sp.expand(expr)
    if mode == "factor":
        try:
            return sp.factor(sp.expand(expr))
        except Exception:
            return sp.simplify(expr)
    return sp.simplify(expr)


def handle(mathjson, options=None):
    options = options or {}
    angle_mode = options.get("angle_mode", "rad")
    decimals = options.get("decimals")
    solve_for = options.get("solve_for")
    simplify_mode = options.get("simplify_mode")
    number_format = options.get("number_format", "standard")
    constants = options.get("constants") or {}
    if simplify_mode not in SIMPLIFY_MODES:
        simplify_mode = "auto"

    matrix_result = matrix_equation.try_unknown_matrix(mathjson, angle_mode=angle_mode, decimals=decimals)
    if matrix_result is not None:
        return matrix_result

    try:
        expr = to_sympy(mathjson, angle_mode)
    except Exception as e:
        return {"mode": "error", "result": str(e)}

    if constants:
        # Workspace values from earlier "name = ..." inputs this session
        # (see the frontend's workspace panel), substituted in the same way
        # /api/sample already does for a plot's slider constants. A bare
        # Symbol left in a system/ODE-system list is a solve-for target
        # marker (see _handle_system), not a value to substitute into.
        subs_map = {sp.Symbol(name): value for name, value in constants.items()}
        if isinstance(expr, list):
            expr = [item if isinstance(item, sp.Symbol) else item.subs(subs_map) for item in expr]
        else:
            expr = expr.subs(subs_map)

    if isinstance(expr, list):
        return _handle_system(expr, decimals, number_format)

    if isinstance(expr, sp.Equality):
        return _handle_equation(expr, decimals, number_format, solve_for)

    if isinstance(expr, (sp.core.relational.Relational, sp.And)):
        return _handle_inequality(expr, decimals)

    if isinstance(expr, sp.logic.boolalg.BooleanAtom):
        return {"mode": "check", "result": bool(expr)}

    try:
        simplified = _apply_simplify_mode(expr, simplify_mode)
    except Exception as e:
        return {"mode": "error", "result": str(e)}

    text, latex = _format_number(simplified, decimals, number_format)
    return {"mode": "evaluate", "result": text, "latex": latex}


def _handle_equation(expr, decimals, number_format, solve_for=None):
    if expr.atoms(sp.Derivative):
        return _handle_ode(expr, decimals, number_format)

    symbols = expr.free_symbols

    if len(symbols) == 0:
        diff = sp.simplify(expr.lhs - expr.rhs)
        return {"mode": "check", "result": bool(diff == 0)}

    if solve_for is not None:
        # Solving for one named variable while the rest stay symbolic (e.g.
        # x^2+y^2=25 solved for y) is well-defined for any number of free
        # symbols, so this bypasses the "too many variables" gate below —
        # it's only the no-target case that's genuinely ambiguous.
        symbol = sp.Symbol(solve_for)
        if symbol not in symbols:
            return {"mode": "error", "result": f"'{solve_for}' does not appear in this equation"}
    elif len(symbols) > 1:
        # No target variable named and more than one free symbol: same
        # situation _handle_system solves for a real system, just with one
        # equation instead of several. sp.solve happily leaves symbols it
        # can't pin down free (e.g. solving f*x = 3 for [f, x] returns
        # f = 3/x, x left open) rather than requiring every unknown to be
        # resolved, so routing through the same underdetermined-system path
        # covers this instead of refusing outright.
        return _handle_system([expr], decimals, number_format)
    else:
        symbol = next(iter(symbols))

    try:
        solved = solve_equation(expr, symbol)
    except Exception as e:
        return {"mode": "error", "result": str(e)}

    displayed = [_format_number(s, decimals, number_format) for s in solved["solutions"]]
    response = {
        "mode": "solve",
        "method": solved["method"],
        "result": [text for text, _ in displayed],
    }
    if displayed:
        symbol_latex = sp.latex(symbol)
        parts = [f"{symbol_latex} = {latex}" for _, latex in displayed]
        response["latex"] = ", ".join(parts)
        response["latexParts"] = parts
    return response


def _handle_system(equations, decimals, number_format):
    if not equations:
        return {"mode": "error", "result": "empty system"}

    # A bare symbol inside the { } (not its own equation) names which
    # variable/function to isolate — {x+y=9, x-y=3, x} solves the system but
    # only reports x, and for an underdetermined system like {x+y=9, x} it
    # rearranges the single equation to give x in terms of y.
    targets = [e for e in equations if isinstance(e, sp.Symbol)]
    eqs = [e for e in equations if not isinstance(e, sp.Symbol)]
    if not eqs:
        return {"mode": "error", "result": "a system needs at least one equation"}
    if not all(isinstance(eq, sp.Equality) for eq in eqs):
        return {"mode": "error", "result": "each entry in a system must be an equation"}

    if any(eq.atoms(sp.Derivative) for eq in eqs):
        return _handle_ode_system(eqs, targets, decimals, number_format)

    symbols = sorted(set().union(*(eq.free_symbols for eq in eqs)), key=lambda s: s.name)
    for target in targets:
        if target not in symbols:
            return {"mode": "error", "result": f"'{target}' does not appear in this system"}
    if not symbols:
        diffs = [sp.simplify(eq.lhs - eq.rhs) for eq in eqs]
        return {"mode": "check", "result": all(d == 0 for d in diffs)}

    # Solving for the requested target(s) first (ahead of the remaining
    # symbols) is what makes sympy leave the *other* variables free instead
    # of the target itself, when the system is underdetermined.
    symbol_order = targets + [s for s in symbols if s not in targets] if targets else symbols

    try:
        solutions = solve_system(eqs, symbol_order)
    except NotImplementedError:
        return {"mode": "system", "method": "unsolved", "result": []}
    except Exception as e:
        return {"mode": "error", "result": str(e)}

    lines, latex_parts = [], []
    for solution in solutions:
        # Underdetermined systems leave some symbols out of the dict (they
        # stay free); only the ones sympy actually solved for are shown.
        items = sorted(solution.items(), key=lambda kv: kv[0].name)
        if targets:
            items = [(sym, val) for sym, val in items if sym in targets]
        displayed = [(sym, _format_number(val, decimals, number_format)) for sym, val in items]
        lines.append(", ".join(f"{sym} = {text}" for sym, (text, _) in displayed))
        latex_parts.append(", \\ ".join(f"{sp.latex(sym)} = {latex}" for sym, (_, latex) in displayed))

    if targets and solutions and not any(lines):
        return {"mode": "error", "result": "couldn't isolate " + ", ".join(str(t) for t in targets)}

    response = {"mode": "system", "result": lines}
    if latex_parts:
        response["latex"] = "; ".join(latex_parts)
        response["latexParts"] = latex_parts
    return response


def _handle_ode(expr, decimals, number_format):
    if not expr.atoms(sp.core.function.AppliedUndef):
        return {"mode": "error", "result": "couldn't find the unknown function in this ODE"}
    return _solve_ode([expr], [], decimals, number_format)


def _handle_ode_system(eqs, targets, decimals, number_format):
    funcs = {atom.func for eq in eqs for atom in eq.atoms(sp.core.function.AppliedUndef)}
    if not funcs:
        return {"mode": "error", "result": "couldn't find any unknown functions in this system"}

    known_names = {f.__name__ for f in funcs}
    for target in targets:
        if target.name not in known_names:
            return {"mode": "error", "result": f"'{target}' does not appear in this system"}

    return _solve_ode(eqs, targets, decimals, number_format)


def _solve_ode(equations, targets, decimals, number_format):
    """Shared by a lone ODE (targets always empty) and a { }-wrapped system
    of ODEs. sp.dsolve treats a list uniformly regardless of length, so a
    single equation routes through here the same way — including the
    formerly-unsupported case of one equation naming more than one unknown
    function (it comes back in terms of the other, e.g. x(t) = C1 + ∫y(t)dt,
    which is the mathematically honest answer rather than a hard error)."""
    try:
        solutions = sp.dsolve(equations)
    except NotImplementedError:
        return {"mode": "ode", "result": "no closed form solution"}
    except Exception as e:
        return {"mode": "error", "result": str(e)}

    if targets:
        wanted = {t.name for t in targets}
        solutions = [s for s in solutions if s.lhs.func.__name__ in wanted]
        if not solutions:
            return {"mode": "error", "result": "couldn't isolate " + ", ".join(str(t) for t in targets)}

    displayed = [_format_number(s, decimals, number_format) for s in solutions]
    return {
        "mode": "ode",
        "result": "; ".join(text for text, _ in displayed),
        "latex": ", \\ ".join(latex for _, latex in displayed),
    }


def _handle_inequality(expr, decimals):
    symbols = expr.free_symbols
    if not symbols:
        return {"mode": "check", "result": bool(expr)}
    if len(symbols) > 1:
        return {"mode": "error", "result": "inequalities with more than one variable aren't supported yet"}
    symbol = next(iter(symbols))

    # A chained/compound inequality like 1 < x < 5 parses as And(Lt(1,x),
    # Lt(x,5)); solve_univariate_inequality only takes one relation at a
    # time, so each piece is solved separately and the results intersected.
    parts = expr.args if isinstance(expr, sp.And) else [expr]
    try:
        solution = sp.Intersection(*(
            sp.solve_univariate_inequality(part, symbol, relational=False) for part in parts
        ))
    except NotImplementedError as e:
        return {"mode": "error", "result": f"couldn't solve this inequality: {e}"}
    except Exception as e:
        return {"mode": "error", "result": str(e)}

    if solution == sp.S.EmptySet:
        return {"mode": "solve", "result": ["no solution"], "latex": r"\varnothing"}

    display = _to_display(solution, decimals)
    result = f"{symbol} ∈ {sp.pretty(display, use_unicode=True)}"
    latex = f"{sp.latex(symbol)} \\in {sp.latex(display)}"
    return {"mode": "solve", "method": "inequality", "result": [result], "latex": latex}
