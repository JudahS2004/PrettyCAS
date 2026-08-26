"""Optional fallback to Maxima for indefinite integrals sympy can't close.

Not a Python dependency — Maxima has no PyPI binding, so this shells out to
the `maxima` binary via subprocess and round-trips through plain text. That
made it the right pick over `giacpy` (real Python bindings, but a head-to-
head stress test — see /cas-engine-comparison.md at the repo root — showed
it solves the exact class of problem (polylogarithm-heavy integrals) that
motivated adding a second engine at all, while giac and sympy both miss it.

Every function here degrades to "no answer" (None) rather than raising —
Maxima not being installed, a syntax it can't parse, a timeout, or a genuine
"no closed form" are all the same shape of non-answer to the caller, which
already knows how to report that honestly (see compute.py's `expr.has(sp.Integral)`
check). This module never being importable-but-broken is what lets the
Maxima-not-installed case be silent and free instead of a startup error.
"""
import re
import shutil
import subprocess

import sympy as sp

# Generous relative to how fast Maxima actually resolves things in practice
# (well under a second for nearly everything tried during testing, success
# or honest failure alike) — this only ever runs after sympy has already
# spent its own budget failing, so it's better to lean generous here than
# risk giving up on something Maxima would have gotten in a couple more
# seconds.
MAXIMA_TIMEOUT = 5

_maxima_path = None
_checked = False


def is_available():
    """Whether the `maxima` binary exists on PATH. Cached after the first
    check — this can't change while the app is running, so there's no
    reason to hit the filesystem more than once."""
    global _maxima_path, _checked
    if not _checked:
        _maxima_path = shutil.which("maxima")
        _checked = True
    return _maxima_path is not None


def _to_maxima(expr):
    """sympy expression -> a string Maxima's parser accepts. Maxima's own
    function names already match sympy's str() output for everything except
    the handful below; ** -> ^ is the one universal syntax difference."""
    s = str(expr)
    s = re.sub(r"\bbesselj\(", "bessel_j(", s)
    s = re.sub(r"\bE\b", "%e", s)
    s = re.sub(r"\bpi\b", "%pi", s)
    return s.replace("**", "^")


def _from_maxima(s, var):
    """The reverse: Maxima's plain-text answer -> a sympy expression. Only
    needs to cover what its integrate() can actually hand back — mainly
    polylogarithms (`li[n](...)`, the whole reason this bridge exists),
    Maxima's own constant spellings, and the function-name differences
    _to_maxima introduces going the other way. `var` is passed in (rather
    than assumed to be the module-level `x` elsewhere in this file) so this
    stays correct for whatever symbol the caller actually integrated over.
    """
    py = s.replace("^", "**")
    py = re.sub(r"li\[(\d+)\]\(", r"polylog(\1, ", py)
    py = py.replace("%e", "E").replace("%i", "I").replace("%pi", "pi")
    return sp.sympify(py, locals={
        "log": sp.log, "exp": sp.exp, "sqrt": sp.sqrt,
        "sin": sp.sin, "cos": sp.cos, "tan": sp.tan,
        "asin": sp.asin, "acos": sp.acos, "atan": sp.atan,
        "sinh": sp.sinh, "cosh": sp.cosh, "tanh": sp.tanh,
        "asinh": sp.asinh, "acosh": sp.acosh, "atanh": sp.atanh,
        "polylog": sp.polylog, "erf": sp.erf, "erfi": sp.erfi, "erfc": sp.erfc,
        "bessel_j": sp.besselj, "gamma": sp.gamma, "abs": sp.Abs,
        "zeta": sp.zeta, "Zeta": sp.zeta,
        str(var): var,
    })


def _bound_to_maxima(b):
    """sp.oo/-sp.oo -> Maxima's own infinities; anything else (a plain
    number) -> its Maxima-syntax string, same conversion _to_maxima does for
    a full expression."""
    if b == sp.oo:
        return "inf"
    if b == -sp.oo:
        return "minf"
    return _to_maxima(sp.sympify(b))


def _run_maxima(command):
    """Runs one `integrate(...);` command and returns Maxima's answer as a
    plain string, or None for every non-answer case uniformly: not
    installed, errored, timed out, or a genuine "can't do this" — all mean
    the same thing to both callers below (fall through to whatever's next
    in the fallback chain), so there's nothing to gain by telling them apart
    here rather than at each call site.
    """
    if not is_available():
        return None
    cmd = f"linel:3000$\ndisplay2d:false$\n{command}\n"
    try:
        proc = subprocess.run(
            ["maxima", "--very-quiet"], input=cmd,
            capture_output=True, text=True, timeout=MAXIMA_TIMEOUT,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    lines = [
        line for line in proc.stdout.strip().split("\n")
        if line.strip() and line.strip() != "false" and not line.strip().startswith("(%i")
    ]
    if not lines:
        return None
    result = lines[-1]
    # Maxima's own two "couldn't do this" shapes seen in testing: a literal
    # noun-form integrate(...) echoed straight back, or — subtler, and the
    # reason this checks for it explicitly rather than just trying to parse
    # anything that comes back — a partially-reduced expression that still
    # contains an unresolved 'limit(...) sub-computation instead of a real
    # closed-form answer.
    if "integrate(" in result or "limit(" in result:
        return None
    return result


def integrate_indefinite(body, var):
    """Try Maxima's integrate() for an antiderivative sympy's own attempts
    already failed to find. Returns a sympy expression (without "+ C" — the
    caller adds that, matching sympy's own path in mathjson.py) or None —
    see _run_maxima for what None covers."""
    result = _run_maxima(f"integrate({_to_maxima(body)},{var});")
    if result is None:
        return None
    try:
        return _from_maxima(result, var)
    except Exception:
        return None


def integrate_definite(body, var, lower, upper):
    """Same idea as integrate_indefinite, but for a definite integral —
    tried when sympy's own definite integrate() can't close it either,
    before falling back to numeric quadrature in mathjson.py. Worth having
    as a distinct step from the indefinite case + evaluating at the bounds:
    Maxima's own definite-integral routine can reach an exact closed form
    (confirmed live: `zeta(3)/4 - 1/4` for the integral that motivated this
    whole bridge, bounded 0 to 1) in cases its own indefinite antiderivative
    search doesn't even attempt, since a definite integral can have a closed
    form the general antiderivative doesn't.
    """
    lo, hi = _bound_to_maxima(lower), _bound_to_maxima(upper)
    result = _run_maxima(f"integrate({_to_maxima(body)},{var},{lo},{hi});")
    if result is None:
        return None
    try:
        return _from_maxima(result, var)
    except Exception:
        return None
