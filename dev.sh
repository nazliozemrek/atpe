#!/usr/bin/env bash
# Runs the API (port 8000) and the dashboard (port 3000); Ctrl+C stops both.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT/backend"
set -a; [ -f .env ] && source .env; set +a
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --reload --reload-exclude 'data/*' &
API_PID=$!

cd "$ROOT/frontend"
npm run dev -- --port 3000 &
WEB_PID=$!

trap 'kill $API_PID $WEB_PID 2>/dev/null || true' INT TERM EXIT
wait
