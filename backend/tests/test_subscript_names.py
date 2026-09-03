def test_letter_subscript_becomes_one_underscore_joined_symbol(resolve):
    # \mu_r doesn't get flattened by compute-engine's own parser the way a
    # digit subscript (X_1) does — it arrives as an unevaluated
    # ["Subscript", base, sub] node. mathjson.py's OPS["Subscript"] must
    # fold it into one sp.Symbol("mu_r") so it behaves like any other
    # variable (substitutable, solvable), not an opaque Function call.
    response = resolve(
        ["Equal", ["Add", ["Subscript", "mu", "r"], 1], 5],
    )
    assert response["mode"] == "solve"
    assert response["result"] == ["4"]


def test_subscripted_name_can_be_a_workspace_constant(resolve):
    response = resolve(
        ["Add", ["Subscript", "k", "B"], 1],
        constants={"k_B": 10},
    )
    assert response["mode"] == "evaluate"
    assert response["numeric"] == 11


def test_subscripted_name_round_trips_through_latex(resolve):
    response = resolve(["Subscript", "mu", "r"])
    assert response["latex"] == "\\mu_{r}"
