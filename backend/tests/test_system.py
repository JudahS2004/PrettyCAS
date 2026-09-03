def test_linear_system_of_two_equations(resolve):
    equations = [
        ["Equal", ["Add", "x", "y"], 3],
        ["Equal", ["Subtract", "x", "y"], 1],
    ]
    response = resolve(["List", *equations])
    assert response["mode"] == "system"
    assert len(response["result"]) == 1
    line = response["result"][0]
    assert "x = 2" in line
    assert "y = 1" in line


def test_bare_comma_separated_input_is_rejected_not_silently_solved(resolve):
    # "x+y=9,x=2" with no wrapping braces parses as a bare Tuple, not a
    # List/Set — OPS["Tuple"] deliberately raises instead of silently
    # treating stray commas as an implicit system (see its own comment in
    # mathjson.py).
    response = resolve(["Tuple", ["Equal", ["Add", "x", "y"], 9], ["Equal", "x", 2]])
    assert response["mode"] == "error"
