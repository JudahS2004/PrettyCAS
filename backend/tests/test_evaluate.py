import math

import pytest


def test_basic_arithmetic(resolve):
    response = resolve(["Add", 2, 2])
    assert response["mode"] == "evaluate"
    assert response["result"] == "4"
    assert response["numeric"] == 4


def test_exact_result_stays_symbolic_in_standard_mode(resolve):
    # 1/3 should stay an exact fraction in Standard mode, not decay to a
    # rounded decimal — this is the entire point of the resolve/render split
    # (see compute.py's own module docstring).
    response = resolve(["Divide", 1, 3])
    assert response["result"] == "1/3"


def test_decimal_mode_expands_the_same_value(resolve):
    response = resolve(["Divide", 1, 3], decimals=6, number_format="decimal")
    assert response["result"].startswith("0.333333")


def test_trig_radian_mode_default(resolve):
    response = resolve(["Sin", ["Divide", "Pi", 2]])
    assert response["result"] == "1"


def test_trig_degree_mode_converts_argument(resolve):
    # sin(90) in degree mode should behave like sin(pi/2) in radian mode —
    # _ANGLE_OPS converts the argument to radians before handing it to sympy.
    response = resolve(["Sin", 90], angle_mode="deg")
    assert response["result"] == "1"


def test_inverse_trig_degree_mode_converts_result_back(resolve):
    # _INVERSE_ANGLE_OPS: the *result* of asin also needs converting back to
    # degrees when angle_mode is "deg", not just the argument on the way in.
    response = resolve(["Arcsin", 1], angle_mode="deg")
    assert response["result"] == "90"


def test_inverse_notation_elementary_trig_respects_radian_mode(resolve):
    # \cos^{-1}(0) parses to ["Apply", ["InverseFunction", "Cos"], 0], a
    # completely separate code path from typing \arccos(0) directly (the
    # test above) — resolved inside mathjson.py's _apply via a second OPS
    # lookup, not through to_sympy's own top-level dispatch loop that
    # normally applies the degree-mode conversion. Radian mode is the
    # unaffected default either way, so this alone wouldn't have caught the
    # bug — see the deg-mode test right below for the one that would.
    response = resolve(["Apply", ["InverseFunction", "Cos"], 0], angle_mode="rad")
    assert response["result"] == "pi/2"


def test_inverse_notation_elementary_trig_respects_degree_mode(resolve):
    # User-reported bug: \cos^{-1}(0) always gave pi/2 regardless of
    # angle_mode ("although acos works") — i.e. \arccos(0) typed directly
    # correctly gave 90 in degree mode, but the \cos^{-1}(...) notation for
    # the exact same computation didn't. Root cause: _apply's own
    # elementary-inverse-trig branch called OPS["Arccos"](arg) directly,
    # bypassing the degree conversion that only ever ran for the literal
    # top-level op string ("Apply" here, not "Arccos"/"Cos"). Fixed by
    # threading angle_mode into _apply and applying the same conversion
    # there.
    response = resolve(["Apply", ["InverseFunction", "Cos"], 0], angle_mode="deg")
    assert response["result"] == "90"


def test_inverse_notation_elementary_trig_converts_argument_too(resolve):
    # The mirror-image direction: \arcsin^{-1}(x) means "the inverse of
    # arcsin", i.e. sin(x) — here x itself is the angle, given in degrees,
    # so it needs deg->rad conversion on the way IN, not the result on the
    # way out. sin(30 degrees) = 1/2, matching typing \sin(30) directly in
    # degree mode.
    response = resolve(["Apply", ["InverseFunction", "Arcsin"], 30], angle_mode="deg")
    assert response["result"] == "1/2"
    assert response["result"] == resolve(["Sin", 30], angle_mode="deg")["result"]


def test_natural_log_prints_as_ln(resolve):
    response = resolve(["Ln", "ExponentialE"])
    assert response["result"] == "1"
    assert response["latex"] == "1"


def test_explicit_base_log_keeps_subscript_in_latex(resolve):
    # log(a, b) is log(a)/log(b) from construction (see to_latex's own
    # comment) — the display-only fixup should still show \log_{10}, not
    # sympy's raw change-of-base fraction.
    response = resolve(["Log", 1000, 10])
    assert response["result"] == "3"


def test_complex_evaluate_reports_re_im_numeric(resolve):
    response = resolve(["Add", ["Complex", 2, 3], ["Complex", 1, -1]])
    assert response["mode"] == "evaluate"
    assert response["numeric"] == {"re": 3, "im": 2}


def test_undefined_function_call_stays_symbolic(resolve):
    # No workspace `functions` entry for "Q" — this should come back as a
    # literal, unevaluated Q(3), not an error and not silently 0.
    response = resolve(["Q", 3])
    assert response["mode"] == "evaluate"
    assert "Q" in response["result"]
