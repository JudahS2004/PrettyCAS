import sympy as sp

from functions.compute import _safe_str_latex
from functions.format_result import cap_decimals, to_engineering, to_display


def test_cap_decimals_leaves_a_genuinely_exact_value_alone():
    assert cap_decimals(sp.pi, 50) == 50


def test_cap_decimals_caps_a_float_carrying_value_to_its_own_precision():
    # A double-precision Float only carries ~15-17 honest significant
    # digits — asking for 50 decimals of it shouldn't be granted, or the
    # extra digits are meaningless padding, not real precision (see
    # cap_decimals's own comment on why this trap is easy to fall into).
    value = sp.Float(1.0, 15) / sp.Integer(3)
    capped = cap_decimals(value, 50)
    assert capped < 50


def test_engineering_notation_basic_mantissa_exponent():
    # Engineering notation: exponent forced to a multiple of 3
    # ("12.34e3" rather than plain scientific "1.234e4").
    text, latex = to_engineering(sp.Float(12345.0), 4)
    assert text == "12.34e3"
    assert "10^{3}" in latex


def test_engineering_notation_zero():
    text, latex = to_engineering(sp.Integer(0), 4)
    assert text == "0"


def test_engineering_notation_out_of_double_range_falls_back_to_none():
    # mpmath converts an out-of-double-range Float to inf via float()
    # rather than raising — to_engineering must not try to format "inf"
    # with an "e" exponent split (see its own math.isfinite guard, and the
    # PROJECT_SUMMARY entry on the ValueError this used to raise).
    huge = sp.Float(10) ** 400
    assert to_engineering(huge, 6) is None


def test_engineering_notation_symbolic_value_falls_back_to_none():
    x = sp.Symbol("x")
    assert to_engineering(x + 1, 6) is None


def test_astronomically_large_exact_result_falls_back_to_scientific_notation():
    # A real Okumura-Hata-style path-loss solve landed on a value around
    # 10**20000 — CPython 3.11+ refuses to str()/latex() an int that large
    # at all (sys.get_int_max_str_digits(), ~4300 digits by default).
    # Built directly as a sympy Integer (not parsed from a JSON string) so
    # this test hits the exact same wall the display code has to guard
    # against, without also tripping the *separate* int(str)-side digit
    # limit just constructing the input MathJSON would run into.
    huge = sp.Integer(10) ** 20000
    text, latex = _safe_str_latex(huge)
    assert "integer string conversion" not in text
    assert text.startswith("1.0") and "20000" in text


def test_absurdly_long_but_not_over_the_hard_limit_result_still_degrades():
    # STANDARD_MAX_LEN (200 chars): a many-hundred-digit "exact" value
    # (well under the ~4300-digit hard limit, so str()/latex() wouldn't
    # raise) is just as useless to a user as one that hits the hard wall —
    # the same fallback should kick in well before that limit.
    long_but_valid = sp.Integer(10) ** 300 + 1234567
    text, latex = _safe_str_latex(long_but_valid)
    assert len(text) < 200


def test_ordinary_small_exact_value_is_unaffected():
    text, latex = _safe_str_latex(sp.Integer(42))
    assert text == "42"
