def test_second_order_linear_ode(resolve):
    # f''(x) + f(x) = 0  =>  f(x) = C1*sin(x) + C2*cos(x)
    second_deriv = ["Apply", ["Derivative", "f", 2], "x"]
    fx = ["f", "x"]
    response = resolve(["Equal", ["Add", second_deriv, fx], 0])
    assert response["mode"] == "ode"
    assert "sin(x)" in response["result"]
    assert "cos(x)" in response["result"]


def test_first_order_linear_pde(resolve):
    # du/dx + du/dt = 0 (first-order, method of characteristics)
    u = ["u", "x", "t"]
    response = resolve(["Equal", ["Add", ["D", u, "x"], ["D", u, "t"]], 0])
    assert response["mode"] == "pde"
    assert "u(x, t)" in response["result"]


def test_second_order_pde_reports_no_closed_form_honestly(resolve):
    # sp.pdsolve only covers first-order PDEs — a genuine second-order one
    # (heat-equation-shaped here) must NOT be silently mis-answered.
    u = ["u", "x", "t"]
    heat_eq = ["Equal", ["D", u, "x", "x"], ["D", u, "t"]]
    response = resolve(heat_eq)
    assert response["mode"] == "pde"
    assert response["result"] == "no closed form solution"
