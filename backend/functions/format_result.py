import sympy as sp

# sympy has no notion of an explicit-base logarithm once one is built: sp.log(a, b)
# *is* log(a)/log(b) from construction on, with no memory that it started as a
# base-b log, so left to sp.latex's defaults log(3, 10) prints as the change-of-base
# fraction \frac{\log(3)}{\log(10)} instead of the specific \log_{10}(3) form. This
# marker class exists only to give the latex printer somewhere to hang \log_b on;
# the pattern below re-detects the log(a)/log(b) shape right before printing and
# swaps in the marker for display only, never touching the value itself (which
# stays the ordinary log(a)/log(b) sympy already uses for actual computation).
_LOG_A, _LOG_B = sp.Wild("loga"), sp.Wild("logb", properties=[lambda k: k.is_number and k.is_real and k != sp.E])
_LOG_BASE_PATTERN = sp.log(_LOG_A) / sp.log(_LOG_B)


class _LogBase(sp.Function):
    nargs = 2

    def _latex(self, printer, *args):
        x, b = self.args
        return r"\log_{%s}\left(%s\right)" % (printer._print(b), printer._print(x))


def to_latex(value):
    """LaTeX for a resolved value, with two display-only fixes over sympy's
    raw sp.latex default: the natural log prints as \\ln (ln_notation=True)
    instead of the ambiguous bare \\log, while any other explicit-base log
    (log_10, log_2, ...) keeps its base as a subscript instead of showing as
    sympy's log(a)/log(b) change-of-base fraction.
    """
    try:
        value = value.replace(_LOG_BASE_PATTERN, lambda loga, logb: _LogBase(loga, logb))
    except AttributeError:
        pass
    return sp.latex(value, ln_notation=True)


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


def _normalize(value):
    """The numerical equation solver (solvers/numerical.py) returns plain
    Python floats, not sympy objects — sympify first so cap_decimals below
    actually sees the Float it's about to become, instead of missing it and
    only discovering it (too late) after evalf() already ran."""
    if hasattr(value, "evalf"):
        return value
    try:
        return sp.sympify(value)
    except Exception:
        return value


def cap_decimals(value, decimals):
    """The most decimal digits it's honest to ask for when displaying
    `value`: min(requested `decimals`, what's actually known), or just
    `decimals` unchanged if `value` is exact.

    A result can carry an embedded sympy Float of only double precision —
    from the mpmath quadrature/summation fallback in mathjson.py, from the
    numerical equation solver's bisection search, or simply because the user
    typed a decimal literal — while the cached, pre-formatting value handed
    around here is still this same limited-precision Float underneath.
    evalf-ing (or engineering-notation-ing) it out to, say, 200 decimals
    doesn't recover 200 real digits: it just keeps unpacking that Float's
    exact (but only ~15-17-significant-digit-accurate) binary value further,
    producing digits that look precise but aren't. This is the trap caching
    makes easy to fall into by accident — reusing the cached exact sympy
    object for a bigger decimals request is exactly right for a genuinely
    exact value (pi, 1/3, sqrt(2), ...), and exactly wrong for one of these
    already-numeric ones, so the two cases have to be told apart here rather
    than trusting the requested decimals alone. Every caller that turns a
    resolved value into digits (evalf, engineering notation) routes through
    this first — capping only at the evalf call site left engineering
    notation free to recompute straight from the uncapped float and leak the
    same false precision right back in.
    """
    if decimals is None:
        return None
    value = _normalize(value)
    try:
        floats = value.atoms(sp.Float)
    except AttributeError:
        return decimals
    if not floats:
        return decimals
    # bits -> decimal digits, sympy's own rule of thumb (mpmath uses the same
    # log10(2) factor for dps<->prec conversion).
    cap = max(1, min(int(f._prec * 0.3010299956639812) for f in floats))
    return min(decimals, cap)


def to_display(value, decimals):
    """Apply decimal-mode formatting (arbitrary precision, via evalf) to a
    result on its way out. In standard/exact mode (decimals is None), leaves
    it untouched except to deepen otherwise-uninformative complex results."""
    if decimals is None:
        return _deepen_complex_inverses(value)
    value = _normalize(value)
    decimals = cap_decimals(value, decimals)
    try:
        return value.evalf(decimals)
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
