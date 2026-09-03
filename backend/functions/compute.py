import json
import math
import threading
from collections import OrderedDict

import sympy as sp
from .mathjson import (
    to_sympy, substitute_functions, retry_unresolved_integrals, sympify_constant,
    has_unresolved_integral, _run_with_timeout, _exact_mathjson,
)
from .solvers import solve_equation
from .solvers import matrix_equation
from .solvers.system import solve_system
from .format_result import (
    to_display as _to_display,
    to_engineering as _to_engineering,
    cap_decimals as _cap_decimals,
    to_latex as _to_latex,
)

SIMPLIFY_MODES = {"auto", "expand", "factor"}
NUMBER_FORMATS = ("standard", "decimal", "engineering")

# Everything upstream of formatting — parsing the MathJSON, substituting
# workspace constants, simplifying, and solving/integrating/dsolve-ing — is
# unaffected by decimals/number_format: those two only change how an
# already-resolved sympy value gets turned into text. Re-running all of that
# (an integral can take seconds) just because the user dragged the decimals
# slider or flipped Standard/Decimal/Engineering was pure waste, so `handle`
# splits into `_resolve` (the expensive, decimals-independent part, cached
# below) and `_render` (cheap, called once per requested format). Keyed on
# everything that *does* change the resolved value; decimals/number_format
# are deliberately left out of the key.
_RESOLVE_CACHE = OrderedDict()
_RESOLVE_CACHE_MAX = 64
# app.py runs Flask threaded=True specifically so an overlapping request
# (e.g. two computes in flight from fast typing) doesn't block behind a slow
# one — meaning this cache is genuinely accessed from multiple threads, not
# just in theory. A plain dict's individual ops are safe under the GIL, but
# the get-then-maybe-insert sequence below isn't atomic across the two, so
# without this lock two concurrent misses on the same new key could both
# resolve it (wasted duplicate work, not corruption) or the LRU eviction
# could trip over itself. The lock is only ever held for cheap dict
# bookkeeping, never across the expensive _resolve() call itself.
_CACHE_LOCK = threading.Lock()


def _cache_key(mathjson, angle_mode, simplify_mode, solve_for, constants, functions, engine_preference):
    # json.dumps(..., sort_keys=True) rather than something hashable like a
    # tuple: mathjson is an arbitrary nested list/dict straight from the
    # request body, and constants/functions are plain dicts — both need a
    # stable string form more than they need speed here.
    return json.dumps(
        [mathjson, angle_mode, simplify_mode, solve_for, constants, functions, engine_preference],
        sort_keys=True, default=str,
    )


def _cache_get(key):
    with _CACHE_LOCK:
        entry = _RESOLVE_CACHE.get(key)
        if entry is not None:
            _RESOLVE_CACHE.move_to_end(key)
        return entry


def _cache_put(key, value):
    with _CACHE_LOCK:
        _RESOLVE_CACHE[key] = value
        _RESOLVE_CACHE.move_to_end(key)
        if len(_RESOLVE_CACHE) > _RESOLVE_CACHE_MAX:
            _RESOLVE_CACHE.popitem(last=False)


STANDARD_MAX_LEN = 200  # printed-string length past which "exact" stops being useful to look at


def _friendly_exception_message(e):
    """Some sympy solve internals raise Python's own "too many digits for
    integer string conversion" safety error (see _safe_str_latex's own
    comment on this same limit) from deep inside their own logic, not from
    anything this app itself tries to print — confirmed live for a single
    equation left with more than one free symbol (no solve_for target and
    no workspace value for the other symbol): sp.solve's dict-based system
    solver, trying to express one unknown fully in terms of the other,
    builds an internal exact value so enormous it can't even convert that
    to a string for its own bookkeeping. That raw text isn't informative to
    a user as an "error" result, so it's swapped for a plain, honest one.
    """
    if "integer string conversion" in str(e):
        return "couldn't find a solution simple enough to display — try giving the other variable(s) a value first"
    return str(e)


