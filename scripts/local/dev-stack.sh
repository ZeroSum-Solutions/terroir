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
#   5. Wait for the API to actually be ready (see "Post-reset readiness"
#      below) before touching it.
#   6. Seed the dev-login bypass user + restaurant/membership.
#   7. Print status + next steps.
#
# NEVER points at hosted Supabase — the assert-local-db gate refuses
# anything that isn't 127.0.0.1/localhost before any DB command runs.
#
# Post-reset readiness: `supabase db reset` restarts the `auth` (GoTrue)
# container, which gets a new internal Docker IP. Kong (the local API
# gateway) can keep routing `/auth/v1/*` to the STALE IP until it's
# restarted, returning transient 502s that can break the seed step (or any
# test run) immediately after bring-up. See docs/runbooks/local-stack.md
# for the full writeup.

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

# _kong_container_name, _http_code, and _wait_for_api_ready live in their own
# sourceable file so the node seed script (scripts/seed-local-supabase.mjs)
# can share this exact readiness gate instead of a second, hand-rolled node
# implementation that could drift from this one. See
# scripts/local/wait-for-api-ready.sh and docs/runbooks/local-stack.md
# "Post-reset readiness".
# shellcheck disable=SC1091
source scripts/local/wait-for-api-ready.sh

echo ""
echo "=== dev-stack: supabase start ==="
supabase start

echo ""
echo "=== dev-stack: supabase db reset (fresh schema from supabase/migrations/) ==="
supabase db reset

echo ""
echo "=== dev-stack: waiting for API readiness (post-reset) ==="
_api_port="$(_expected_local_api_port)"
_anon_key="$(grep -E '^NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=' .env.local | tail -1 | cut -d '=' -f2- | tr -d '"'"'"'\r')"
if ! _wait_for_api_ready "http://127.0.0.1:${_api_port}" "$_anon_key" "$(_kong_container_name)"; then
  exit 1
fi
unset _anon_key

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
   pnpm dev -p 3000
   curl -i "${APP_URL:-http://localhost:3000}/api/dev-login"   # expect a 30x + session cookies
   pnpm test                                                    # unit suite
   pnpm test:e2e                                                # playwright e2e

 Tear down:
   supabase stop
=================================================================
EOF
