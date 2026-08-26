import operator
import threading
from functools import reduce

import mpmath
import sympy as sp
from sympy.integrals.manualintegrate import manualintegrate

from . import maxima_bridge

CONSTS = {
    "Pi": sp.pi, "ExponentialE": sp.E, "ImaginaryUnit": sp.I, "Nothing": None,
    "PositiveInfinity": sp.oo, "NegativeInfinity": -sp.oo,
}

# sympy has no timeout argument anywhere in integrate/simplify/solve/dsolve —
# checked the actual source, not just the docs (grepped the whole package;
# the only "timeout" in it is in sympy's own internal test runner). This is
# the real mechanism instead: run the attempt on a worker thread and just
# stop *waiting* on it past INTEGRATION_TIMEOUT, rather than trying to make
# sympy itself faster or interruptible. Python can't forcibly kill a thread,
# so an abandoned attempt keeps running to completion in the background —
# its result is simply discarded — but that no longer blocks this request's
# response, and (now that the Flask server runs threaded — see app.py)
# doesn't block any other request either.
#
# A plain daemon thread per call, not concurrent.futures.ThreadPoolExecutor:
# confirmed live that ThreadPoolExecutor's worker threads are non-daemon by
# design, and it registers a process-wide atexit hook that joins every
# submitted task (abandoned ones included) before letting the interpreter
# exit — a one-off script here visibly hung well past its own printed
# result, waiting on exactly that. In the desktop app that would mean the
# window not actually closing for however long an abandoned computation
# takes. daemon=True instead gets killed outright at process exit, no
# waiting — the correct behavior for work we've already decided to give up
# on. A true hard-kill mid-computation still needs a subprocess, which is
# more than this is worth: the cost of an abandoned thread is a spare CPU
# core busy for a while, not a hung app.
INTEGRATION_TIMEOUT = 2  # seconds


def _run_with_timeout(fn, *args, on_timeout, timeout=INTEGRATION_TIMEOUT):
    box = {}

    def worker():
        try:
            box["value"] = fn(*args)
        except Exception as e:
            box["error"] = e

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        return on_timeout
    if "error" in box:
        raise box["error"]
    return box["value"]


def _raise(message):
    """`raise` isn't an expression, so this lets a friendly error message
    sit inline in the OPS table (a ternary/lambda) instead of needing its
    own multi-line function per op that wants one."""
    raise ValueError(message)


def _apply(target, arg):
    # ["Apply", ["Derivative", "f", n], "x"] is how f'(x)/f''(x) parse: the
    # inner "Derivative" (below) is a curried "the n-th derivative of f, not
    # yet applied to anything" marker, resolved here into f^(n)(arg).
    if isinstance(target, tuple):
        fn, order = target
        return sp.diff(sp.Function(str(fn))(arg), arg, order)
    return sp.Function(str(target))(arg)


def _sympy_indefinite_attempt(body, var):
    # sp.integrate's general (Risch-based) algorithm fully expands the
    # integrand's antiderivative, e.g. (x-1)**7/7 comes back as a 7-term
    # polynomial. manualintegrate uses human-style pattern rules instead
    # (substitution, by-parts, table lookups) and keeps that kind of result
    # in its natural compact form, so it's tried first; it's less complete
    # than the general algorithm, so anything it can't close (still contains
    # an unevaluated Integral) falls back to the default. Returns None (not
    # an unevaluated Integral) on total failure, so it composes directly
    # with _indefinite_integral's engine-ordering loop below.
    try:
        result = _run_with_timeout(manualintegrate, body, var, on_timeout=None)
    except Exception:
        result = None
    if result is None or result.has(sp.Integral):
        result = _run_with_timeout(sp.integrate, body, var, on_timeout=None)
    return None if (result is None or result.has(sp.Integral)) else result