def _safe_str_latex(value, fallback_decimals=15):
    """str()/latex() for an exact value, falling back to a fixed-decimal
    rendering either if it contains an integer too large for Python to
    convert to a string at all — a genuine CPython 3.11+ safety limit
    (~4300 digits, `sys.get_int_max_str_digits()`), not a bug in this app,
    but a perfectly ordinary equation solve can trigger it: e.g. solving a
    base-10-log equation for a variable whose coefficient happens to come
    out near zero drives that variable up to something like 10**20000 —
    or if it's merely absurdly long without hitting that hard limit: a
    "closed form" riddled with huge embedded integers (confirmed live from
    an otherwise ordinary equation mixing several explicit-base logs — the
    exact irrational log(10)/log(50)/etc. ratios involved don't reduce to
    anything clean, so sp.solve's exact answer, while technically valid, is
    a many-hundred-digit nested-radical mess) is just as useless to a user
    as one that fails outright. Either way, evalf() sidesteps the problem
    entirely — it renders in scientific notation / a plain short decimal
    instead of expanding every digit — so degrading exact/Standard display
    to a modest decimal one is the only way to show something actually
    readable instead of a raw crash or a wall of digits.
    """
    try:
        text, latex = str(value), _to_latex(value)
        if len(text) <= STANDARD_MAX_LEN:
            return text, latex
    except ValueError:
        pass
    decimals = _cap_decimals(value, fallback_decimals) or fallback_decimals
    approx = value.evalf(decimals)
    return str(approx), _to_latex(approx)


def _format_number(value, decimals, number_format, complex_form="rectangular"):
    """(text, latex) for a value, in the requested display mode. Engineering
    notation only replaces the default sympy printing for a plain real
    number — anything else (symbolic, complex, an equation, a set, ...)
    keeps to_display's normal str()/latex() form.

    number_format (not decimals being None/not-None) is what decides exact
    vs. decimal display now, so a cached resolved value can be re-rendered
    in any of the three formats on demand — the "already numeric" trap this
    guards against: naively evalf-ing a value to more decimals than it
    actually carries (see to_display's own precision cap) would otherwise
    look like real added precision from the cache when it's just padding.

    complex_form == "polar" overrides every number_format uniformly for a
    genuine complex number (see _format_polar) — checked first and ahead of
    everything below, rather than folded into the standard/decimal branches,
    since it needs Abs/arg computed independently instead of value's normal
    str()/evalf() path either way.
    """
    if complex_form == "polar" and _is_complex_number(value):
        return _format_polar(value, None if number_format == "standard" else decimals)

    if number_format == "standard":
        display = _to_display(value, None)
        return _safe_str_latex(display)

    decimals = _cap_decimals(value, decimals)
    display = _to_display(value, decimals)
    if number_format == "engineering" and decimals is not None:
        engineering = _to_engineering(display, decimals)
        if engineering is not None:
            return engineering
    # decimals can still be None here (Decimal/Engineering requested but no
    # decimals value came through) — to_display's own None-means-"don't
    # evalf" contract then leaves an un-evalf'd exact value behind, so this
    # needs the same huge-integer guard as the Standard branch above, not
    # just a plain str()/latex() call.
    return _safe_str_latex(display)


def _is_complex_number(value):
    """A genuine complex NUMBER (50 - 30i, (1+i)*(2-3i), ...) as opposed to
    a symbolic expression that merely contains I (x + I*y has no single
    well-defined polar form) or a real number (nothing to convert). Scoping
    to this — rather than "any expression containing I" — is what keeps the
    polar setting below from turning Abs(x+I*y)*exp(I*arg(x+I*y)) loose on
    a symbolic result instead of leaving it alone.
    """
    try:
        return bool(value.is_number) and value.has(sp.I) and sp.im(value) != 0
    except Exception:
        return False


def _format_polar(value, decimals):
    """Text/latex for a genuine complex number in polar r*e^(i*theta) form —
    the user-facing "Complex form: Polar" setting, independent of
    simplify_mode and applied uniformly regardless of number_format.

    decimals=None (Standard/exact mode): Abs/arg simplified symbolically, so
    a nice angle (pi/2, ...) still collapses straight back to the simpler
    rectangular-equivalent form on its own — sp.exp(I*pi/2) auto-evaluates
    to I at construction time, so e.g. sqrt(-4) still prints as 2*I here,
    not the technically-valid but needlessly ugly 2*exp(I*pi/2).

    Otherwise (Decimal/Engineering): evalf-ing the whole r*exp(I*theta)
    expression at once collapses straight back to a rectangular re/im pair —
    mpmath's complex evalf has no polar internal form to preserve — so r and
    theta are evalf'd independently (each capped the same "already numeric"
    honest-precision way as everywhere else) and the polar text/latex is
    built by hand instead. Engineering mode gets the same plain decimal
    r/theta as Decimal mode: a mantissa/exponent pair has no sensible
    meaning for a magnitude+phase pair.
    """
    r = sp.simplify(sp.Abs(value))
    theta = sp.simplify(sp.arg(value))
    if decimals is None:
        polar = r * sp.exp(sp.I * theta)
        return _safe_str_latex(polar)
    decimals = _cap_decimals(value, decimals)
    r_val, theta_val = r.evalf(decimals), theta.evalf(decimals)
    # theta before "i", not after: theta_val is a plain signed decimal
    # (e.g. -0.982793723247), so "i {theta_val}" for a negative angle prints
    # as the ambiguous-looking "i -0.982793723247" — two adjacent tokens
    # with no operator between them, easily misread as a subtraction.
    # "{theta_val} i" reads unambiguously either way (positive or negative)
    # and matches the plain-text form's own theta-then-I order right above.
    return f"{r_val}*exp({theta_val}*I)", f"{_to_latex(r_val)} e^{{{_to_latex(theta_val)} i}}"


