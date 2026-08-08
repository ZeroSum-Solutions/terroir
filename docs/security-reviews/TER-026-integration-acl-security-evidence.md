# TER-026 integrated ACL correction security evidence

Review environment: integrated worktree, Node 24.16.0, pnpm 10.33.2, and the
isolated local Supabase PostgreSQL harness. Review base: `e6b93db`. Source fix:
`9b7528b`.

CMD-001 captures `git diff --name-only e6b93db...HEAD` after the evidence commit
and accounts for every path in the structured report.

CMD-002 runs `gitleaks detect --source . --no-banner --redact --log-opts
e6b93db..HEAD` across the final committed correction range.

CMD-003 first removed the unsafe ad hoc global table grant and restored the
fresh Supabase CLI restricted ACL shape. Applying the pre-fix 0081 migration
then made `supabase/tests/0081_atomic_wine_metadata_overrides.sql` fail at the
staff direct UPDATE with `permission denied for table wines`; PostgreSQL's hint
named the missing SELECT and UPDATE privileges.

After the narrow migration fix, CMD-003 reapplied 0081 and ran both 0081 and
0082 SQL acceptances successfully. The 0081 fixture now asserts authenticated
SELECT and UPDATE on `public.wines`, no anonymous UPDATE, manager success,
manual-value preservation, staff RPC denial, staff direct UPDATE zero rows,
cross-tenant zero rows, and function execute privileges.

CMD-004 applied 0082 down, then 0081 down, reapplied 0081 and 0082 in order,
and reran both SQL acceptances successfully. The 0081 down deliberately keeps
the minimum table privileges, manager-only UPDATE policy, and hardened batch
RPC because they are security corrections.

CMD-005 captured the post-fix table privilege matrix. Authenticated has SELECT
and UPDATE on `wines`; it has no SELECT, INSERT, UPDATE, or DELETE on
`api_idempotency`, `open_bottles`, or `pour_events`; the existing explicit
SELECT grant on `background_jobs` remains. Anonymous has no wine UPDATE.

No prompt, model, retrieval, credential, download, telemetry, or external
export changed. The correction exposes only the minimum table operations that
the existing tenant SELECT policy and new manager-only UPDATE policy govern.
