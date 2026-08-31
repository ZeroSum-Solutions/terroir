#!/usr/bin/env bash
# scripts/local/prodshape.sh
#
# Entry point for the production-shaped local tenant
# (`LOCAL PRODSHAPE - Trattoria Bianca`). Pins the LOCAL Supabase stack in the
# process environment and runs the seeder against it.
#
# The pinning is the point. `.env.local` holds PRODUCTION credentials
# (AGENTS.md non-negotiable #1) and node's dotenv would happily load it, so
# this reads the stack from `supabase status` instead — the same thing
# scripts/local/dev-local.sh and scratchpad/e2e-run.sh do — and refuses
# anything that is not loopback.
#
# Usage:
#   scripts/local/prodshape.sh                      # dry run, no writes
#   scripts/local/prodshape.sh --confirm            # create / refresh (idempotent)
#   scripts/local/prodshape.sh --teardown --confirm # remove it completely
#   scripts/local/prodshape.sh --check              # re-run the corpus-miss gate only
set -euo pipefail
cd "$(dirname "$0")/../.."

STATUS_JSON="$(npx supabase status -o json 2>/dev/null)" || {
  echo "prodshape: local Supabase stack is not running (npx supabase start)." >&2
  exit 1
}

eval "$(printf '%s' "$STATUS_JSON" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
const q=v=>JSON.stringify(v);
console.log("export NEXT_PUBLIC_SUPABASE_URL="+q(j.API_URL));
console.log("export NEXT_PUBLIC_SUPABASE_ANON_KEY="+q(j.ANON_KEY));
console.log("export SUPABASE_SERVICE_ROLE_KEY="+q(j.SERVICE_ROLE_KEY));
});')"

case "$NEXT_PUBLIC_SUPABASE_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "prodshape: refusing, Supabase target is not loopback." >&2; exit 1 ;;
esac

if [ "${1:-}" = "--check" ]; then
  exec node scripts/local/prodshape-corpus-miss-check.mjs
fi

exec node scripts/local/seed-prodshape-tenant.mjs "$@"