SIMPLIFY_TIMEOUT = 4  # seconds — matches solvers/algebraic.py's SOLVE_TIMEOUT


def _safe_simplify(fn, original):
    """Runs a simplify/factor attempt on a worker thread, capped at
    SIMPLIFY_TIMEOUT, and discards a result that introduces free symbols not
    present in `original` — returns None on either failure.

    Confirmed live: sp.factor() on an expression containing a huge (30+
    digit) exact Rational — which is exactly what you get once a workspace-
    cached irrational constant (e.g. rho = 1/sqrt(2), itself already an ugly
    ~16-digit Rational reconstructed from a stored double — see
    sympify_constant's comment) gets squared or otherwise combined before
    reaching "Factor" mode — doesn't just get slow, it can hang
    indefinitely (pegging a CPU core with no way to interrupt it; sympy has
    no timeout of its own anywhere in factor/simplify, see
    _run_with_timeout's comment in mathjson.py). Confirmed live a second
    way, on a different run of the *identical* input: it can also return
    silently and fast with outright corrupted output — free symbols that
    were never in the input (e.g. exp(rho**2) "factored" into exp(h*r) for
    undeclared h/r) — almost certainly the same kind of per-process hash-
    seed nondeterminism already documented for sp.solve() elsewhere in this
    file steering factor's internal algorithm down a different, buggy
    branch each run, not something a retry can reliably avoid. A pure
    algebraic simplification can never legitimately introduce a new free
    symbol, so the free_symbols check below catches that case even on a
    run fast enough to dodge the timeout.
    """
    try:
        result = _run_with_timeout(fn, on_timeout=None, timeout=SIMPLIFY_TIMEOUT)
    except Exception:
        return None
    if result is None or not result.free_symbols <= original.free_symbols:
        return None
    return result


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
        result = _safe_simplify(lambda: sp.factor(sp.expand(expr)), expr)
        if result is not None:
            return result
        return _safe_simplify(lambda: sp.simplify(expr), expr) or expr
    return _safe_simplify(lambda: sp.simplify(expr), expr) or expr


def handle(mathjson, options=None):
    options = options or {}
    angle_mode = options.get("angle_mode", "rad")
    decimals = options.get("decimals")
    solve_for = options.get("solve_for")
    simplify_mode = options.get("simplify_mode")
    number_format = options.get("number_format", "standard")
    complex_form = options.get("complex_form", "rectangular")
    constants = options.get("constants") or {}
    functions = options.get("functions") or {}
    engine_preference = options.get("engine_preference")
    if engine_preference not in ("sympy", "maxima"):
        engine_preference = "sympy"
    if simplify_mode not in SIMPLIFY_MODES:
        simplify_mode = "auto"
    if number_format not in NUMBER_FORMATS:
        number_format = "standard"
    if complex_form not in ("rectangular", "polar"):
        complex_form = "rectangular"

    key = _cache_key(mathjson, angle_mode, simplify_mode, solve_for, constants, functions, engine_preference)
    resolved = _cache_get(key)
    if resolved is None:
        resolved = _resolve(mathjson, angle_mode, simplify_mode, solve_for, constants, functions, engine_preference)
        _cache_put(key, resolved)

    # complex_form is a pure render-time choice (like decimals/number_format)
    # — it never changes the resolved value, just how a complex NUMBER within
    # it gets printed — so it's deliberately left out of the cache key above,
    # same reasoning as decimals/number_format.
    response = _render(resolved, decimals, number_format, complex_form)
    if resolved["kind"] in ("evaluate", "solve", "system", "ode", "pde", "matrix", "inequality"):
        # Every format the front-end's Standard/Decimal/Engineering toggle
        # can switch to, computed once up front from the same resolved
        # value, so flipping that toggle is a local re-render — no round
        # trip, no re-solving — instead of a fresh /api/compute call.
        response["formats"] = {fmt: _render(resolved, decimals, fmt, complex_form) for fmt in NUMBER_FORMATS}
    return response


