# Paired down migrations

One-to-one reverses of the forward migrations in the sibling directory.
Addresses **INT-006** (no down migrations existed prior to this
convention landing).

## Convention

- Every forward `NNNN_<name>.sql` landed from 2026-04-23 onward **must**
  have a paired `NNNN_<name>.down.sql` here. The CI check in
  `.github/workflows/ci.yml` enforces this.
- Down migrations are applied **manually** for now — no tool runs them
  automatically. The convention exists so a rollback is a copy-paste
  away, not a whiteboard improvisation under production pressure.
- Down migrations for forward migrations **predating** this convention
  (0001–0010) are not retrofitted. Those are either too foundational to
  roll back (the app would break) or structurally irreversible (see
  below).

## Structurally irreversible migrations

These cannot be rolled back cleanly; the convention does not apply:

- **`0010_bottle_scan_enum.sql`** — `alter type added_via add value`.
  Postgres does not support removing enum values without a table
  rebuild. If a rollback is ever required, plan for downtime.

## Running a rollback

```bash
# Apply the down for a specific migration (manual, not part of the
# normal deploy pipeline):
psql $DATABASE_URL -f supabase/migrations/down/0018_reconcile_hardening.down.sql

# Or via the Supabase MCP `apply_migration` tool with the file
# contents as the query. Record the rollback in the council run
# history so the forward migration stays out of the applied state.
```

## Caveat: `create or replace` downs can go stale

If a forward migration uses `create or replace function` to replace an
earlier function's body (e.g., 0018 replaces 0016's
`reconcile_open_bottle`), its down migration has to restore the
*earlier* function body verbatim. If a future forward migration amends
the earlier body too (say, 0025 tweaks 0016's function), the 0018
down will now restore a stale version on rollback.

This isn't a bug, but it's a brittleness to watch for. When amending
an earlier function, audit every down migration that references it and
update their inline definitions to match.

## When adding a new migration

1. Write `supabase/migrations/NNNN_<name>.sql` as usual.
2. Write `supabase/migrations/down/NNNN_<name>.down.sql` at the same
   time. Think through the rollback *before* it's needed.
3. If the migration is structurally irreversible, still create the
   `.down.sql` file, and make its contents a single comment line
   explaining why (e.g., `-- Not reversible: adds enum value`).
4. Both files get committed together. CI rejects the PR if the down
   is missing.

## Why paired files instead of a migration tool (sqitch/dbmate/goose)

- Supabase's local stack uses its own migration runner; swapping to a
  third-party tool requires a migration-of-migrations.
- The Supabase CLI's `db push` respects `.sql` files in the up
  direction and is happy to ignore `down/` entirely. Our CI check
  fills the enforcement gap without a runtime dependency.
- We can revisit when/if we ever need automatic rollback in CI/CD.
  Today's need is "a rollback is one command away when pageable" —
  paired files meet that bar.
