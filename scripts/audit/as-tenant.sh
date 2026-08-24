#!/usr/bin/env bash
# scripts/audit/as-tenant.sh
#
# Perform a PostgREST request against THIS worktree's isolated audit
# Supabase stack (127.0.0.1:58321) AS a given seeded tenant user, by
# minting a real session for that user through the same admin
# generate_link -> verify (magiclink) flow src/app/api/dev-login/route.ts
# uses, then sending the resulting access token as a Bearer credential.
#
# Usage:
#   scripts/audit/as-tenant.sh <ownerA@audit.test|ownerB@audit.test> <curl-args...>
#
# Examples:
#   scripts/audit/as-tenant.sh ownerA@audit.test \
#     "http://127.0.0.1:58321/rest/v1/restaurants?select=*"
#
#   scripts/audit/as-tenant.sh ownerB@audit.test \
#     "http://127.0.0.1:58321/rest/v1/wines?select=*" -i
#
# All trailing arguments are passed through to curl unchanged, with
# Authorization + apikey headers for the minted session prepended.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -f "$REPO_ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env.local"
  set +a
fi

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-http://127.0.0.1:58321}"
ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:?NEXT_PUBLIC_SUPABASE_ANON_KEY not set (.env.local)}"
SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY not set (.env.local)}"

# Safety gate: refuse anything but a local target.
case "$SUPABASE_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    echo "as-tenant.sh: REFUSING — NEXT_PUBLIC_SUPABASE_URL is not local ($SUPABASE_URL)" >&2
    exit 1
    ;;
esac

EMAIL="${1:-}"
if [ -z "$EMAIL" ]; then
  echo "usage: $0 <email> <curl-args...>" >&2
  exit 1
fi
shift

if ! command -v jq >/dev/null 2>&1; then
  echo "as-tenant.sh: requires jq (brew install jq)" >&2
  exit 1
fi

# Step 1: admin mints a one-time magiclink proof for this user.
GEN_RESPONSE="$(curl -sS -X POST "$SUPABASE_URL/auth/v1/admin/generate_link" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg email "$EMAIL" '{type:"magiclink", email:$email}')")"

TOKEN_HASH="$(echo "$GEN_RESPONSE" | jq -r '.hashed_token // empty')"
if [ -z "$TOKEN_HASH" ]; then
  echo "as-tenant.sh: generate_link failed for $EMAIL:" >&2
  echo "$GEN_RESPONSE" >&2
  exit 1
fi

# Step 2: redeem the proof for a real session (access_token + refresh_token).
VERIFY_RESPONSE="$(curl -sS -X POST "$SUPABASE_URL/auth/v1/verify" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg token_hash "$TOKEN_HASH" '{type:"magiclink", token_hash:$token_hash}')")"

ACCESS_TOKEN="$(echo "$VERIFY_RESPONSE" | jq -r '.access_token // empty')"
if [ -z "$ACCESS_TOKEN" ]; then
  echo "as-tenant.sh: verify failed for $EMAIL:" >&2
  echo "$VERIFY_RESPONSE" >&2
  exit 1
fi

exec curl -sS \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "apikey: $ANON_KEY" \
  "$@"
