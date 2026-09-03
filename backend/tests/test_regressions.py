"""One test per bug documented as "found and fixed" in
.claude/PROJECT_SUMMARY.md, reproducing the exact input shape that
originally exposed each one — these guard against silent regressions of
those specific fixes, not general functional coverage (see the other
test_*.py files for that).
"""

import math
import time

import pytest


def _okumura_hata_rhs():
    # 69.55 + 26.16*log10(f) - 13.82*log10(h_t) - C_H
    #   + (44.9 - 6.55*log10(h_t)) * log10(d)
    log_f = ["Log", "f"]
    log_ht = ["Log", "h_t"]
    log_d = ["Log", "d"]
    return ["Add",
        69.55,
        ["Multiply", 26.16, log_f],
        ["Negate", ["Multiply", 13.82, log_ht]],
        ["Negate", "C_H"],
        ["Multiply", ["Subtract", 44.9, ["Multiply", 6.55, log_ht]], log_d],
    ]


def test_mixed_float_rational_domain_no_longer_hangs_equation_solving(resolve):
    # Root cause: sympify_constant used to leave a workspace constant as a
    # raw Python Float while formula literals parsed to exact Rationals,
    # mixing the two domains inside log(h_t, 10) = log(h_t)/log(10) and
    # sending sp.solve down a slow/uninterruptible internal path — this
    # equation used to hang indefinitely. Fixed by parsing workspace
    # constants via the same decimal-string route formula literals already
    # used, so both sides are exact Rationals. Should now resolve in a
    # fraction of a second, not hang.
    eq = ["Equal", 139.6, _okumura_hata_rhs()]
    constants = {"f": 900.0, "h_t": 50.0, "C_H": 0.0}

    started = time.monotonic()
    response = resolve(eq, constants=constants)
    elapsed = time.monotonic() - started

    assert elapsed < 5, f"took {elapsed:.1f}s — the domain-mixing hang may have regressed"
    assert response["mode"] == "solve"
    assert response["numeric"] == pytest.approx(3.02744414528315)


def test_underdetermined_single_equation_gets_a_friendly_message_not_a_raw_crash(resolve):
    # Same equation, but with L_u left genuinely free (no value, no
    # solve_for) — sp.solve's dict-based system solver, trying to express d
    # fully in terms of L_u, can build an internal value too enormous to
    # even str() for its own bookkeeping, raising Python's digit-limit
    # ValueError from deep inside sympy rather than from anything this
    # app's own formatting code gets a chance to catch. Should be swapped
    # for a plain, actionable message instead of surfacing raw exception
    # text as if it were a computed answer.
    #
    # Confirmed live this session: whether sp.solve actually takes that
    # exact internal path is itself not deterministic across process runs
    # for this equation (observed both "error" in ~0.3s and a genuine
    # "system" resolution taking 100+ seconds, isolated vs. run alongside
    # the rest of this test file — almost certainly Python's per-process
    # hash-seed randomization steering sp.solve's internal set/dict
    # iteration order down a different algorithmic branch each time, not
    # anything this test file itself does). That's the same "timeout isn't
    # actually reliable against every slow sp.solve() call" gap already
    # documented in PROJECT_SUMMARY.md's equation-solving-timeout section —
    # this test accepts either legitimate outcome rather than asserting
    # one, since the only thing that would be an actual regression is the
    # raw exception text leaking through either way.
    eq = ["Equal", "L_u", _okumura_hata_rhs()]
    constants = {"f": 900.0, "h_t": 50.0, "C_H": 0.0}

    response = resolve(eq, constants=constants)

    assert response["mode"] in ("error", "system")
    result_text = response["result"] if response["mode"] == "error" else " ".join(response["result"])
    assert "integer string conversion" not in result_text
    if response["mode"] == "error":
        assert "try giving the other variable" in result_text


