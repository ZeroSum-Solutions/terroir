#!/usr/bin/env bash
# scripts/local/dev-local.sh
#
# Run the dev server against the LOCAL Supabase stack.
#
# `pnpm dev` on its own does not do this. Next loads the dotenv file, and per
# AGENTS.md non-negotiable #1 that file holds PRODUCTION credentials — a
# hosted project URL and a production service-role key. So the plain command
# starts a development server, with development's relaxed guards, holding a
# key that bypasses RLS on the live tenant database. /api/dev-login is the
# sharp edge: it is disabled only when NODE_ENV === "production", which is
# false here, so it will mint a magic link against production instead.
#
# Nothing about that is visible in the terminal. The server prints a
# "Environments" line and a localhost URL either way, so the only signal that
# a session is hitting production is the data that comes back.
#
# This script pins the local stack in the PROCESS environment, which Next
# resolves ahead of any dotenv file, and reads the keys from `supabase status`
# rather than hardcoding them, so a `supabase stop && start` that re-mints
# them cannot silently leave this pointing at a dead stack.
#
# Usage:  scripts/local/dev-local.sh [-p 3000] [...next dev args]
#
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! command -v npx >/dev/null 2>&1; then
  echo "dev-local: npx not found." >&2
  exit 1
fi

echo "dev-local: reading local stack credentials from supabase status ..."
STATUS_JSON="$(npx supabase status -o json 2>/dev/null)" || {
  echo "dev-local: could not read supabase status — is the local stack running? (npx supabase start)" >&2
  exit 1
}

read_key() {
  printf '%s' "$STATUS_JSON" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try { const v = JSON.parse(s)[process.argv[1]]; if (v) process.stdout.write(String(v)); }
      catch { /* leave empty; the caller checks for a blank value */ }
    });
  ' "$1"
}

API_URL="$(read_key API_URL)"
PUBLISHABLE="$(read_key PUBLISHABLE_KEY)"
SERVICE="$(read_key SERVICE_ROLE_KEY)"

if [ -z "$API_URL" ] || [ -z "$PUBLISHABLE" ] || [ -z "$SERVICE" ]; then
  echo "dev-local: supabase status did not report API_URL/PUBLISHABLE_KEY/SERVICE_ROLE_KEY." >&2
  exit 1
fi

# Belt and braces: the same guard every other local-only script here runs,
# applied to the URL we are about to hand the server. If `supabase status`
# ever reports something non-loopback, refuse rather than serve it.
NEXT_PUBLIC_SUPABASE_URL="$API_URL" source scripts/local/assert-local-db.sh

echo "dev-local: serving against $API_URL"
exec env \
  NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE" \
  SUPABASE_SERVICE_ROLE_KEY="$SERVICE" \
  pnpm dev "$@"
