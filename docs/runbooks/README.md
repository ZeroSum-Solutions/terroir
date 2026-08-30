# Runbooks

Operational procedures. Each was verified against the tree on 2026-08-29.

| Runbook | Use it when | Status |
|---|---|---|
| [`local-stack.md`](local-stack.md) | Bringing up local Supabase — required before the live-DB test suites will run | Verified: `scripts/local/dev-stack.sh`, `assert-local-db.sh`, `seed-local.mjs` all exist |
| [`csv-import.md`](csv-import.md) | Working on CSV / Excel / drag-drop import, or on wine deletion | Verified; most actively maintained runbook. **Its §RLS is now partly stale:** the `stock_adjustments` / `bottle_closeouts` ownership gap it describes as unfixed was closed by migration `0136` (2026-08-29) and is live in production. The app-layer sweep and its TOCTOU race still exist and are now redundant defence rather than the only guard |
| [`invoice-extract-worker.md`](invoice-extract-worker.md) | Operating or debugging the background worker | Verified: migrations `0052`, `0074`, `0075`, `src/worker/index.ts`, `pnpm run worker` |
| [`database-backup-restore.md`](database-backup-restore.md) | Backup and restore operations | Verified: every referenced script under `scripts/backup/` exists |
| [`migration-numbering.md`](migration-numbering.md) | Before picking a migration number on a branch | Verified. Historical incident record — two branches once both claimed `0046`/`0049` |
| [`production-migrations.md`](production-migrations.md) | Applying migrations to production — **there is no automated path; a merge to `main` deploys code only** | Written 2026-08-29 after production was found at `0111` while the repo was at `0136` |

## Known drift

Production's `wine-images` bucket allows `image/heic` and `image/heif`; migration
`0130` declares only jpeg/png/webp. The bucket predates the migration — it was made by
hand, and `0130` was written to declare what already existed but under-specified the
mime list. A fresh environment built from migrations will therefore **reject HEIC
uploads that production accepts**. Needs a forward migration; do not edit `0130`, which
is now applied.

## Known unresolved contradiction

`docs/RESTORE-DRILL.md` records a restore drill **passing** on 2026-08-22 (60 tables
matched, checksums matched, migration version `20260820042618`).
[`database-backup-restore.md`](database-backup-restore.md) — written six days later,
commit `0e5ae11`, titled *"admit it has never been run"* — states flatly that no
restore drill has ever been recorded.

**Both cannot be true.** This needs an owner decision, not a doc patch: either the
2026-08-22 record is real and belongs in the backup runbook, or it should be
retracted. Until then, treat restore capability as **unproven**.

`RESTORE-DRILL.md` additionally claims `supabase/config.toml` does not exist in the
repo. It does, and [`local-stack.md`](local-stack.md) documents it.