def _try_matrix_assignment(mathjson, angle_mode, engine_preference, constants, functions, matrix_constants):
    """"name = <matrix-valued expression>" (e.g. "M = [[1,2],[3,4]]", or "M =
    A + B" for two already-saved matrix variables) can't be represented as a
    sympy Equality at all: sp.Eq(Symbol, Matrix) auto-evaluates straight to
    plain BooleanFalse rather than staying symbolic (a Matrix isn't a scalar
    Eq can compare a free Symbol against), so the generic to_sympy("Equal")/
    _resolve_equation path below silently turned every matrix assignment
    into a false "check" result instead of ever solving/saving it — a bare
    Symbol assigned a scalar never hits this, since sp.Eq(Symbol, number)
    stays symbolic and _resolve_equation solves it normally.

    Intercepted here, before to_sympy ever sees the whole "Equal" node, the
    same way try_unknown_matrix() pre-empts a different matrix-equation
    shape above. Returns None (falling through to the generic path) unless
    one side is a bare name and the other resolves to a fully-substituted,
    free-symbol-free Matrix — in particular, a self-referencing redefinition
    like "M = M + [[1,0],[0,1]]" isn't handled here (matrix equations aren't
    solvable the way a scalar self-reference is), and correctly falls
    through instead of silently substituting the old value into both sides.
    """
    if not (isinstance(mathjson, list) and len(mathjson) == 3 and mathjson[0] == "Equal"):
        return None
    lhs, rhs = mathjson[1], mathjson[2]
    for name_node, value_node in ((lhs, rhs), (rhs, lhs)):
        if not isinstance(name_node, str):
            continue
        try:
            expr = to_sympy(value_node, angle_mode, engine_preference, matrix_constants)
        except Exception:
            continue
        if not isinstance(expr, sp.MatrixBase):
            continue
        if functions:
            expr = substitute_functions(expr, functions, angle_mode)
        if constants:
            subs_map = {sp.Symbol(n): sympify_constant(v) for n, v in constants.items()}
            expr = expr.subs(subs_map)
        if expr.free_symbols:
            return None
        return {"kind": "evaluate", "value": expr}
    return None