def _indefinite_integral(body, var, engine_preference="sympy"):
    # Two independent attempts at a closed-form antiderivative — sympy's own
    # (manualintegrate, then the general Risch-based integrate) and, if
    # Maxima is installed, its integrate() — tried in whichever order the
    # caller's engine_preference asks for, falling back to the other if the
    # first finds nothing. A stress test comparing the two head-to-head (see
    # /cas-engine-comparison.md at the repo root) found them to have
    # genuinely different, non-overlapping blind spots — sympy alone
    # structurally can't reach the polylogarithm-heavy family that motivated
    # adding Maxima as a fallback at all — so trying both, rather than
    # picking one permanently, is what actually closes more integrals.
    # maxima_bridge.integrate_indefinite already returns None uniformly for
    # "not installed" / "timed out" / "genuinely can't do this", so there's
    # no special-casing needed here for the not-installed case — the loop
    # just moves on to the other attempt, exactly as if Maxima had simply
    # failed to find an answer.
    attempts = (
        [_sympy_indefinite_attempt, maxima_bridge.integrate_indefinite]
        if engine_preference != "maxima" else
        [maxima_bridge.integrate_indefinite, _sympy_indefinite_attempt]
    )
    for attempt in attempts:
        result = attempt(body, var)
        if result is not None:
            return result + sp.Symbol("C")
    return sp.Integral(body, var) + sp.Symbol("C")


def _integrate(target, *rest, engine_preference="sympy"):
    body, _params = target if isinstance(target, tuple) else (target, ())
    # A math-field \int gives rest = (("Limits" tuple: var, lower, upper),).
    # A bare variable (indefinite, written directly) is also accepted so
    # callers can build mathjson by hand without going through "Limits".
    if len(rest) == 1 and isinstance(rest[0], tuple):
        var, lower, upper = rest[0]
        if lower is None or upper is None:
            return _indefinite_integral(body, var, engine_preference)
        # Capped at INTEGRATION_TIMEOUT rather than letting sympy grind for
        # as long as it takes to give up on its own — a hard case can take
        # much longer than that to conclude "no closed form" by itself, and
        # neither fallback below needs sympy to have actually finished
        # trying in order to kick in.
        result = _run_with_timeout(
            sp.integrate, body, (var, lower, upper),
            on_timeout=sp.Integral(body, (var, lower, upper)),
        )
        if result.has(sp.Integral):
            # Tried unconditionally (not engine_preference-ordered like the
            # indefinite case above) — sympy's definite integrate() is tried
            # first regardless, and Maxima's own definite-integral routine
            # can reach an exact closed form here even for cases its own
            # antiderivative search wouldn't (confirmed live:
            # zeta(3)/4 - 1/4 for the integral that motivated this whole
            # bridge, bounded 0 to 1 — the exact answer, not just a decimal
            # approximation of it). Only falls through to numeric quadrature
            # if Maxima can't close it either.
            exact = maxima_bridge.integrate_definite(body, var, lower, upper)
            if exact is not None:
                return exact
            # A definite integral, unlike an indefinite one, always has a
            # single real number to converge on even when neither symbolic
            # route can close it — so a numeric fallback is meaningful here
            # specifically. See _numeric_definite_integral for why this
            # doesn't apply to the indefinite case above.
            numeric = _numeric_definite_integral(body, var, lower, upper)
            if numeric is not None:
                return numeric
        return result
    if len(rest) == 1:
        return _indefinite_integral(body, rest[0], engine_preference)
    return sp.integrate(body, *rest)


def _mp_bound(b):
    """sp.oo/-sp.oo -> mpmath's own infinities; anything else (a plain
    number) passes through as-is. Shared by every mpmath fallback below that
    takes a lower/upper pair from a Limits tuple."""
    if b == sp.oo:
        return mpmath.inf
    if b == -sp.oo:
        return -mpmath.inf
    return b


def _numeric_series(kind, body, var, lower, upper):
    # Last-resort fallback once sympy's closed-form solvers give up: estimate
    # the value with mpmath's convergence-accelerated nsum/nprod, the actual
    # tool for this (Richardson/Euler-Maclaurin-style extrapolation), rather
    # than something ad hoc like an integral approximation. Only meaningful
    # when the term is purely numeric once summed/multiplied out (no other
    # free symbols left dangling), so this bails out to None otherwise.
    if body.free_symbols - {var}:
        return None
    f = sp.lambdify(var, body, modules=["mpmath"])
    a, b = _mp_bound(lower), _mp_bound(upper)
    try:
        value = mpmath.nsum(f, [a, b]) if kind == "sum" else mpmath.nprod(f, [a, b])
    except Exception:
        return None
    if not mpmath.isfinite(value):
        return None
    return sp.Float(float(value))


