import pytest


def test_constants_are_substituted_before_evaluating(resolve):
    response = resolve(["Add", "a", 1], constants={"a": 4})
    assert response["mode"] == "evaluate"
    assert response["numeric"] == 5


def test_reassignment_with_workspace_value_still_defines_a_number(resolve):
    # "x = 5" with x already something else in the workspace: a genuine
    # redefinition. Constants intentionally has no entry for x here — this
    # mirrors what the frontend sends for a real assignment (see app.js's
    # isRealAssignment check).
    response = resolve(["Equal", "x", 5], constants={})
    assert response["mode"] == "solve"
    assert response["result"] == ["5"]
    assert response["numeric"] == 5


def test_equation_reuses_workspace_value_of_its_own_lhs_name(resolve):
    # Regression test for the "x = y + 4" bug: with x already saved as 2 in
    # the workspace, re-typing "x = y + 4" should solve for y using x's
    # existing value (2 = y + 4 -> y = -2), not echo the equation back
    # unsolved. This is the backend half of the fix in frontend/pages/app.js
    # (isRealAssignment) — the frontend decides whether to strip x out of
    # constants; this test pins down what the backend does once x is left
    # in, which is the behavior that fix relies on.
    response = resolve(["Equal", "x", ["Add", "y", 4]], constants={"x": 2})
    assert response["mode"] == "solve"
    assert response["result"] == ["-2"]
    assert response["numeric"] == -2


def test_equation_without_the_lhs_names_own_value_is_underdetermined(resolve):
    # Same equation, but x genuinely isn't known (constants stripped, as the
    # frontend does for a real "x = <rhs>" assignment) — two free symbols,
    # no closed form to isolate either one from a single linear equation, so
    # this should NOT silently claim x = y + 4 solves to anything.
    response = resolve(["Equal", "x", ["Add", "y", 4]], constants={})
    assert response["mode"] in ("solve", "system")
    if response["mode"] == "solve":
        assert "numeric" not in response


def test_workspace_function_call_is_substituted(resolve):
    response = resolve(
        ["Q", 3],
        functions={"Q": {"params": ["x"], "body": ["Power", "x", 2]}},
    )
    assert response["mode"] == "evaluate"
    assert response["numeric"] == 9


def test_workspace_function_call_can_reference_a_constant(resolve):
    response = resolve(
        ["Q", 3],
        functions={"Q": {"params": ["x"], "body": ["Add", ["Power", "x", 2], "a"]}},
        constants={"a": 1},
    )
    assert response["mode"] == "evaluate"
    assert response["numeric"] == 10


def test_complex_constant_arrives_as_re_im_dict(resolve):
    # Mirrors what the frontend actually sends for a complex-valued
    # workspace variable (see mathjson.py's sympify_constant / app.js's
    # evalNumeric comment) — a bare {"re": ..., "im": ...} dict, not a JSON
    # number.
    response = resolve(
        ["Divide", ["Subtract", "Zl", "Z0"], ["Add", "Zl", "Z0"]],
        constants={"Zl": {"re": 50, "im": 0}, "Z0": {"re": 25, "im": 0}},
    )
    assert response["mode"] == "evaluate"
    assert response["numeric"] == pytest.approx(1 / 3)


def test_inverse_of_workspace_function_solves_the_equation(resolve):
    # f^{-1}(4) where f(x) = x^2 is defined in the workspace: no built-in
    # inverse formula exists for an arbitrary workspace function, so this
    # goes through compute.py's _resolve_inverse_markers, building and
    # solving body(t) = arg via the normal equation pipeline. Once resolved,
    # the marker is substituted back into the (otherwise-empty) surrounding
    # expression as a plain number, so the overall response is "evaluate",
    # not "solve" — the solve happens internally, one level down, and x^2 is
    # non-injective, so it's not defined which of the two roots "wins" here
    # beyond "picks sympy's first solution" (a known, deliberate
    # simplification — see mathjson.py's OPS["InverseFunction"] comment).
    response = resolve(
        ["Apply", ["InverseFunction", "f"], 4],
        functions={"f": {"params": ["x"], "body": ["Power", "x", 2]}},
    )
    assert response["mode"] == "evaluate"
    assert response["numeric"] in (2, -2)


def test_inverse_of_undefined_name_reports_a_clean_error(resolve):
    response = resolve(["Apply", ["InverseFunction", "g"], 4], functions={})
    assert response["mode"] == "error"
    assert "no inverse" in response["result"]
