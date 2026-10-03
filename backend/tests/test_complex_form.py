import sympy as sp

from functions.compute import _format_number


# A real complex root from Cardano's cubic formula (x^3 + 4x^2 + 3x - 5 = 0,
# which has one real root and two genuinely complex conjugate ones) — the
# real regression case for the two tests below. Built directly rather than
# going through an actual equation solve so the test doesn't depend on
# sp.solve's own (documented-elsewhere-as-nondeterministic) internal
# branching to land on this exact unevaluated shape.
_CARDANO_ROOT = (
    -sp.Rational(4, 3)
    + (sp.Rational(-1, 2) - sp.sqrt(3) * sp.I / 2) * (sp.sqrt(1317) / 18 + sp.Rational(115, 54)) ** sp.Rational(1, 3)
    + sp.Rational(7, 9) / ((sp.Rational(-1, 2) - sp.sqrt(3) * sp.I / 2) * (sp.sqrt(1317) / 18 + sp.Rational(115, 54)) ** sp.Rational(1, 3))
)


def test_rectangular_is_the_default(resolve):
    response = resolve(["Complex", 3, 4])
    assert response["mode"] == "evaluate"
    assert response["result"] == "3 + 4*I"


def test_rectangular_mode_splits_real_and_imaginary_parts():
    # User-reported bug: "rectangular" was a pure no-op in Standard/exact
    # mode — a solve result like the Cardano root above left its real and
    # imaginary parts still coupled together (a cube-root factor multiplied
    # through a complex coefficient, added to that same coefficient's
    # reciprocal) instead of actually split into a+bi, despite "Rectangular"
    # supposedly being an active, independent setting symmetric with
    # "Polar". expand_complex() is what performs that split; nothing did
    # this before. The bug's own signature: the unfixed text contains the
    # coefficient "(-1/2 - sqrt(3)*I/2)" multiplied directly against the
    # cube root, rather than a lone "I*(...)" imaginary term added on.
    text, _latex = _format_number(_CARDANO_ROOT, None, "standard", complex_form="rectangular")
    assert text.count("I") >= 1
    assert "sqrt(3)*I/2" not in text  # the old coupled-coefficient shape
    assert text.startswith("-4/3 - ") or text.startswith("-4/3-")
    assert " + I*(" in text or "+ I*(" in text


def test_polar_mode_stays_polar_when_exact_form_is_too_long():
    # User-reported bug: this same Cardano root's exact polar form
    # (r*exp(I*theta), both sides built from nested cube roots/atan) runs
    # ~375 characters, past STANDARD_MAX_LEN — the old code routed the
    # "too long to show exactly" fallback through _safe_str_latex, which
    # evalfs whatever it's handed as one combined expression. Evalf-ing a
    # combined r*exp(I*theta) collapses straight back to a plain rectangular
    # decimal (mpmath's complex evalf has no polar form to preserve), so the
    # result silently stopped being polar at all — neither the requested
    # form nor the requested precision (Standard/exact). The fix: fall
    # through to the same independent r/theta evalf technique the
    # Decimal/Engineering branch already used, instead of the generic
    # combined-expression fallback.
    text, _latex = _format_number(_CARDANO_ROOT, None, "standard", complex_form="polar")
    assert "exp(" in text and "*I)" in text


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
