#!/usr/bin/env bash
# scripts/local/dev-stack.sh
#
# One-command local Supabase bring-up for Terroir. Safe to re-run — every
# step is idempotent. See docs/runbooks/local-stack.md for the full model.
#
#   1. Ensure .env.local exists (bootstraps from .env.local.example).
#   2. Assert the configured Supabase URL is local (127.0.0.1/localhost).
#   3. `supabase start` (no-op if already running).
#   4. `supabase db reset` — drops + recreates the local DB, applies every
#      migration in supabase/migrations/ from scratch.
#   5. Seed the dev-login bypass user + restaurant/membership.
#   6. Print status + next steps.
#
# NEVER points at hosted Supabase — the assert-local-db gate refuses
# anything that isn't 127.0.0.1/localhost before any DB command runs.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

if [ ! -f .env.local ]; then
  if [ ! -f .env.local.example ]; then
    echo "dev-stack: missing both .env.local and .env.local.example — nothing to bootstrap from." >&2
    exit 1
  fi
  echo "dev-stack: .env.local not found — creating it from .env.local.example."
  install -m 600 .env.local.example .env.local
fi

# shellcheck disable=SC1091
source scripts/local/assert-local-db.sh

echo ""
echo "=== dev-stack: supabase start ==="
supabase start

echo ""
echo "=== dev-stack: supabase db reset (fresh schema from supabase/migrations/) ==="
supabase db reset

echo ""
echo "=== dev-stack: seed dev-login user + restaurant ==="
node scripts/local/seed-local.mjs

echo ""
echo "=== dev-stack: status ==="
supabase status

DEV_BYPASS_EMAIL="$(grep -E '^DEV_BYPASS_EMAIL=' .env.local | tail -1 | cut -d '=' -f2-)"
APP_URL="$(grep -E '^NEXT_PUBLIC_APP_URL=' .env.local | tail -1 | cut -d '=' -f2-)"

cat <<EOF

=================================================================
 Terroir local stack is up.
=================================================================
 Studio:      http://127.0.0.1:57323
 API:         http://127.0.0.1:57321
 DB:          postgresql://postgres:postgres@127.0.0.1:57322/postgres
 Inbucket:    http://127.0.0.1:57324  (local email capture)
 Dev login:   ${DEV_BYPASS_EMAIL:-devlocal@terroir.test}

 Next steps:
   pnpm dev -p 3100
   curl -i "${APP_URL:-http://localhost:3100}/api/dev-login"   # expect a 30x + session cookies
   pnpm test                                                    # unit suite
   pnpm test:e2e                                                # playwright e2e

 Tear down:
   supabase stop
=================================================================
EOF