def _numeric_definite_integral(body, var, lower, upper):
    # Mirrors _numeric_series above, but for a definite integral sympy's own
    # integrate() couldn't close symbolically (e.g. one whose antiderivative
    # needs polylogarithms, which sympy's Risch-based integrator doesn't
    # reach) — mpmath.quad only needs the integrand to be numerically
    # well-behaved on [lower, upper], not integrable in closed form, so it
    # succeeds in plenty of cases the symbolic route can't. Unlike an
    # indefinite integral (a family of functions, no single "answer" to fall
    # back to), a definite integral always has one real number to converge
    # on, which is what makes a numeric fallback meaningful here specifically.
    if body.free_symbols - {var}:
        return None
    f = sp.lambdify(var, body, modules=["mpmath"])
    a, b = _mp_bound(lower), _mp_bound(upper)
    try:
        value = mpmath.quad(f, [a, b])
    except Exception:
        return None
    if not mpmath.isfinite(value):
        return None
    return sp.Float(float(value))


def _sum(body, limits):
    result = sp.summation(body, limits)
    if result.has(sp.Sum):
        var, lower, upper = limits
        numeric = _numeric_series("sum", body, var, lower, upper)
        if numeric is not None:
            return numeric
    return result


def _product(body, limits):
    result = sp.product(body, limits)
    if result.has(sp.Product):
        # sp.product has no closed-form solver for infinite products the way
        # sp.summation does for infinite sums. exp(sum(log(term))) routes it
        # through the much stronger summation engine instead, which often
        # succeeds where sp.product gives up (e.g. Wallis-type products).
        # This assumes terms are well-behaved (never exactly zero, and free
        # of branch-cut weirdness from going negative); only used as a
        # fallback, and only trusted if the rewritten sum itself resolves.
        var, lower, upper = limits
        try:
            log_sum = sp.summation(sp.log(body), (var, lower, upper))
        except Exception:
            log_sum = None
        if log_sum is not None and not log_sum.has(sp.Sum):
            return sp.simplify(sp.exp(log_sum))

        numeric = _numeric_series("product", body, var, lower, upper)
        if numeric is not None:
            return numeric
    return result


def _chained_relation(cls):
    """A math-field comparison like `1 < x < 5` parses as a single variadic
    node (`["Less", 1, "x", 5]`), not nested binary ones. Two args builds the
    relation directly; more than two chains pairwise relations together with
    And, e.g. `(1 < x) & (x < 5)`."""
    def build(*args):
        if len(args) == 2:
            return cls(args[0], args[1])
        return sp.And(*(cls(args[i], args[i + 1]) for i in range(len(args) - 1)))
    return build


def _limit(target, point, *side):
    # A math-field \lim gives target = (body, (var,)) from "Function" below.
    # A bare expression (var inferred from its one free symbol) is also
    # accepted so callers can build mathjson by hand without "Function".
    if isinstance(target, tuple):
        body, params = target
        var = params[0] if params else next(iter(body.free_symbols))
    else:
        body, var = target, next(iter(target.free_symbols))

    if not side:
        direction = "+-"  # true two-sided limit; sympy reports zoo if the sides disagree
    else:
        direction = "+" if side[0] == 1 else "-"
    return sp.limit(body, var, point, dir=direction)


