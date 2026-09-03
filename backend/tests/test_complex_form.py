def test_rectangular_is_the_default(resolve):
    response = resolve(["Complex", 3, 4])
    assert response["mode"] == "evaluate"
    assert response["result"] == "3 + 4*I"


def test_polar_setting_applies_to_a_plain_evaluate(resolve):
    response = resolve(["Complex", 0, 1], complex_form="polar")
    assert response["mode"] == "evaluate"
    # i = e^(i*pi/2) — a "nice" angle, so it still collapses back to the
    # simpler rectangular-equivalent form on its own (see _format_polar's
    # own comment: sp.exp(I*pi/2) auto-evaluates to I at construction).
    assert response["result"] == "I"


def test_polar_setting_applies_to_solve_results_too(resolve):
    # Deliberately applies uniformly, including genuine equation solving —
    # this was a real behavior change from the previous (simplifyMode-
    # piggybacked) design, see PROJECT_SUMMARY's "Complex form" section.
    response = resolve(["Equal", ["Power", "x", 2], -4], complex_form="polar")
    assert response["mode"] == "solve"
    assert set(response["result"]) == {"-2*I", "2*I"}


def test_polar_decimal_mode_shows_actual_r_theta_not_rectangular(resolve):
    # Decimal mode used to always show rectangular no matter the setting —
    # mpmath's complex evalf collapses r*exp(I*theta) straight back to
    # re/im with no polar internal form, so _format_polar has to evalf r
    # and theta independently and build the text by hand instead of
    # evalf-ing the combined expression.
    response = resolve(
        ["Complex", 1, 1], complex_form="polar", number_format="decimal", decimals=4,
    )
    assert response["mode"] == "evaluate"
    assert "exp(" in response["result"]
    assert "*I)" in response["result"]


def test_symbolic_expression_containing_i_is_left_alone_under_polar(resolve):
    # x + I*y has no single well-defined polar form — _is_complex_number
    # scopes to an actual complex NUMBER, not "any expression containing I".
    response = resolve(["Add", "x", ["Multiply", "y", "ImaginaryUnit"]], complex_form="polar")
    assert response["mode"] == "evaluate"
    assert "exp(" not in response["result"]


def test_polar_decimal_latex_puts_theta_before_i_for_a_negative_angle(resolve):
    # User-reported bug: "2-3i" under Polar/Decimal used to render as
    # "3.60555127546 e^{i -0.982793723247}" — the hand-built latex template
    # always put "i" first, so a negative theta (a genuinely negative
    # decimal string) landed directly after it with no operator between
    # them, reading as an ambiguous "i -0.98...". theta before "i" instead
    # reads unambiguously for either sign, and matches the plain-text form's
    # own theta-then-I order (see _format_polar).
    response = resolve(
        ["Complex", 2, -3], complex_form="polar", number_format="decimal", decimals=12,
    )
    assert response["mode"] == "evaluate"
    assert "i -0.982793723247" not in response["latex"]
    assert "-0.982793723247 i" in response["latex"]
