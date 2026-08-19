import operator
from functools import reduce

import mpmath
import sympy as sp
from sympy.integrals.manualintegrate import manualintegrate

CONSTS = {
    "Pi": sp.pi, "ExponentialE": sp.E, "ImaginaryUnit": sp.I, "Nothing": None,
    "PositiveInfinity": sp.oo, "NegativeInfinity": -sp.oo,
}


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


def _indefinite_integral(body, var):
    # sp.integrate's general (Risch-based) algorithm fully expands the
    # integrand's antiderivative, e.g. (x-1)**7/7 comes back as a 7-term
    # polynomial. manualintegrate uses human-style pattern rules instead
    # (substitution, by-parts, table lookups) and keeps that kind of result
    # in its natural compact form, so it's tried first; it's less complete
    # than the general algorithm, so anything it can't close (still contains
    # an unevaluated Integral) falls back to the default. Either way, an
    # indefinite integral is a family of antiderivatives, so "+ C" is added
    # back on to be accurate (sympy's integrate omits it).
    try:
        result = manualintegrate(body, var)
    except Exception:
        result = None
    if result is None or result.has(sp.Integral):
        result = sp.integrate(body, var)
    return result + sp.Symbol("C")


def _integrate(target, *rest):
    body, _params = target if isinstance(target, tuple) else (target, ())
    # A math-field \int gives rest = (("Limits" tuple: var, lower, upper),).
    # A bare variable (indefinite, written directly) is also accepted so
    # callers can build mathjson by hand without going through "Limits".
    if len(rest) == 1 and isinstance(rest[0], tuple):
        var, lower, upper = rest[0]
        if lower is None or upper is None:
            return _indefinite_integral(body, var)
        return sp.integrate(body, (var, lower, upper))
    if len(rest) == 1:
        return _indefinite_integral(body, rest[0])
    return sp.integrate(body, *rest)


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
    a = mpmath.inf if lower == sp.oo else (-mpmath.inf if lower == -sp.oo else lower)
    b = mpmath.inf if upper == sp.oo else (-mpmath.inf if upper == -sp.oo else upper)
    try:
        value = mpmath.nsum(f, [a, b]) if kind == "sum" else mpmath.nprod(f, [a, b])
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
_ANGLE_OPS = {"Sin", "Cos", "Tan"}


def to_sympy(node, angle_mode="rad"):
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
        converted = [to_sympy(a, angle_mode) for a in args]
        if op in _ANGLE_OPS and angle_mode == "deg":
            converted[0] = converted[0] * sp.pi / 180
        if op in OPS:
            return OPS[op](*converted)
        # Not a known operation: treat it as an application of an
        # undefined function, e.g. f(g(x)) -> Function('f')(Function('g')(x)).
        # Sympy carries these symbolically (chain rule on D, unevaluated
        # Integral, etc.) instead of erroring or misparsing as multiplication.
        return sp.Function(op)(*converted)
    raise ValueError(f"bad node: {node}")