OPS = {
    # Reduced with the plain operators (not sp.Add/sp.Mul) so matrix
    # operands dispatch to Matrix's own __add__/__mul__, which gives correct
    # results and clear shape-mismatch errors for both scalars and matrices.
    "Add": lambda *terms: reduce(operator.add, terms),
    "Subtract": lambda a, b: a - b, "Negate": lambda a: -a,
    "Multiply": lambda *factors: reduce(operator.mul, factors), "Divide": lambda a, b: a / b,
    # A math-field fraction parses as ["Rational", num, denom] (MathJSON's
    # canonical exact-fraction form), distinct from the "Divide" op above.
    # Without this, it fell through to the undefined-function branch below
    # as Function('Rational')(num, denom) — which, since sympy's own actual
    # Rational class is also literally named "Rational", crashed the printer
    # the moment it tried to look up print precedence by class name.
    "Rational": lambda p, q: sp.Rational(p, q),
    # MathJSON's canonical complex-literal form: "2+i" parses as
    # ["Complex", 2, 1], not ["Add", 2, "ImaginaryUnit"]. Without this it
    # fell through to the undefined-function branch below as an opaque
    # Function('Complex')(2, 1) — cos() of that can't evaluate at all,
    # whereas cos() of a real sympy complex number expands properly.
    "Complex": lambda re, im: re + im * sp.I,
    "Power": sp.Pow, "Sqrt": sp.sqrt, "Root": lambda a, n: sp.root(a, n),
    "Sin": sp.sin, "Cos": sp.cos, "Tan": sp.tan,
    "Csc": sp.csc, "Sec": sp.sec, "Cot": sp.cot,
    "Sinh": sp.sinh, "Cosh": sp.cosh, "Tanh": sp.tanh,
    "Csch": sp.csch, "Sech": sp.sech, "Coth": sp.coth,
    "Arcsin": sp.asin, "Arccos": sp.acos, "Arctan": sp.atan,
    "Arccsc": sp.acsc, "Arcsec": sp.asec, "Arccot": sp.acot,
    "Arsinh": sp.asinh, "Arcosh": sp.acosh, "Artanh": sp.atanh,
    "Arcsch": sp.acsch, "Arsech": sp.asech, "Arcoth": sp.acoth,
    "Ln": sp.log, "Log": lambda a, b=10: sp.log(a, b),
    "Exp": sp.exp, "Abs": sp.Abs,
    # Wired to sympy's real implementations (not left to the undefined-function
    # fallback below) specifically so summation/product recognize them and can
    # still find a closed form, e.g. sum(1/n!, n, 1, oo) = E - 1.
    "Factorial": sp.factorial, "Binomial": sp.binomial, "Gamma": sp.gamma,
    "Floor": sp.floor, "Ceil": sp.ceiling,
    "Equal": sp.Eq,
    "Less": _chained_relation(sp.Lt), "LessEqual": _chained_relation(sp.Le),
    "Greater": _chained_relation(sp.Gt), "GreaterEqual": _chained_relation(sp.Ge),
    "NotEqual": lambda a, b: sp.Ne(a, b),
    # "List" ([a,b] via \begin{cases}, or square brackets) and "Set" ({a, b}
    # braces) are both collections a system/ODE-system solve can be built
    # from — nothing downstream cares which of the two produced it. "Tuple"
    # (bare comma-separated a, b — no delimiter) is deliberately NOT treated
    # the same way: it's what you get by accident from typing "x+y=9,x=2"
    # with no wrapping braces, and silently solving that as a system made
    # stray commas elsewhere quietly (and confusingly) trigger system-solve
    # too. Rejecting it outright — with the same generic message as any other
    # input the parser can't make sense of — pushes everyone through the
    # one explicit, unambiguous spelling: { }.
    "List": lambda *items: list(items),
    "Tuple": lambda *items: _raise("couldn't understand part of this input"),
    "Set": lambda *items: list(items),
    "Matrix": lambda rows: sp.Matrix(rows),
    "Determinant": lambda m: m.det() if m.is_square else _raise(
        f"can't take the determinant of a {m.rows}x{m.cols} matrix — it isn't square"
    ),
    "Inverse": lambda m: m.inv(),
    "D": lambda expr, *wrt: sp.diff(expr, *wrt),
    "Integrate": _integrate,
    "Limit": _limit,
    "Sum": _sum,
    "Product": _product,
    # \int, \lim, \sum, \prod all wrap their body in Function/Block, and give
    # bounds/point via Limits. Function keeps its params (unlike a plain
    # pass-through) because \lim needs to know which symbol is the bound
    # variable and, unlike \int/\sum/\prod, has no separate Limits tuple to
    # get it from.
    "Function": lambda body, *params: (body, params),
    "Block": lambda *body: body[-1],
    "Limits": lambda var, lower, upper: (var, lower, upper),
    # Prime notation f'(x)/f''(x) parses as Apply(Derivative(f, n), x).
    "Derivative": lambda fn, order=1: (fn, order),
    "Apply": _apply,
}