def test_frozen_integral_over_a_workspace_functions_own_parameter_retries(resolve):
    # Q(x) = (1/pi) * integral of exp(-x^2 / (2*sin(theta)^2)) dtheta, 0 to
    # pi/2 (Craig's formula for the Gaussian tail probability). x is free
    # right up until a call like Q(3) substitutes it — but to_sympy (and
    # therefore the numeric-quadrature attempt inside it) runs *before*
    # that substitution, when x is still free, so the integral used to get
    # permanently frozen as an unevaluated sp.Integral with nothing ever
    # retrying it once a concrete number was actually supplied.
    # retry_unresolved_integrals is what gives it a second chance. Known
    # slow (~5-10s): sympy's own antiderivative search times out, Maxima's
    # bridge is tried next, and mpmath quadrature is what actually closes
    # it — that fallback chain is the thing under test here, not just the
    # final number.
    integrand = ["Exp", ["Negate", ["Divide",
        ["Power", "x", 2],
        ["Multiply", 2, ["Power", ["Sin", "theta"], 2]],
    ]]]
    integral = ["Integrate", ["Function", integrand, "theta"], ["Limits", "theta", 0, ["Divide", "Pi", 2]]]
    body = ["Multiply", ["Divide", 1, "Pi"], integral]
    functions = {"Q": {"params": ["x"], "body": body}}

    response = resolve(["Q", 3], functions=functions)

    assert response["mode"] == "evaluate"
    assert response["numeric"] == pytest.approx(0.00134989803163, abs=1e-6)


def test_convergence_conditioned_definite_integral_returns_piecewise_not_error(resolve):
    # \int_0^\infty t e^{-st} dt (Laplace transform of t) — sympy resolves
    # this to Piecewise((1/s**2, |arg(s)| < pi/2), (Integral(...), True)):
    # the first branch is the real closed form, the "otherwise" branch is
    # sympy honestly stating no closed form exists outside that domain, not
    # a stuck computation. _resolve_definite_integral's old
    # `result.has(sp.Integral)` check couldn't tell that apart from a
    # genuinely unresolved integral (it walks the whole tree and finds an
    # Integral node either way), so it fell through Maxima and the numeric
    # fallback (neither of which can do anything with the free symbol `s`)
    # and compute.py reported "couldn't find a closed form for this
    # integral" despite sympy having already solved it. Fixed by
    # has_unresolved_integral treating a Piecewise with at least one
    # resolved branch as answered.
    integrand = ["Multiply", "t", ["Exp", ["Negate", ["Multiply", "s", "t"]]]]
    integral = ["Integrate", ["Function", integrand, "t"], ["Limits", "t", 0, "PositiveInfinity"]]

    response = resolve(integral)

    assert response["mode"] == "evaluate"
    assert "s^{-2}" in response["result"] or "s**(-2)" in response["result"]
    assert "otherwise" in response["latex"]


def test_factor_mode_on_huge_rational_exponent_does_not_hang_or_corrupt(resolve):
    # Reported live: e^(rho^2) in "Factor" simplify mode, with rho a
    # workspace constant assigned 1/sqrt(2) — sympify_constant reconstructs
    # a workspace double as an exact-but-ugly ~16-digit Rational (see its
    # own comment), and squaring that roughly doubles the digit count to
    # ~31 digits. sp.factor() on exp() of that Rational has no timeout of
    # its own and was confirmed to hang indefinitely (user: "took ages and
    # computer fans went crazy" — reproduced standalone taking >8s with no
    # sign of returning). A second live run of the *identical* input
    # instead returned fast but with outright corrupted output — free
    # symbols that were never in the input (exp(rho**2) "factored" into
    # exp(h*r) for undeclared h/r), almost certainly the same per-process
    # hash-seed nondeterminism already documented for sp.solve() elsewhere
    # in this file steering sp.factor()'s internal algorithm down a
    # different, buggy branch each run. Fixed by _safe_simplify: a
    # SIMPLIFY_TIMEOUT-capped worker thread (same pattern as solve/
    # integrate) plus a free_symbols sanity check that discards a result
    # that invented new free symbols, falling back to the unsimplified
    # expression rather than hanging or returning garbage.
    mathjson = ["Power", "ExponentialE", ["Power", "rho", 2]]

    response = resolve(mathjson, constants={"rho": 0.7071067811865476}, simplify_mode="factor")

    assert response["mode"] == "evaluate"
    assert response["numeric"] == pytest.approx(math.exp(0.5), rel=1e-9)


