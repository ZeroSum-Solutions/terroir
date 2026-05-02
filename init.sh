#!/usr/bin/env bash
# Terroir — environment setup + dev server bootstrap
#
# Usage: ./init.sh           # install deps and start dev server (foreground)
#        ./init.sh --bg      # install deps and start dev server in background
#        ./init.sh --install # install deps only
#
# Prereqs: Node >=20, pnpm >=9, .env.local populated from .env.example.

set -euo pipefail

PORT="${PORT:-3000}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

log() { printf '[init] %s\n' "$*"; }

# 1. Tool versions ------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "[init] node is required (>=20). Install Node 20+ and re-run." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[init] pnpm is required (>=9). Run: npm install -g pnpm@9" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[init] Node $NODE_MAJOR detected; >=20 required." >&2
  exit 1
fi

# 2. Env file -----------------------------------------------------------------
if [ ! -f .env.local ]; then
  if [ -f .env.example ]; then
    log "No .env.local found — copying from .env.example. Fill in real keys before hitting AI/Supabase routes."
    cp .env.example .env.local
  else
    log "WARNING: no .env.local and no .env.example — Supabase/Anthropic/Azure calls will fail."
  fi
fi

# 3. Dependencies -------------------------------------------------------------
log "Installing dependencies via pnpm…"
pnpm install --frozen-lockfile=false

if [ "${1:-}" = "--install" ]; then
  log "Install complete. Skipping server start (--install)."
  exit 0
fi

# 4. Free the port ------------------------------------------------------------
if command -v lsof >/dev/null 2>&1; then
  if lsof -ti ":$PORT" >/dev/null 2>&1; then
    log "Port $PORT in use — killing existing process(es)."
    lsof -ti ":$PORT" | xargs kill -9 2>/dev/null || true
    sleep 2
  fi
fi

# 5. Dev server ---------------------------------------------------------------
if [ "${1:-}" = "--bg" ]; then
  log "Starting Next.js dev server in background on port $PORT (logs: .next-dev.log)…"
  PORT="$PORT" nohup pnpm dev >.next-dev.log 2>&1 &
  echo $! >.next-dev.pid
  sleep 6
  log "Dev server PID $(cat .next-dev.pid). Health: http://localhost:$PORT/api/health"
  log "Tail logs:  tail -f .next-dev.log"
  log "Stop:       kill \$(cat .next-dev.pid) && rm .next-dev.pid"
else
  log "Starting Next.js dev server on port $PORT (Ctrl+C to stop)…"
  log "App:    http://localhost:$PORT"
  log "Health: http://localhost:$PORT/api/health"
  exec pnpm dev
fi
