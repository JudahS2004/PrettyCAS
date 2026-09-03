def test_simple_linear_inequality(resolve):
    response = resolve(["Less", ["Multiply", 2, "x"], 10])
    assert response["mode"] == "solve"
    assert response["method"] == "inequality"
    assert response["result"] == ["x ∈ (-∞, 5)"]


def test_chained_inequality_builds_an_intersection(resolve):
    # "0 < x < 5" parses as one variadic node (["Less", 0, "x", 5]), not
    # nested binary ones — see mathjson.py's _chained_relation, which chains
    # pairwise relations together with sp.And for more than two args.
    response = resolve(["Less", 0, "x", 5])
    assert response["mode"] == "solve"
    assert response["method"] == "inequality"
    assert "0" in response["result"][0] and "5" in response["result"][0]
