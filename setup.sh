#!/usr/bin/env bash
# ATPE one-shot setup: backend venv + models, frontend deps, env files.
# Usage: ./setup.sh [--cpu-torch] [--skip-models]
#   --cpu-torch    install the CPU-only PyTorch wheel (much smaller; recommended without an NVIDIA GPU)
#   --skip-models  don't pre-download the Whisper and EasyOCR weights (they download on first use)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CPU_TORCH=0
SKIP_MODELS=0
for arg in "$@"; do
  case "$arg" in
    --cpu-torch) CPU_TORCH=1 ;;
    --skip-models) SKIP_MODELS=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---- prerequisites ---------------------------------------------------------------
say "Checking prerequisites"
PY=""
for candidate in python3.13 python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
    PY="$candidate"; break
  fi
done
[ -n "$PY" ] || die "Python 3.11+ is required"
command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg is required (macOS: brew install ffmpeg · Debian/Ubuntu: sudo apt install ffmpeg)"
command -v ffprobe >/dev/null 2>&1 || die "ffprobe is required (ships with ffmpeg)"
command -v node >/dev/null 2>&1 || die "Node.js 18.18+ is required"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18.18+ is required (found $(node --version))"
ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264 || die "Your ffmpeg build lacks libx264"
echo "python: $($PY --version) · node: $(node --version) · $(ffmpeg -version | head -n1)"

# ---- backend -----------------------------------------------------------------------
say "Creating backend virtualenv"
cd "$ROOT/backend"
[ -d .venv ] || "$PY" -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip wheel >/dev/null

if [ "$CPU_TORCH" -eq 1 ]; then
  say "Installing CPU-only PyTorch"
  pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
fi

say "Installing backend requirements"
pip install -r requirements.txt

mkdir -p data/uploads data/references data/exports data/previews
[ -f .env ] || cat > .env <<'EOF'
# Any setting in config.py can be overridden with ATPE_<NAME>
ATPE_WHISPER_MODEL=base
ATPE_WHISPER_DEVICE=cpu
ATPE_WHISPER_COMPUTE_TYPE=int8
ATPE_OCR_LANGS=en
ATPE_CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
EOF

python - <<'EOF'
from db import init_db
init_db()
print("SQLite database initialised")
EOF

if [ "$SKIP_MODELS" -eq 0 ]; then
  say "Pre-downloading Whisper + EasyOCR weights"
  set -a; source .env; set +a
  python - <<'EOF'
from services import signals
signals._whisper()  # downloads + loads the faster-whisper model
signals._reader()   # downloads + loads the EasyOCR detector/recognizer
print("Models ready")
EOF
fi
deactivate

# ---- frontend -----------------------------------------------------------------------
say "Installing frontend dependencies"
cd "$ROOT/frontend"
npm install --no-fund --no-audit
[ -f .env.local ] || echo "NEXT_PUBLIC_API_URL=http://localhost:8000" > .env.local

say "Done"
cat <<EOF
Start both servers:   ./dev.sh
  API       http://localhost:8000   (docs at /docs)
  Dashboard http://localhost:3000
EOF
