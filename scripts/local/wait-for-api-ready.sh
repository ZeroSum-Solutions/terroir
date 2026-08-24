#!/usr/bin/env bash
# scripts/local/wait-for-api-ready.sh
#
# Shared post-reset API readiness gate for this repo's local Supabase stack.
# Extracted out of dev-stack.sh so every mutating entry point can share ONE
# implementation instead of duplicating (and risking drift between) a bash
# copy and a hand-rolled node copy. See docs/runbooks/local-stack.md
# "Post-reset readiness" for the full model of why this gate exists.
#
# Sourced (bash callers, e.g. dev-stack.sh):
#   source scripts/local/wait-for-api-ready.sh
#   _wait_for_api_ready "$base_url" "$anon_or_service_key" ["$container"]
#
# Executed directly (non-bash callers, e.g. seed-local-supabase.mjs, the
# same way they already shell out to assert-local-db.sh):
#   scripts/local/wait-for-api-ready.sh <base_url> <anon_or_service_key> [container]
#   exits 0 once ready, 1 if it times out.
#
# `container` is optional either way — if omitted, it's derived from this
# repo's supabase/config.toml via _kong_container_name.

_kong_container_name() {
  # Derive this repo's Kong container name from supabase/config.toml's
  # project_id (supabase-cli names containers "supabase_<service>_<project_id>")
  # instead of hardcoding it, so this keeps working if project_id ever changes.
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

_http_code() {
  # Quiet HTTP status probe. Reports the connection's ACTUAL status code
  # even on total failure: curl's `-w '%{http_code}'` already writes "000"
  # itself when the request never completes (closed port, connection
  # refused, timeout) — but curl also exits non-zero in that case. The
  # `|| code=000` fallback below is a plain assignment (replace), not a
  # second `echo` inside the same command substitution (append) — the
  # latter would double the digits into "000000" instead of the clean
  # "000" that a genuinely unreachable API should report.
  local url="$1"
  shift
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$@" "$url" 2>/dev/null)" || code=000
  echo "$code"
}

# Poll until the API is actually serving traffic, not just "container
# started". Guards against the Kong-stale-upstream-IP race described in
# docs/runbooks/local-stack.md: if 502s persist past a few seconds, restart
# Kong once (clears its cached upstream IPs) and keep polling. Bounded
# overall — never hangs forever.
_wait_for_api_ready() {
  local base_url="$1" anon_key="$2"
  local container="${3:-}"
  if [ -z "$container" ]; then
    container="$(_kong_container_name)"
  fi
  local timeout_s=30 restart_after_s=5
  local start_ts elapsed auth_code rest_code restarted=0

  echo "dev-stack: waiting for the API to be ready (up to ${timeout_s}s)..."

  start_ts="$(date +%s)"
  while true; do
    auth_code="$(_http_code "${base_url}/auth/v1/health")"
    rest_code="$(_http_code "${base_url}/rest/v1/" -H "apikey: ${anon_key}")"

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

# Executed directly (not sourced) — run the gate against argv and exit with
# its status. See usage header above.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  set -uo pipefail
  if [ $# -lt 2 ]; then
    echo "usage: $0 <base_url> <anon_or_service_key> [container]" >&2
    exit 2
  fi
  _wait_for_api_ready "$1" "$2" "${3:-}"
  exit $?
fi
