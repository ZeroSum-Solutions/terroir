#!/usr/bin/env bash
# scripts/local/assert-local-db.test.sh
#
# Probe matrix for scripts/local/assert-local-db.sh's port-scoping guard.
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

echo ""
echo "assert-local-db.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
