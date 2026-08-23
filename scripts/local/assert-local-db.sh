#!/usr/bin/env bash
# scripts/local/assert-local-db.sh
#
# Hard safety gate for the local Supabase stack. Refuses to continue unless
# NEXT_PUBLIC_SUPABASE_URL (from the environment, or failing that,
# .env.local) resolves to 127.0.0.1 or localhost.
#
# Every script that mutates the local DB must run this FIRST:
#   source scripts/local/assert-local-db.sh
#
# Works both sourced (aborts just the calling script via `return`) and
# executed directly (aborts the process via `exit`) — no bash-specific
# ceremony required at the call site.

_assert_local_db() {
  local url="${NEXT_PUBLIC_SUPABASE_URL:-}"

  if [ -z "$url" ] && [ -f .env.local ]; then
    url=$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | tail -1 | cut -d '=' -f2- | tr -d '"'"'"'\r')
  fi

  if [ -z "$url" ]; then
    echo "REFUSING: NEXT_PUBLIC_SUPABASE_URL is not set (checked env + .env.local)." >&2
    return 1
  fi

  case "$url" in
    http://127.0.0.1:*|http://localhost:*|https://127.0.0.1:*|https://localhost:*)
      echo "assert-local-db: OK — target is local ($url)"
      return 0
      ;;
    *)
      echo "" >&2
      echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
      echo "!! REFUSING TO RUN: NEXT_PUBLIC_SUPABASE_URL is not local.          !!" >&2
      echo "!!   url = $url" >&2
      echo "!! This guard exists so local-only scripts can never mutate a      !!" >&2
      echo "!! hosted (production/staging) Supabase project. Only              !!" >&2
      echo "!! http(s)://127.0.0.1:* or http(s)://localhost:* targets pass.    !!" >&2
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