def _resolve(mathjson, angle_mode, simplify_mode, solve_for, constants, functions, engine_preference):
    """The decimals/number_format-independent half of `handle`: parse, apply
    workspace substitutions, and simplify/solve/dsolve. Returns a small
    dict describing what was found — either a `kind` that still needs
    `_render` to turn into a response (a cached sympy value, waiting to be
    formatted), or `kind == "final"` for a response that's already
    complete (an error, a true/false check, ...) and just needs echoing
    back unchanged regardless of decimals/number_format.
    """
    matrix_result = matrix_equation.try_unknown_matrix(mathjson, angle_mode=angle_mode)
    if matrix_result is not None:
        return matrix_result

    # Matrix-shaped workspace constants (a prior "M = [[1,2],[3,4]]") have to
    # be substituted in at *parse* time, not after — see to_sympy's own
    # comment on this. Every other constant (scalar or complex) still goes
    # through the ordinary post-conversion substitution pass below,
    # unchanged.
    matrix_constants = {
        name: sympify_constant(value) for name, value in constants.items() if isinstance(value, list)
    } if constants else {}

    assignment_result = _try_matrix_assignment(
        mathjson, angle_mode, engine_preference, constants, functions, matrix_constants
    )
    if assignment_result is not None:
        return assignment_result

    try:
        expr = to_sympy(mathjson, angle_mode, engine_preference, matrix_constants)
    except Exception as e:
        return _final({"mode": "error", "result": str(e)})

    if functions:
        # Workspace function definitions from an earlier "f(x) = ..." input
        # (see the frontend's workspace panel) — done before the constants
        # substitution just below, so a constant referenced only inside a
        # function's stored body (f(x) := x^2 + a) is still exposed by the
        # time that substitution runs.
        expr = substitute_functions(expr, functions, angle_mode)

    if constants:
        # Workspace values from earlier "name = ..." inputs this session
        # (see the frontend's workspace panel), substituted in the same way
        # /api/sample already does for a plot's slider constants. A bare
        # Symbol left in a system/ODE-system list is a solve-for target
        # marker (see _resolve_system), not a value to substitute into.
        subs_map = {sp.Symbol(name): sympify_constant(value) for name, value in constants.items()}
        if isinstance(expr, list):
            expr = [item if isinstance(item, sp.Symbol) else item.subs(subs_map) for item in expr]
        else:
            expr = expr.subs(subs_map)

    pending_inverses = _find_inverse_markers(expr)
    if pending_inverses:
        expr, error = _resolve_inverse_markers(expr, pending_inverses, functions, angle_mode)
        if error is not None:
            return _final({"mode": "error", "result": error})

    if isinstance(expr, list):
        return _resolve_system(expr)

    if isinstance(expr, sp.Equality):
        return _resolve_equation(expr, solve_for)

    if isinstance(expr, (sp.core.relational.Relational, sp.And)):
        return _resolve_inequality(expr)

    if isinstance(expr, sp.logic.boolalg.BooleanAtom):
        return _final({"mode": "check", "result": bool(expr)})

    # An unevaluated Integral left in the tree means neither sympy's closed-
    # form solvers nor (for a definite integral) the numeric-quadrature
    # fallback in mathjson._integrate could resolve this — most commonly an
    # indefinite integral whose antiderivative needs a special function
    # (polylogarithms, etc.) sympy's Risch-based integrator doesn't reach, or
    # a definite one whose numeric fallback also failed (a genuine
    # singularity, say). Previously this fell straight through to the
    # generic path below and came back looking like a normal answer — e.g.
    # "C - Integral(...)" — identically in both exact and decimal mode,
    # since evalf() on a still-free variable has nothing to numerically
    # evaluate to either. Same "no closed form" honesty _solve_ode already
    # gives instead of faking success.
    if has_unresolved_integral(expr):
        # A workspace function whose body integrates over one variable
        # while depending on its own parameter (see
        # retry_unresolved_integrals's own comment) parses with that
        # parameter still free, so the numeric fallback couldn't run yet at
        # that point — retried here now that substitution above has
        # supplied a concrete value, before giving up on it as genuinely
        # unsolvable.
        expr = retry_unresolved_integrals(expr)
    if has_unresolved_integral(expr):
        return _final({"mode": "error", "result": "couldn't find a closed form for this integral"})

    try:
        simplified = _apply_simplify_mode(expr, simplify_mode)
    except Exception as e:
        return _final({"mode": "error", "result": str(e)})

    return {"kind": "evaluate", "value": simplified}


def _final(response):
    return {"kind": "final", "response": response}


def _find_inverse_markers(expr):
    """Finds every `__InverseFunctionOf__(fn, arg)` marker mathjson.py's
    OPS["InverseFunction"] leaves behind for a target it has no built-in
    inverse formula for (an elementary function like Sin is already resolved
    by that point — see its own comment). Those markers can only be resolved
    here, not in mathjson.py, because this is the first point with both the
    substituted expression and the workspace `functions` dict needed to know
    what the target name actually is.
    """
    items = expr if isinstance(expr, list) else [expr]
    return [
        call
        for item in items if hasattr(item, "atoms")
        for call in item.atoms(sp.core.function.AppliedUndef)
        if call.func.__name__ == "__InverseFunctionOf__"
    ]


def _resolve_inverse_markers(expr, calls, functions, angle_mode):
    """Substitutes each pending inverse-function marker with its actual
    value: a workspace function f(x) := ... becomes an equation body(t) =
    arg, solved for t via the same closed-form/numerical pipeline any other
    equation in this app already goes through. A name with no workspace
    definition — or more/fewer than one parameter, which "the inverse"
    isn't well-defined for — genuinely has no inverse to compute, reported
    as a plain error rather than a crash. A non-injective f (x^2, sin, ...)
    can have more than one preimage; picking sympy's first solution is an
    arbitrary but honest choice, the same one-closed-form-not-every-branch
    tradeoff sp.solve's own result ordering already makes everywhere else.
    """
    subs = {}
    for call in calls:
        fn_symbol, arg = call.args
        name = str(fn_symbol)
        spec = functions.get(name)
        if not spec or len(spec.get("params", [])) != 1:
            return None, f"no inverse exists for '{name}'"
        param = sp.Symbol(spec["params"][0])
        try:
            body = to_sympy(spec["body"], angle_mode)
            equation = substitute_functions(sp.Eq(body, arg), functions, angle_mode)
            solved = solve_equation(equation, param)
        except Exception:
            return None, f"no inverse exists for '{name}'"
        solutions = solved["solutions"]
        if not solutions:
            return None, f"no inverse exists for '{name}'"
        subs[call] = solutions[0]

    if isinstance(expr, list):
        return [item.subs(subs) if hasattr(item, "subs") else item for item in expr], None
    return expr.subs(subs), None


