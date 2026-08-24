#!/usr/bin/env bash
# scripts/audit/psql.sh
#
# Wrapper that runs psql against THIS worktree's isolated audit Supabase
# stack (project_id "terroir-audit-local", DB on 127.0.0.1:58322) — never
# any other local stack, and never a hosted/production database.
#
# Usage:
#   scripts/audit/psql.sh -c "select count(*) from public.wines;"
#   scripts/audit/psql.sh <<'SQL'
#   select * from public.restaurants;
#   SQL
#
# All arguments are passed through to psql unchanged.

set -euo pipefail

AUDIT_DB_URL="postgresql://postgres:postgres@127.0.0.1:58322/postgres"

exec psql "$AUDIT_DB_URL" "$@"