# Ops whose argument is an angle, for degree-mode conversion below.
_ANGLE_OPS = {"Sin", "Cos", "Tan", "Csc", "Sec", "Cot"}
# Inverse trig ops whose *result* is an angle: in degree mode the radian
# result they naturally produce is converted back to degrees on the way out
# (the mirror image of _ANGLE_OPS converting an incoming degree argument to
# radians). Inverse hyperbolic ops aren't included — their argument and
# result are both plain numbers, no angle involved.
_INVERSE_ANGLE_OPS = {"Arcsin", "Arccos", "Arctan", "Arccsc", "Arcsec", "Arccot"}

# \int_a^b, \sum, and \prod all take their bound variable + lower/upper as
# their last argument. compute-engine's LaTeX parser encodes that as a bare
# ["Tuple", var, lower, upper] rather than the ["Limits", var, lower, upper]
# this module (and OPS["Integrate"/"Sum"/"Product"] below) expect — but
# OPS["Tuple"] deliberately rejects a bare Tuple anywhere else, to catch a
# typo like "x+y=9,x=2" (missing the braces that would make it a real
# system) rather than silently mis-solving it. This position is unambiguous
# (it's always exactly the bound-variable triple, never user expressions),
# so it's normalized back to "Limits" here, before that generic rejection
# ever sees it.
_BOUNDED_OPS = {"Integrate", "Sum", "Product"}


def to_sympy(node, angle_mode="rad", engine_preference="sympy"):
    if isinstance(node, bool):
        return sp.sympify(node)
    if isinstance(node, int):
        return sp.Integer(node)
    if isinstance(node, float):
        # Parse via the decimal string, not the raw float, so e.g. 0.5 becomes
        # the exact Rational(1, 2) instead of a binary Float approximation.
        # This is what lets sympy recognize "nice" cases symbolically (e.g.
        # sin(x) = 1/2 solving to pi/6) instead of falling back to a numeric
        # asin() and printing a long decimal even in exact/standard mode.
        return sp.Rational(str(node))
    if isinstance(node, dict) and "num" in node:
        # MathJSON's arbitrary-precision number form: a number too long to
        # round-trip through a JS double (e.g. 1/3.3487, or a long decimal
        # literal) arrives as {"num": "0.298623346373219458297"} instead of
        # a bare float, to preserve every digit. sp.Rational parses the
        # string directly (decimal or exponential form) into the same exact
        # fraction the plain-float branch above produces.
        return sp.Rational(str(node["num"]))
    if isinstance(node, str):
        return CONSTS.get(node, sp.Symbol(node))
    if isinstance(node, list):
        op, *args = node
        if op == "Error":
            # compute-engine's own explicit "couldn't parse/type-check this"
            # marker — occasionally shows up not just from malformed input,
            # but from its parser's own quirks on unusual template
            # combinations (e.g. determinant bars drawn around a matrix a
            # certain way). Raised here, before recursing into its (non-
            # mathematical) error-detail args, so it surfaces as a clean
            # message instead of becoming an opaque Function('Error')(...)
            # buried inside whatever expression wraps it.
            raise ValueError("couldn't understand part of this input")
        if op in _BOUNDED_OPS and args and isinstance(args[-1], list) and args[-1][:1] == ["Tuple"]:
            args = [*args[:-1], ["Limits", *args[-1][1:]]]
        converted = [to_sympy(a, angle_mode, engine_preference) for a in args]
        if op in _ANGLE_OPS and angle_mode == "deg":
            converted[0] = converted[0] * sp.pi / 180
        if op in OPS:
            # Integrate is the one op that needs engine_preference — passed
            # as a keyword here rather than added to every OPS entry's
            # calling convention, since nothing else reads it.
            result = (
                _integrate(*converted, engine_preference=engine_preference)
                if op == "Integrate" else OPS[op](*converted)
            )
            if op in _INVERSE_ANGLE_OPS and angle_mode == "deg":
                result = result * 180 / sp.pi
            return result
        # Not a known operation: treat it as an application of an
        # undefined function, e.g. f(g(x)) -> Function('f')(Function('g')(x)).
        # Sympy carries these symbolically (chain rule on D, unevaluated
        # Integral, etc.) instead of erroring or misparsing as multiplication.
        return sp.Function(op)(*converted)
    raise ValueError(f"bad node: {node}")


