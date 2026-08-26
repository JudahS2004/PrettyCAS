import sympy as sp

from ..mathjson import to_sympy


def try_unknown_matrix(mathjson, angle_mode="rad"):
    """If `mathjson` is `["Equal", ..., ...]` with a bare identifier
    multiplied directly against a concrete matrix on one side, and a
    concrete matrix on the other (e.g. ["Multiply", "x", <matrix>] = <matrix>),
    solve for that identifier as an entire unknown matrix and return a
    resolved dict (see compute._resolve) for it. Returns None if the shape
    doesn't match this pattern, so the caller should fall back to the
    regular equation pipeline (which already handles a bare symbol used as
    a single scalar entry *inside* a literal matrix, an unrelated case).
    """
    if not (isinstance(mathjson, list) and len(mathjson) == 3 and mathjson[0] == "Equal"):
        return None

    lhs, rhs = mathjson[1], mathjson[2]
    for multiply_node, target_node in ((lhs, rhs), (rhs, lhs)):
        match = _find_unknown_times_matrix(multiply_node)
        if match and _is_matrix_node(target_node):
            known_node, unknown_is_left = match
            return solve(known_node, target_node, unknown_is_left, angle_mode)

    return None


def _is_matrix_node(node):
    return isinstance(node, list) and len(node) > 0 and node[0] == "Matrix"


def _find_unknown_times_matrix(node):
    if not (isinstance(node, list) and len(node) == 3 and node[0] == "Multiply"):
        return None
    a, b = node[1], node[2]
    if isinstance(a, str) and _is_matrix_node(b):
        return (b, True)  # unknown * known
    if isinstance(b, str) and _is_matrix_node(a):
        return (a, False)  # known * unknown
    return None


def solve(known_node, target_node, unknown_is_left, angle_mode="rad"):
    """Solve for an entirely unknown matrix X in `X * known = target` (or
    `known * X = target` when `unknown_is_left` is False).

    `known_node` and `target_node` are the concrete Matrix mathjson nodes
    on either side (with the bare unknown identifier stripped out by the
    caller); X itself is never built as a symbol here — a bare identifier
    multiplied straight into a concrete matrix would otherwise be read as
    scalar broadcasting (X times every entry), not matrix multiplication,
    so this is solved directly by inversion instead of going through the
    generic to_sympy/solve pipeline.
    """
    known = to_sympy(known_node, angle_mode)
    target = to_sympy(target_node, angle_mode)

    if not known.is_square:
        return _error(
            f"can't solve: the known {known.shape[0]}x{known.shape[1]} matrix "
            "isn't square, so there's no unique unknown matrix"
        )

    if unknown_is_left:
        if target.cols != known.cols:
            return _shape_error(known, target)
        solve_for = lambda inv: target * inv
    else:
        if target.rows != known.rows:
            return _shape_error(known, target)
        solve_for = lambda inv: inv * target

    try:
        solution = solve_for(known.inv())
    except sp.matrices.exceptions.NonInvertibleMatrixError:
        return _error("can't solve: the known matrix isn't invertible")

    return {"kind": "matrix", "matrix": solution}


def _shape_error(known, target):
    return _error(
        f"can't solve: a {known.shape[0]}x{known.shape[1]} known matrix and a "
        f"{target.shape[0]}x{target.shape[1]} target matrix aren't compatible "
        "for this multiplication"
    )


def _error(message):
    return {"kind": "final", "response": {"mode": "error", "result": message}}
