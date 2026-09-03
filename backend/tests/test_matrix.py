def _matrix(rows):
    return ["Matrix", ["List", *[["List", *row] for row in rows]]]


def test_unknown_matrix_solved_by_inversion(resolve):
    # X * [[1,0],[0,2]] = [[2,0],[0,6]]  =>  X = [[2,0],[0,3]]
    known = _matrix([[1, 0], [0, 2]])
    target = _matrix([[2, 0], [0, 6]])
    response = resolve(["Equal", ["Multiply", "X", known], target])
    assert response["mode"] == "solve"
    assert response["method"] == "matrix_inverse"
    result = response["result"][0]
    assert "2" in result and "3" in result


def test_unknown_matrix_non_square_known_reports_error(resolve):
    known = _matrix([[1, 2, 3], [4, 5, 6]])
    target = _matrix([[1, 0], [0, 1]])
    response = resolve(["Equal", ["Multiply", "X", known], target])
    assert response["mode"] == "error"
    assert "square" in response["result"]


def test_unknown_matrix_non_invertible_known_reports_error(resolve):
    known = _matrix([[1, 2], [2, 4]])  # singular
    target = _matrix([[1, 0], [0, 1]])
    response = resolve(["Equal", ["Multiply", "X", known], target])
    assert response["mode"] == "error"
    assert "invertible" in response["result"]


def test_determinant_of_square_matrix(resolve):
    m = _matrix([[1, 2], [3, 4]])
    response = resolve(["Determinant", m])
    assert response["mode"] == "evaluate"
    assert response["result"] == "-2"


def test_determinant_of_non_square_matrix_reports_error(resolve):
    m = _matrix([[1, 2, 3], [4, 5, 6]])
    response = resolve(["Determinant", m])
    assert response["mode"] == "error"
    assert "square" in response["result"]


def test_matrix_assignment_saves_the_matrix_instead_of_a_false_check(resolve):
    # Regression test: "M = [[1,2],[3,4]]" used to route through the generic
    # Equal->sp.Eq path, and sp.Eq(Symbol, Matrix) auto-evaluates straight to
    # BooleanFalse (a Matrix isn't a scalar Eq can keep symbolic against a
    # free Symbol) — so this came back as a plain "check: False" instead of
    # ever resolving/saving the matrix. See compute.py's
    # _try_matrix_assignment.
    m = _matrix([[1, 2], [3, 4]])
    response = resolve(["Equal", "M", m])
    assert response["mode"] == "evaluate"
    assert response["numeric"] == [[1, 2], [3, 4]]


def test_matrix_workspace_variable_can_be_referenced_directly(resolve):
    response = resolve("M", constants={"M": [[1, 2], [3, 4]]})
    assert response["mode"] == "evaluate"
    assert response["numeric"] == [[1, 2], [3, 4]]


def test_determinant_of_matrix_workspace_variable(resolve):
    response = resolve(["Determinant", "M"], constants={"M": [[1, 2], [3, 4]]})
    assert response["mode"] == "evaluate"
    assert response["result"] == "-2"


def test_inverse_of_matrix_workspace_variable(resolve):
    response = resolve(["Inverse", "M"], constants={"M": [[2, 0], [0, 2]]})
    assert response["mode"] == "evaluate"
    assert response["numeric"] == [[0.5, 0], [0, 0.5]]


def test_addition_of_two_matrix_workspace_variables(resolve):
    response = resolve(
        ["Add", "M", "N"],
        constants={"M": [[1, 2], [3, 4]], "N": [[10, 0], [0, 10]]},
    )
    assert response["mode"] == "evaluate"
    assert response["numeric"] == [[11, 2], [3, 14]]


def test_scalar_multiply_of_a_matrix_workspace_variable(resolve):
    response = resolve(["Multiply", 2, "M"], constants={"M": [[1, 2], [3, 4]]})
    assert response["mode"] == "evaluate"
    assert response["numeric"] == [[2, 4], [6, 8]]


def test_matrix_workspace_variable_with_complex_entries_round_trips(resolve):
    m = resolve(["Equal", "M", ["Matrix", ["List", ["List", ["Complex", 1, 2], 0], ["List", 0, 3]]]])
    assert m["mode"] == "evaluate"
    response = resolve("M", constants={"M": m["numeric"]})
    assert response["mode"] == "evaluate"
    assert response["numeric"][0][0] == {"re": 1.0, "im": 2.0}