def _numeric_value(value):
    """Full double-precision {re, im} (or plain float when real) for an
    already-resolved sympy result, independent of the requested decimals/
    number_format. Used only by the frontend to cache a workspace
    assignment's RHS at full precision (see app.js's evalNumeric and its own
    comment on why a local compute-engine recompile isn't reliable once the
    RHS references another already-complex workspace variable) — never for
    display, so this deliberately ignores the precision-honesty concerns
    _format_number/cap_decimals exist for. None when the value isn't a
    plain number (still has free symbols, is a set, ...) or isn't finite.

    A resolved sp.Matrix (a saved "M = [[1,2],[3,4]]") gets the same
    treatment per-cell instead: a plain nested list of rows, each cell the
    same {re, im}-or-plain-float shape a scalar result would be — this is
    also exactly the wire shape sympify_constant expects back on a later
    request, since workspace.js just forwards whatever setVar() was given
    straight through as that variable's `constants` entry.
    """
    if isinstance(value, sp.MatrixBase):
        rows = [[_numeric_value(value[r, c]) for c in range(value.cols)] for r in range(value.rows)]
        return None if any(cell is None for row in rows for cell in row) else rows
    if not getattr(value, "is_number", False):
        return None
    try:
        n = sp.N(value, 17)
        re, im = float(sp.re(n)), float(sp.im(n))
    except Exception:
        return None
    if not (math.isfinite(re) and math.isfinite(im)):
        return None
    return {"re": re, "im": im} if im != 0 else re


def _render(resolved, decimals, number_format, complex_form="rectangular"):
    kind = resolved["kind"]

    if kind == "final":
        return dict(resolved["response"])

    if kind == "evaluate":
        text, latex = _format_number(resolved["value"], decimals, number_format, complex_form)
        return {
            "mode": "evaluate", "result": text, "latex": latex,
            "numeric": _numeric_value(resolved["value"]),
            "exact": _exact_mathjson(resolved["value"]),
        }

    if kind == "solve":
        displayed = [_format_number(s, decimals, number_format, complex_form) for s in resolved["solutions"]]
        response = {
            "mode": "solve",
            "method": resolved["method"],
            "result": [text for text, _ in displayed],
        }
        if len(resolved["solutions"]) == 1:
            response["numeric"] = _numeric_value(resolved["solutions"][0])
            response["exact"] = _exact_mathjson(resolved["solutions"][0])
        if displayed:
            symbol_latex = _to_latex(resolved["symbol"])
            parts = [f"{symbol_latex} = {latex}" for _, latex in displayed]
            response["latex"] = ", ".join(parts)
            response["latexParts"] = parts
        return response

    if kind == "system":
        lines, latex_parts = [], []
        for items in resolved["solutions"]:
            displayed = [(sym, _format_number(val, decimals, number_format, complex_form)) for sym, val in items]
            lines.append(", ".join(f"{sym} = {text}" for sym, (text, _) in displayed))
            latex_parts.append(", \\ ".join(f"{_to_latex(sym)} = {latex}" for sym, (_, latex) in displayed))

        if resolved["targets"] and resolved["solutions"] and not any(lines):
            return {"mode": "error", "result": "couldn't isolate " + ", ".join(str(t) for t in resolved["targets"])}

        response = {"mode": "system", "result": lines}
        if latex_parts:
            response["latex"] = "; ".join(latex_parts)
            response["latexParts"] = latex_parts
        return response

    if kind == "ode":
        displayed = [_format_number(s, decimals, number_format, complex_form) for s in resolved["solutions"]]
        return {
            "mode": "ode",
            "result": "; ".join(text for text, _ in displayed),
            "latex": ", \\ ".join(latex for _, latex in displayed),
        }

    if kind == "pde":
        displayed = [_format_number(s, decimals, number_format, complex_form) for s in resolved["solutions"]]
        return {
            "mode": "pde",
            "result": "; ".join(text for text, _ in displayed),
            "latex": ", \\ ".join(latex for _, latex in displayed),
        }

    if kind == "matrix":
        display = _to_display(resolved["matrix"], decimals if number_format != "standard" else None)
        return {"mode": "solve", "method": "matrix_inverse", "result": [str(display)], "latex": _to_latex(display)}

    if kind == "inequality":
        display = _to_display(resolved["solution"], decimals if number_format != "standard" else None)
        symbol = resolved["symbol"]
        result = f"{symbol} ∈ {sp.pretty(display, use_unicode=True)}"
        latex = f"{_to_latex(symbol)} \\in {_to_latex(display)}"
        return {"mode": "solve", "method": "inequality", "result": [result], "latex": latex}

    raise ValueError(f"unknown resolved kind: {kind!r}")  # pragma: no cover