def test_workspace_constant_keeps_exact_form_not_just_a_decimal(resolve):
    # Companion fix, same user report as the "Factor" hang above: the
    # underlying reason e^(rho^2) blew up into a ~31-digit Rational in the
    # first place is that a workspace constant was only ever cached as a
    # 17-significant-digit decimal (compute.py's _numeric_value) — reused
    # later via sympify_constant's str(float)->Rational reconstruction,
    # which is exact *to that decimal*, not exact to the original value.
    # rho = 1/sqrt(2) has no finite decimal form, so every later reuse
    # compounded the ugliness instead of simplifying like sqrt(2)/2 would.
    # Fixed by also computing an exact MathJSON form of a resolved value
    # (_exact_mathjson, mathjson.py) and letting a workspace constant carry
    # that instead of/alongside the decimal: {"exact": [...]} round-trips
    # through sympify_constant straight back into the exact symbolic value.
    # This test drives that wire shape directly (mirroring what
    # frontend/workspace.js's getWorkspace() now sends once app.js caches
    # response["exact"] from a "rho = 1/sqrt(2)" assignment), not just the
    # resolve()-then-reuse round trip through the actual assignment flow,
    # since `resolve` bypasses the frontend entirely.
    rho_evaluate = resolve(["Divide", 1, ["Sqrt", 2]])
    assert rho_evaluate["result"] == "sqrt(2)/2"
    exact = rho_evaluate["exact"]
    assert exact is not None

    mathjson = ["Power", "ExponentialE", ["Power", "rho", 2]]
    response = resolve(mathjson, constants={"rho": {"exact": exact}})

    assert response["mode"] == "evaluate"
    assert response["result"] == "exp(1/2)"


def test_bracket_style_matrix_and_transpose_work(resolve):
    # User asked to add \operatorname{Transpose}(...) support, reporting
    # that (A)^T-style output notation "clearly" worked already. It didn't,
    # for two separate, compounding reasons — neither related to Transpose
    # itself:
    #
    # - \begin{pmatrix}...\end{pmatrix} parses as a bare ["Matrix", rows],
    #   which the old single-arg OPS["Matrix"] handled fine. But
    #   \left[...\right]-wrapped or \begin{bmatrix}...\end{bmatrix} matrices
    #   (what \operatorname{Transpose}{(...)} — and A^T, which parses to the
    #   identical ["Transpose", ...] node — both naturally produce when
    #   MathLive's matrix template inserts brackets) carry an extra trailing
    #   delimiter-style marker arg (e.g. "'..'" or "'[]'"), which crashed
    #   OPS["Matrix"]'s old lambda outright ("takes 1 positional argument
    #   but 2 were given") — confirmed to affect *any* bracket-style matrix
    #   input, not just one wrapped in Transpose.
    # - Separately, a bracket/bmatrix literal also always arrives wrapped in
    #   an outer ["List", ["Matrix", ...]] node (compute-engine's own marker
    #   for "this used square-bracket delimiters") that pmatrix input never
    #   has — left alone, that outer List made a bracket-delimited matrix
    #   indistinguishable from an actual list, so compute.py's
    #   isinstance(expr, list) check routed it into system-of-equations
    #   solving instead of treating it as a plain matrix value.
    #
    # Fixed by making OPS["Matrix"] tolerate the trailing marker, unwrapping
    # a singleton ["List", ["Matrix", ...]] straight to the inner Matrix in
    # to_sympy, and adding "Transpose": lambda m: m.T to OPS.
    bracket_matrix = ["List", ["Matrix", ["List", ["List", 1, 2], ["List", 3, 4]], "'..'"]]
    bmatrix = ["Matrix", ["List", ["List", 1, 2], ["List", 3, 4]], "'[]'"]
    for matrix in (bracket_matrix, bmatrix):
        response = resolve(matrix)
        assert response["mode"] == "evaluate"
        assert response["result"] == "Matrix([[1, 2], [3, 4]])"

    response = resolve(["Transpose", bracket_matrix])
    assert response["mode"] == "evaluate"
    assert response["result"] == "Matrix([[1, 3], [2, 4]])"
