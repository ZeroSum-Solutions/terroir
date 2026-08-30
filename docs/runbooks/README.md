# Runbooks

Operational procedures. Each was verified against the tree on 2026-08-29.

| Runbook | Use it when | Status |
|---|---|---|
| [`local-stack.md`](local-stack.md) | Bringing up local Supabase — required before the live-DB test suites will run | Verified: `scripts/local/dev-stack.sh`, `assert-local-db.sh`, `seed-local.mjs` all exist |
| [`csv-import.md`](csv-import.md) | Working on CSV / Excel / drag-drop import, or on wine deletion | Verified; most actively maintained runbook. **Read §RLS before touching wine deletion** — it documents the open `stock_adjustments` / `bottle_closeouts` ownership gap and its TOCTOU race |
| [`invoice-extract-worker.md`](invoice-extract-worker.md) | Operating or debugging the background worker | Verified: migrations `0052`, `0074`, `0075`, `src/worker/index.ts`, `pnpm run worker` |
| [`database-backup-restore.md`](database-backup-restore.md) | Backup and restore operations | Verified: every referenced script under `scripts/backup/` exists |
| [`migration-numbering.md`](migration-numbering.md) | Before picking a migration number on a branch | Verified. Historical incident record — two branches once both claimed `0046`/`0049` |

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