def _is_pde(equations):
    """True when any unknown function actually differentiated is applied to
    more than one argument (u(x, t), not f(x)) — the same test sympy's own
    classify_ode uses internally to reject a multivariable function with
    "only work with functions of one variable" before this ever reaches it.
    """
    return any(
        len(f.args) > 1
        for eq in equations
        for f in eq.atoms(sp.core.function.AppliedUndef)
    )


def _resolve_equation(expr, solve_for=None):
    if expr.atoms(sp.Derivative):
        if _is_pde([expr]):
            return _resolve_pde(expr)
        return _resolve_ode([expr], [])

    symbols = expr.free_symbols

    if len(symbols) == 0:
        diff = sp.simplify(expr.lhs - expr.rhs)
        return _final({"mode": "check", "result": bool(diff == 0)})

    if solve_for is not None:
        # Solving for one named variable while the rest stay symbolic (e.g.
        # x^2+y^2=25 solved for y) is well-defined for any number of free
        # symbols, so this bypasses the "too many variables" gate below —
        # it's only the no-target case that's genuinely ambiguous.
        symbol = sp.Symbol(solve_for)
        if symbol not in symbols:
            return _final({"mode": "error", "result": f"'{solve_for}' does not appear in this equation"})
    elif len(symbols) > 1:
        # No target variable named and more than one free symbol: same
        # situation _resolve_system solves for a real system, just with one
        # equation instead of several. sp.solve happily leaves symbols it
        # can't pin down free (e.g. solving f*x = 3 for [f, x] returns
        # f = 3/x, x left open) rather than requiring every unknown to be
        # resolved, so routing through the same underdetermined-system path
        # covers this instead of refusing outright.
        return _resolve_system([expr])
    else:
        symbol = next(iter(symbols))

    try:
        solved = solve_equation(expr, symbol)
    except Exception as e:
        return _final({"mode": "error", "result": _friendly_exception_message(e)})

    return {"kind": "solve", "method": solved["method"], "symbol": symbol, "solutions": solved["solutions"]}


def _resolve_system(equations):
    if not equations:
        return _final({"mode": "error", "result": "empty system"})

    # A bare symbol inside the { } (not its own equation) names which
    # variable/function to isolate — {x+y=9, x-y=3, x} solves the system but
    # only reports x, and for an underdetermined system like {x+y=9, x} it
    # rearranges the single equation to give x in terms of y.
    targets = [e for e in equations if isinstance(e, sp.Symbol)]
    eqs = [e for e in equations if not isinstance(e, sp.Symbol)]
    if not eqs:
        return _final({"mode": "error", "result": "a system needs at least one equation"})
    if not all(isinstance(eq, sp.Equality) for eq in eqs):
        return _final({"mode": "error", "result": "each entry in a system must be an equation"})

    if any(eq.atoms(sp.Derivative) for eq in eqs):
        if len(eqs) == 1 and _is_pde(eqs):
            return _resolve_pde(eqs[0])
        return _resolve_ode_system(eqs, targets)

    symbols = sorted(set().union(*(eq.free_symbols for eq in eqs)), key=lambda s: s.name)
    for target in targets:
        if target not in symbols:
            return _final({"mode": "error", "result": f"'{target}' does not appear in this system"})
    if not symbols:
        diffs = [sp.simplify(eq.lhs - eq.rhs) for eq in eqs]
        return _final({"mode": "check", "result": all(d == 0 for d in diffs)})

    # Solving for the requested target(s) first (ahead of the remaining
    # symbols) is what makes sympy leave the *other* variables free instead
    # of the target itself, when the system is underdetermined.
    symbol_order = targets + [s for s in symbols if s not in targets] if targets else symbols

    try:
        solutions = solve_system(eqs, symbol_order)
    except NotImplementedError:
        return _final({"mode": "system", "method": "unsolved", "result": []})
    except Exception as e:
        return _final({"mode": "error", "result": _friendly_exception_message(e)})

    resolved_solutions = []
    for solution in solutions:
        # Underdetermined systems leave some symbols out of the dict (they
        # stay free); only the ones sympy actually solved for are shown.
        items = sorted(solution.items(), key=lambda kv: kv[0].name)
        if targets:
            items = [(sym, val) for sym, val in items if sym in targets]
        resolved_solutions.append(items)

    return {"kind": "system", "targets": targets, "solutions": resolved_solutions}


