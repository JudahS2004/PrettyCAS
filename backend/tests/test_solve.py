def test_linear_solve(resolve):
    response = resolve(["Equal", "x", ["Add", "y", 4]], constants={})
    # No workspace value for y and none requested for x either — with two
    # free symbols and no solve_for, this routes through the system solver,
    # not the single-symbol one (see test_workspace.py for the case where a
    # workspace constant pins one of the symbols instead).
    assert response["mode"] in ("solve", "system")


def test_simple_single_symbol_solve(resolve):
    response = resolve(["Equal", ["Multiply", 2, "x"], 10])
    assert response["mode"] == "solve"
    assert response["result"] == ["5"]
    assert response["numeric"] == 5


def test_quadratic_two_real_roots(resolve):
    response = resolve(["Equal", ["Power", "x", 2], 4])
    assert response["mode"] == "solve"
    assert set(response["result"]) == {"-2", "2"}
    # More than one solution — no single top-level "numeric" field.
    assert "numeric" not in response


def test_quadratic_complex_roots_rectangular_by_default(resolve):
    response = resolve(["Equal", ["Power", "x", 2], -4])
    assert response["mode"] == "solve"
    assert set(response["result"]) == {"-2*I", "2*I"}


def test_quadratic_complex_roots_polar_form(resolve):
    response = resolve(["Equal", ["Power", "x", 2], -4], complex_form="polar")
    assert response["mode"] == "solve"
    # "Nice" angles (pi/2 here) still collapse back to the rectangular
    # -equivalent form automatically (see _format_polar's own comment) —
    # 2*I stays 2*I even under the Polar setting, it doesn't force
    # 2*exp(I*pi/2) for an angle sympy already knows how to simplify away.
    assert set(response["result"]) == {"-2*I", "2*I"}


def test_cubic_with_clean_rational_roots_stays_readable(resolve):
    # x^3 - 7x + 6 = 0 factors to (x-1)(x-2)(x+3) — a discriminant>0 cubic
    # with simple rational roots. The trig-form fallback (for the
    # casus-irreducibilis case) must NOT fire here, or this comes back as an
    # unreadable trig expression instead of "-3", "1", "2" (see algebraic.py's
    # own comment on why try_algebraic tries plain sp.solve first).
    poly = ["Add", ["Power", "x", 3], ["Multiply", -7, "x"], 6]
    response = resolve(["Equal", poly, 0])
    assert response["mode"] == "solve"
    assert set(response["result"]) == {"-3", "1", "2"}


def test_explicit_solve_for_target(resolve):
    response = resolve(["Equal", ["Power", "x", 2], -1], solve_for="x")
    assert response["mode"] == "solve"
    assert response["result"] == ["-I", "I"]
