#!/usr/bin/env bash
# scripts/local/assert-local-db.sh
#
# Hard safety gate for the local Supabase stack. Refuses to continue unless
# NEXT_PUBLIC_SUPABASE_URL (from the environment, or failing that,
# .env.local) resolves to exactly THIS repo's local API endpoint — the
# 127.0.0.1/localhost host on the port this repo's supabase/config.toml
# ([api] port) declares.
#
# Deliberately NOT a generic "any localhost/127.0.0.1 port" check: several
# other projects' local Supabase stacks run on this machine on their own
# 543xx/553xx/563xx port blocks, and a generic check would happily bless
# mutating one of those instead of this repo's stack.
#
# Every script that mutates the local DB must run this FIRST:
#   source scripts/local/assert-local-db.sh
#
# Works both sourced (aborts just the calling script via `return`) and
# executed directly (aborts the process via `exit`) — no bash-specific
# ceremony required at the call site.

_expected_local_api_port() {
  # Pull the `port` value out of the `[api]` section of this repo's
  # supabase/config.toml — the single source of truth for which port this
  # repo's local stack actually listens on.
  awk '
    /^\[api\]/ { in_api=1; next }
    /^\[/      { in_api=0 }
    in_api && /^port[ \t]*=/ {
      sub(/^port[ \t]*=[ \t]*/, "")
      sub(/[ \t]*#.*$/, "")
      print
      exit
    }
  ' supabase/config.toml 2>/dev/null
}

_assert_local_db() {
  local url="${NEXT_PUBLIC_SUPABASE_URL:-}"

  if [ -z "$url" ] && [ -f .env.local ]; then
    url=$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | tail -1 | cut -d '=' -f2- | tr -d '"'"'"'\r')
  fi

  if [ -z "$url" ]; then
    echo "REFUSING: NEXT_PUBLIC_SUPABASE_URL is not set (checked env + .env.local)." >&2
    return 1
  fi

  local port
  port="$(_expected_local_api_port)"

  if [ -z "$port" ]; then
    echo "REFUSING: could not read [api] port from supabase/config.toml — cannot verify the target is THIS repo's local stack." >&2
    return 1
  fi

  case "$url" in
    "http://127.0.0.1:${port}"|"http://localhost:${port}"|"https://127.0.0.1:${port}"|"https://localhost:${port}")
      echo "assert-local-db: OK — target is this repo's local stack ($url)"
      return 0
      ;;
    *)
      echo "" >&2
      echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
      echo "!! REFUSING TO RUN: NEXT_PUBLIC_SUPABASE_URL is not THIS repo's     !!" >&2
      echo "!! local stack.                                                    !!" >&2
      echo "!!   url = $url" >&2
      echo "!!   expected host:port = 127.0.0.1:${port} or localhost:${port}   !!" >&2
      echo "!! This guard exists so local-only scripts can never mutate a      !!" >&2
      echo "!! hosted (production/staging) Supabase project — OR another       !!" >&2
      echo "!! project's local Supabase stack on this machine (543xx/553xx/    !!" >&2
      echo "!! 563xx etc.). Only this repo's exact configured port passes.     !!" >&2
      echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
      echo "" >&2
      return 1
      ;;
  esac
}

_assert_local_db
_ASSERT_LOCAL_DB_STATUS=$?

if [ "$_ASSERT_LOCAL_DB_STATUS" -ne 0 ]; then
  # `return` succeeds when this file is sourced (aborts just the calling
  # script); it fails with an error when the file is executed directly, in
  # which case we fall through to `exit` to abort the process.
  return "$_ASSERT_LOCAL_DB_STATUS" 2>/dev/null || exit "$_ASSERT_LOCAL_DB_STATUS"
fi

unset _ASSERT_LOCAL_DB_STATUS
