#!/usr/bin/env bash
# scripts/local/assert-local-db.test.sh
#
# Probe matrix for scripts/local/assert-local-db.sh's port-scoping guard,
# plus (below) a probe for scripts/local/wait-for-api-ready.sh's HTTP-code
# capture — kept in this file rather than a new one so `bash
# scripts/local/assert-local-db.test.sh` remains the single command that
# exercises this repo's local-stack safety probes.
# Not wired into `pnpm test` — this repo has no scripts/ test runner
# precedent (vitest covers src/, not scripts/). Run directly:
#   bash scripts/local/assert-local-db.test.sh
#
# Every probe below runs assert-local-db.sh as a subprocess (never sourced)
# so a REFUSING exit never kills this test script's own shell.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

pass=0
fail=0

check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" -eq "$expected" ]; then
    echo "PASS: $desc (exit $actual)"
    pass=$((pass + 1))
  else
    echo "FAIL: $desc (expected exit $expected, got $actual)"
    fail=$((fail + 1))
  fi
}

check_str() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "PASS: $desc (got '$actual')"
    pass=$((pass + 1))
  else
    echo "FAIL: $desc (expected '$expected', got '$actual')"
    fail=$((fail + 1))
  fi
}

probe_url() {
  # String-only: the guard never issues a network request, so this is safe
  # even for the hosted production URL case below.
  NEXT_PUBLIC_SUPABASE_URL="$1" bash scripts/local/assert-local-db.sh >/dev/null 2>&1
}

probe_url "http://127.0.0.1:54321"
check "54321 (another project's local stack) refused" 1 $?

probe_url "http://127.0.0.1:55321"
check "55321 (another project's local stack) refused" 1 $?

probe_url "http://127.0.0.1:56321"
check "56321 (another project's local stack) refused" 1 $?

probe_url "https://fake-hosted-project.supabase.co"
check "hosted URL refused (string comparison only — no request sent)" 1 $?

probe_url "http://127.0.0.1:57321"
check "57321 (this repo's configured port) passes" 0 $?

# Unset env + no .env.local: run from an isolated temp dir carrying only
# this repo's supabase/config.toml (for port derivation) and the guard
# script itself — no .env.local for the fallback path to find.
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
mkdir -p "$tmpdir/supabase" "$tmpdir/scripts/local"
cp supabase/config.toml "$tmpdir/supabase/config.toml"
cp scripts/local/assert-local-db.sh "$tmpdir/scripts/local/assert-local-db.sh"
( cd "$tmpdir" && env -u NEXT_PUBLIC_SUPABASE_URL bash scripts/local/assert-local-db.sh >/dev/null 2>&1 )
check "unset env + no .env.local refused" 1 $?

# --- wait-for-api-ready.sh: unreachable-API HTTP-code capture -------------
#
# The gating logic in _wait_for_api_ready is unaffected by a genuinely
# unreachable API (neither "000" nor "000000" ever equals "200" or "502"),
# but the earlier fault-injection test that verified this round's readiness
# gate (docs/screenshots/p0-local-stack/VERIFICATION.md) only ever pointed
# it at a fake server that returned real 502/200 codes — never a closed
# port. That left a real bug uncaught: curl's `-w '%{http_code}'` already
# prints "000" on total connection failure, but also exits non-zero, so a
# naive `$(curl ... || echo 000)` capture appends a second "000" onto
# curl's own output instead of replacing it, corrupting the diagnostic
# message to "000000" in exactly the "API unreachable" case. This probe
# exercises that path directly: a closed port, not a server-emitted error
# code.
#
# shellcheck disable=SC1091
source scripts/local/wait-for-api-ready.sh

# A genuinely closed port: bind an ephemeral port then release it
# immediately, so nothing is listening there for this probe.
closed_port="$(
  python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
)"

unreachable_code="$(_http_code "http://127.0.0.1:${closed_port}/auth/v1/health")"
check_str "unreachable API reports exactly '000' (not doubled to '000000')" "000" "$unreachable_code"

unreachable_code_with_headers="$(_http_code "http://127.0.0.1:${closed_port}/rest/v1/" -H "apikey: fake-key")"
check_str "unreachable API reports '000' with extra curl args too" "000" "$unreachable_code_with_headers"

echo ""
echo "assert-local-db.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
