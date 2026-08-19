import sympy as sp

_INVERSE_TRIG_HYP = (
    sp.asin, sp.acos, sp.atan, sp.acot, sp.asec, sp.acsc,
    sp.asinh, sp.acosh, sp.atanh, sp.acoth, sp.asech, sp.acsch,
)


def _deepen_complex_inverses(value):
    """sympy sometimes leaves an inverse trig/hyperbolic call symbolic and
    uninformative, e.g. solving sin(x) = 2 gives 'asin(2)' verbatim, because
    2 is outside asin's real range and it has no "nice" closed form to fall
    back to. Rewriting through the logarithmic definition turns that into an
    actual answer (in terms of i, ln, sqrt) instead of a restated question.

    Only done when the value is genuinely complex (is_real is False): for a
    real-but-not-a-nice-angle case like asin(3/10), the same rewrite produces
    an uglier, not more informative, expression, so those are left alone.
    """
    try:
        if not value.atoms(*_INVERSE_TRIG_HYP) or value.is_real is not False:
            return value
        rewritten = sp.simplify(value.rewrite(sp.log))
        return value if rewritten.atoms(*_INVERSE_TRIG_HYP) else rewritten
    except Exception:
        return value


def to_display(value, decimals):
    """Apply decimal-mode formatting (arbitrary precision, via evalf) to a
    result on its way out. In standard/exact mode (decimals is None), leaves
    it untouched except to deepen otherwise-uninformative complex results."""
    if decimals is None:
        return _deepen_complex_inverses(value)
    try:
        return value.evalf(decimals)
    except AttributeError:
        try:
            return sp.sympify(value).evalf(decimals)
        except Exception:
            return value


def to_engineering(value, decimals):
    """Format an already decimal-evaluated value in engineering notation
    (mantissa in [1, 1000), exponent forced to a multiple of 3 — "12.3e6"
    rather than "1.23e7"), the convention most measurement/electronics
    contexts actually use over plain scientific notation.

    Only meaningful for a single plain real number: a symbolic leftover, a
    complex value, or a set (e.g. an inequality's solution interval) has no
    one sensible mantissa/exponent, so those all fall back to None and the
    caller keeps its normal formatting instead.
    """
    try:
        if not (value.is_real and value.is_number):
            return None
    except AttributeError:
        return None
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None

    if x == 0:
        return "0", "0"

    sign = "-" if x < 0 else ""
    x = abs(x)
    sig = max(decimals, 1)
    mantissa_str, exp_str = f"{x:.{sig - 1}e}".split("e")
    exponent = int(exp_str)
    shift = exponent % 3
    exponent -= shift
    mantissa = float(mantissa_str) * (10 ** shift)
    places = max(sig - 1 - shift, 0)
    mantissa_str = f"{mantissa:.{places}f}"
    if float(mantissa_str) >= 1000:
        # Rounding at low precision can push the mantissa back up to the
        # next multiple of 3 (e.g. 9996 at 1 sig fig -> "10e3", not "1e4" —
        # still valid engineering form, just one exponent step up).
        mantissa_str = f"{float(mantissa_str) / 1000:.{places}f}"
        exponent += 3
    if "." in mantissa_str:
        mantissa_str = mantissa_str.rstrip("0").rstrip(".")

    if exponent == 0:
        return f"{sign}{mantissa_str}", f"{sign}{mantissa_str}"
    return f"{sign}{mantissa_str}e{exponent}", f"{sign}{mantissa_str} \\times 10^{{{exponent}}}"
