#!/usr/bin/env bash
# Runs the whole test suite: backend/tests (pytest, calling compute.handle()
# directly — no server needed) and frontend/tests (headless-Chromium E2E via
# puppeteer-core, against a real backend instance this script starts and
# tears down on its own).
#
# Usage:
#   scripts/test.sh            # everything
#   scripts/test.sh --backend  # backend/tests only, skips starting a server
#   scripts/test.sh --frontend # frontend/tests only (still starts a server)
#
# Exits non-zero if anything fails. Safe to run alongside a real desktop
# app instance already using port 5000 — this always runs its own server on
# a separate, fixed test port instead of touching that one.

set -u
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TEST_PORT=5099
VENV_PY="backend/.venv/bin/python"
VENV_PYTEST="backend/.venv/bin/pytest"

RUN_BACKEND=1
RUN_FRONTEND=1
case "${1:-}" in
  --backend) RUN_FRONTEND=0 ;;
  --frontend) RUN_BACKEND=0 ;;
esac

overall_status=0

# ---------- Backend (pytest) ----------

if [ "$RUN_BACKEND" = "1" ]; then
  if [ ! -x "$VENV_PY" ]; then
    echo "backend/.venv not found — set it up first (see install-linux.sh / install-windows.ps1)." >&2
    exit 1
  fi
  if [ ! -x "$VENV_PYTEST" ]; then
    echo "pytest not installed in backend/.venv — installing from backend/requirements-dev.txt..."
    "$VENV_PY" -m pip install -q -r backend/requirements-dev.txt || exit 1
  fi

  echo "== backend/tests (pytest) =="
  "$VENV_PYTEST" backend/tests -q
  backend_status=$?
  if [ $backend_status -ne 0 ]; then overall_status=1; fi
  echo
fi

# ---------- Frontend (puppeteer-core E2E) ----------

if [ "$RUN_FRONTEND" = "1" ]; then
  CHROMIUM_PATH="${PRETTYCAS_CHROMIUM:-}"
  if [ -z "$CHROMIUM_PATH" ]; then
    for candidate in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome /usr/bin/google-chrome-stable; do
      if [ -x "$candidate" ]; then CHROMIUM_PATH="$candidate"; break; fi
    done
  fi

  if [ ! -d frontend/node_modules/puppeteer-core ]; then
    echo "== frontend/tests skipped: puppeteer-core not found in frontend/node_modules (run npm install in frontend/) =="
  elif [ -z "$CHROMIUM_PATH" ]; then
    echo "== frontend/tests skipped: no Chromium/Chrome binary found (set PRETTYCAS_CHROMIUM to its path) =="
  else
    if lsof -i ":$TEST_PORT" >/dev/null 2>&1; then
      echo "Port $TEST_PORT is already in use — can't start the test backend there. Stop whatever's using it and re-run." >&2
      exit 1
    fi

    echo "== starting test backend on port $TEST_PORT =="
    "$VENV_PY" -c "
import sys
sys.path.insert(0, 'backend')
import app
app.app.run(port=$TEST_PORT, debug=False, threaded=True)
" >/tmp/prettycas-test-backend.log 2>&1 &
    server_pid=$!
    trap 'kill "$server_pid" 2>/dev/null' EXIT

    ready=0
    for _ in $(seq 1 30); do
      if curl -s -o /dev/null "http://127.0.0.1:$TEST_PORT/api/capabilities"; then
        ready=1
        break
      fi
      sleep 0.3
    done
    if [ "$ready" != "1" ]; then
      echo "Test backend never became ready — see /tmp/prettycas-test-backend.log" >&2
      overall_status=1
    else
      echo "== frontend/tests (node --test, headless Chromium) =="
      PRETTYCAS_BASE_URL="http://127.0.0.1:$TEST_PORT" PRETTYCAS_CHROMIUM="$CHROMIUM_PATH" \
        node --test frontend/tests/e2e.test.js
      frontend_status=$?
      if [ $frontend_status -ne 0 ]; then overall_status=1; fi
    fi

    kill "$server_pid" 2>/dev/null
    trap - EXIT
  fi
fi

if [ $overall_status -eq 0 ]; then
  echo "All tests passed."
else
  echo "Some tests failed — see output above." >&2
fi
exit $overall_status