def _ode_unknown_names(expr):
    # Names a Derivative in an *equation* (never a bare expression — see
    # below) is actually differentiating an AppliedUndef with respect to —
    # i.e. names plausibly meant as *the* unknown function of an ODE/PDE
    # (f''(x)+2f(x)=3x solved for f), not a call to some earlier, unrelated
    # "f(x) = ..." workspace definition. f/g/h are both the only letters
    # compute-engine parses as function calls at all (see
    # compute-engine.js's ce.declare) and the conventional ODE-unknown
    # letters, so this collision is a real one, not theoretical.
    #
    # Restricted to sp.Equality items specifically (matching exactly what
    # _resolve_equation/_resolve_system treat as an ODE: an equation with a
    # Derivative atom) rather than any expression with one — a bare "d/dx
    # f(x)" with no Equal around it is never dispatched to the ODE solver,
    # it's just evaluated, so it should still get f's stored body
    # substituted in (and then differentiated) rather than being left
    # unevaluated on the assumption it's an ODE's unknown.
    exprs = expr if isinstance(expr, list) else [expr]
    names = set()
    for e in exprs:
        if not isinstance(e, sp.Equality):
            continue
        for d in e.atoms(sp.Derivative):
            f = d.expr
            if isinstance(f, sp.core.function.AppliedUndef):
                names.add(f.func.__name__)
    return names


def substitute_functions(expr, functions, angle_mode="rad"):
    """Replaces calls to user-defined workspace functions (an earlier
    "f(x) = x^2+1" input, see frontend/workspace.js) with their bodies,
    binding each call's actual arguments to the function's declared
    parameters. `functions` is {name: {"params": [str, ...], "body":
    mathjson}}. Skips any name that's actually the unknown function of an
    ODE/PDE in this same expression (see `_ode_unknown_names`) rather than
    a genuine call to the stored definition.

    sympy's `.replace(Function('f'), Lambda((x,), body))` does the
    argument-binding substitution directly, including inside an
    unevaluated Derivative (chain rule) or Integral — no manual walk of
    the expression tree needed.
    """
    if not functions:
        return expr
    skip = _ode_unknown_names(expr)
    subs = {}
    for name, spec in functions.items():
        if name in skip:
            continue
        try:
            params = [sp.Symbol(p) for p in spec["params"]]
            body = to_sympy(spec["body"], angle_mode)
            subs[sp.Function(name)] = sp.Lambda(tuple(params), body)
        except Exception:
            continue  # a malformed definition just doesn't get substituted
    if not subs:
        return expr

    def apply_subs(item):
        if not hasattr(item, "replace"):
            return item
        # Looped (rather than one pass) so a function whose stored body
        # calls another workspace function (g(x) := f(x) + 1) resolves all
        # the way down instead of leaving an inner call unexpanded — capped
        # at len(subs) passes (the longest possible non-cyclic call chain)
        # and stopped early once a pass makes no further change.
        for _ in range(len(subs)):
            before = item
            for func, lam in subs.items():
                item = item.replace(func, lam)
            if item == before:
                break
        return item

    if isinstance(expr, list):
        return [apply_subs(item) for item in expr]
    return apply_subs(expr)