def _resolve_ode(equations, targets):
    if not targets and not equations[0].atoms(sp.core.function.AppliedUndef):
        return _final({"mode": "error", "result": "couldn't find the unknown function in this ODE"})
    return _solve_ode(equations, targets)


def _resolve_ode_system(eqs, targets):
    funcs = {atom.func for eq in eqs for atom in eq.atoms(sp.core.function.AppliedUndef)}
    if not funcs:
        return _final({"mode": "error", "result": "couldn't find any unknown functions in this system"})

    known_names = {f.__name__ for f in funcs}
    for target in targets:
        if target.name not in known_names:
            return _final({"mode": "error", "result": f"'{target}' does not appear in this system"})

    return _solve_ode(eqs, targets)


def _solve_ode(equations, targets):
    """Shared by a lone ODE (targets always empty) and a { }-wrapped system
    of ODEs — including the formerly-unsupported case of one equation naming
    more than one unknown function (it comes back in terms of the other,
    e.g. x(t) = C1 + ∫y(t)dt, which is the mathematically honest answer
    rather than a hard error).

    sp.dsolve does NOT treat a list uniformly regardless of length, despite
    appearances: a length-1 list routes through its multi-equation system
    solver rather than the single-equation path, which skips the odesimp()
    cleanup the single-equation path applies automatically — confirmed live
    on f''(x)+2f(x)=3x, which came back as the fully-correct but unsimplified
    sqrt(2)*C1*sin(sqrt(2)*x)/2 + ... + 3*x*sin(sqrt(2)*x)**2/2 +
    3*x*cos(sqrt(2)*x)**2/2 through dsolve([eq]), vs. the same eq passed
    bare collapsing straight to C1*sin(sqrt(2)*x) + C2*cos(sqrt(2)*x) +
    3*x/2. So a single equation is always unwrapped and passed bare — even
    when it's the lone equation of a `{ }`-wrapped system with an explicit
    solve-for target — and only a genuine multi-equation system (which has
    no bare-call equivalent) still goes through dsolve() as a list.
    """
    try:
        if len(equations) == 1:
            result = sp.dsolve(equations[0])
            solutions = result if isinstance(result, list) else [result]
        else:
            solutions = sp.dsolve(equations)
    except NotImplementedError:
        return _final({"mode": "ode", "result": "no closed form solution"})
    except Exception as e:
        return _final({"mode": "error", "result": str(e)})

    if targets:
        wanted = {t.name for t in targets}
        solutions = [s for s in solutions if s.lhs.func.__name__ in wanted]
        if not solutions:
            return _final({"mode": "error", "result": "couldn't isolate " + ", ".join(str(t) for t in targets)})

    return {"kind": "ode", "solutions": solutions}


def _resolve_pde(equation):
    if not equation.atoms(sp.core.function.AppliedUndef):
        return _final({"mode": "error", "result": "couldn't find the unknown function in this PDE"})
    return _solve_pde(equation)


def _solve_pde(equation):
    """sp.pdsolve only covers first-order PDEs (linear/quasilinear, via the
    method of characteristics) — a genuine second-order PDE like the heat or
    wave equation raises NotImplementedError, same "no closed form" honesty
    _solve_ode already gives rather than pretending nothing was asked.
    Unlike dsolve, pdsolve has no list-of-equations form, so this only ever
    handles one equation — a PDE system is out of scope.
    """
    try:
        solution = sp.pdsolve(equation)
    except NotImplementedError:
        return _final({"mode": "pde", "result": "no closed form solution"})
    except Exception as e:
        return _final({"mode": "error", "result": str(e)})

    solutions = solution if isinstance(solution, list) else [solution]
    return {"kind": "pde", "solutions": solutions}


def _resolve_inequality(expr):
    symbols = expr.free_symbols
    if not symbols:
        return _final({"mode": "check", "result": bool(expr)})
    if len(symbols) > 1:
        return _final({"mode": "error", "result": "inequalities with more than one variable aren't supported yet"})
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
        return _final({"mode": "error", "result": f"couldn't solve this inequality: {e}"})
    except Exception as e:
        return _final({"mode": "error", "result": str(e)})

    if solution == sp.S.EmptySet:
        return _final({"mode": "solve", "result": ["no solution"], "latex": r"\varnothing"})

    return {"kind": "inequality", "symbol": symbol, "solution": solution}
