import os
import sys

# app.py (backend/app.py) does `from functions import compute`, which only
# resolves because backend/ itself — not repo root, not backend/tests/ — is
# on sys.path when Flask actually runs it. pytest's own import-path
# machinery doesn't give us that for free (it inserts the first parent
# directory *without* an __init__.py, which for a bare backend/tests/ would
# be backend/tests itself), so this is done explicitly rather than relying
# on a particular invocation cwd or a pytest.ini rootdir setting.
BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

import pytest

from functions import compute


@pytest.fixture
def resolve():
    """Calls compute.handle() directly — no Flask, no HTTP — and returns the
    response dict. Options are passed as kwargs, matching handle()'s own
    options dict shape (angle_mode, decimals, solve_for, simplify_mode,
    number_format, complex_form, constants, functions, engine_preference).
    This is deliberately the same entry point app.py's /api/compute route
    calls, so a test failure here means a real user-facing response changed,
    not just some internal helper.
    """
    def _resolve(mathjson, **options):
        return compute.handle(mathjson, options)
    return _resolve
