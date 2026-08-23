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

# Derive this repo's Kong container name from supabase/config.toml's
# project_id (supabase-cli names containers "supabase_<service>_<project_id>")
# instead of hardcoding it, so this keeps working if project_id ever changes.
_kong_container_name() {
  local project_id
  project_id="$(
    awk -F'=' '
      /^project_id[ \t]*=/ {
        val = $2
        gsub(/[ \t"]/, "", val)
        print val
        exit
      }
    ' supabase/config.toml 2>/dev/null
  )"
  if [ -z "$project_id" ]; then
    # Fallback: this repo's known project_id, in case config.toml is ever
    # unreadable/reformatted in a way the awk above can't parse.
    project_id="terroir-vw-local"
  fi
  echo "supabase_kong_${project_id}"
}

# Poll until the API is actually serving traffic, not just "container
# started". Guards against the Kong-stale-upstream-IP race described above:
# if 502s persist past a few seconds, restart Kong once (clears its cached
# upstream IPs) and keep polling. Bounded overall — never hangs forever.
_wait_for_api_ready() {
  local base_url="$1" anon_key="$2" container="$3"
  local timeout_s=30 restart_after_s=5
  local start_ts elapsed auth_code rest_code restarted=0

  echo "dev-stack: waiting for the API to be ready (up to ${timeout_s}s)..."

  start_ts="$(date +%s)"
  while true; do
    auth_code="$(curl -s -o /dev/null -w '%{http_code}' "${base_url}/auth/v1/health" 2>/dev/null || echo 000)"
    rest_code="$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: ${anon_key}" "${base_url}/rest/v1/" 2>/dev/null || echo 000)"

    if [ "$auth_code" = "200" ] && [ "$rest_code" = "200" ]; then
      echo "dev-stack: API ready (auth/v1/health=${auth_code}, rest/v1/=${rest_code})."
      return 0
    fi

    elapsed=$(( $(date +%s) - start_ts ))

    if [ "$restarted" -eq 0 ] && [ "$elapsed" -ge "$restart_after_s" ] \
       && { [ "$auth_code" = "502" ] || [ "$rest_code" = "502" ]; }; then
      echo "dev-stack: got 502 ${elapsed}s post-reset (auth=${auth_code}, rest=${rest_code})" >&2
      echo "dev-stack: this is Kong holding a stale Docker IP for the restarted auth container." >&2
      echo "dev-stack: restarting ${container} once to clear its upstream cache, then resuming..." >&2
      docker restart "$container" >/dev/null 2>&1 || true
      restarted=1
    fi

    if [ "$elapsed" -ge "$timeout_s" ]; then
      echo "" >&2
      echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
      echo "!! dev-stack: API did not become ready within ${timeout_s}s.          !!" >&2
      echo "!!   auth/v1/health = ${auth_code}   rest/v1/ = ${rest_code}          !!" >&2
      echo "!! Refusing to seed against a possibly-broken stack.                 !!" >&2
      echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
      echo "" >&2
      return 1
    fi

    sleep 1
  done
}

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
