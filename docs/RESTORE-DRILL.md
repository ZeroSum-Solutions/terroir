# Database restore drill

This is the execution guide for `scripts/restore-drill.mjs`, the automated
counterpart to the manual walkthrough in
`docs/runbooks/database-backup-restore.md`. It proves that a specific DB
Backup artifact actually restores: it verifies the artifact, decrypts it
offline, restores it into a throwaway PostgreSQL container, and diffs exact
per-table row counts (plus migration version and content checksums) against
the evidence captured at dump time. Nothing here ever touches production or
the backup role's connection — the restore target is always a Docker
container the script starts and destroys on loopback only.

## What the workflow now asserts (before running a drill)

`.github/workflows/db-backup.yml` calls `scripts/backup/assert-dump-coverage.mjs`
on every backup run, before the dump is encrypted and uploaded. That script now
checks two things, both against the same exported PostgreSQL snapshot the dump
itself was taken from:

- **Schema coverage** (pre-existing): every non-system, non-extension-owned
  schema present in the source also appears in the archive.
- **Table coverage** (new in this slice): every non-system, non-extension-owned
  base table present in the source has a `TABLE DATA` entry in the archive —
  not just an aggregate "more than zero table-data entries" count. A single
  table silently dropped from the dump (a privilege change, a `pg_dump`
  filtering bug, a bad flag) now fails the backup run by name instead of
  hiding inside an otherwise-healthy-looking artifact.

The exact per-table row counts themselves (`SELECT count(*)`, never
`pg_stat`'s estimated `n_live_tup`) are captured by
`scripts/backup/collect-database-evidence.mjs` into `source-evidence.json`,
taken from the same snapshot as the dump and shipped alongside it inside the
same encrypted `.tar.age` payload. `scripts/restore-drill.mjs` is what proves
those counts actually come back out on the other side of a restore.

## Prerequisites

- `docker` running locally (`docker info` succeeds).
- `age`, `gh`, and Node.js on `PATH`.
- ZS Vault access to `terroir_backup_age_identity` (the identity that
  decrypts `BACKUP_AGE_RECIPIENT`-encrypted artifacts).
- A downloaded DB Backup artifact directory (see below).

The scratch database is a disposable
`public.ecr.aws/supabase/postgres:17.6.1.143` container (Supabase's own
Postgres 17 image, not vanilla `postgres:17`) started fresh by the script and
torn down when it exits. The vanilla `postgres` image does **not** work here:
the dump's schema needs `pg_cron`, `pgsodium`/`vault`, and `pg_graphql`
extension control files that only Supabase's image ships. This repository has
no committed `supabase/config.toml` yet (see `docs/LOCAL-SUPABASE.md` for the
seed-data-only local stack that does exist), so the canonical local Supabase
CLI restore path documented in `docs/runbooks/database-backup-restore.md`
(port `54322`) is currently unavailable in a general dev environment and can
also collide with an unrelated project's Supabase stack already listening on
that port. `scripts/restore-drill.mjs` sidesteps both problems by managing its
own container end to end rather than depending on `supabase start`.

## Running the drill

1. Find the latest successful run and download its artifact:

   ```bash
   run_id="$(
     gh run list --repo wiggdevin/terroir --workflow "DB Backup" \
       --json databaseId,conclusion --jq \
       '[.[] | select(.conclusion == "success")][0].databaseId'
   )"
   gh run download "$run_id" --repo wiggdevin/terroir --dir /path/to/artifact-dir
   ```

2. Fetch the offline age identity to a private file (never inline it in an
   env var value or command argument):

   ```bash
   umask 077
   zsvault get terroir_backup_age_identity > /path/to/identity.txt
   chmod 600 /path/to/identity.txt
   ```

3. Run the drill:

   ```bash
   RESTORE_ARTIFACT_DIR=/path/to/artifact-dir \
   RESTORE_AGE_IDENTITY_FILE=/path/to/identity.txt \
   RESTORE_REPORT_FILE=/path/to/restore-report.json \
     node scripts/restore-drill.mjs
   ```

4. Delete the identity file and artifact directory when done. The script
   itself cleans up its own decrypted work directory and scratch container
   automatically (`RESTORE_KEEP_WORKDIR=1` skips that, for debugging only).

The script exits non-zero and prints every failure if any table is missing,
any row count differs, the migration version differs, or any of the ten
largest tables' content checksums differ. On success it prints a
`schema.table | source | restored | match` table and writes a JSON report
(`format_version`, `ok`, `failures`, `tables`, `sequences`,
`content_checksums`).

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `RESTORE_ARTIFACT_DIR` | yes | Directory containing one `*.tar.age`, `*.manifest.json`, and `*.sha256` (searched recursively, so a raw `gh run download` directory works as-is). |
| `RESTORE_AGE_IDENTITY_FILE` | yes | Path to the offline age identity file. |
| `RESTORE_DOCKER_IMAGE` | no | Overrides the scratch Postgres image. Must be a Supabase-flavored image matching the dump's PostgreSQL major version. |
| `RESTORE_REPORT_FILE` | no | Where to write the JSON comparison report. Defaults to a file inside the (deleted-on-exit) work directory. |
| `RESTORE_KEEP_WORKDIR` | no | Set to `1` to keep the decrypted material and scratch container after a run, for debugging. |

## Drill record: 2026-08-22

Executed against the latest green scheduled run at the time
(`32557316027`, `2026-08-22T06:34:18Z`, commit `beeb2d4`). Checksums in the
`.sha256` file verified, the manifest matched the encrypted artifact,
decryption with `terroir_backup_age_identity` succeeded, and the dump
restored cleanly into a disposable `public.ecr.aws/supabase/postgres:17.6.1.143`
container on loopback-only port. The comparison result was **PASS** — 60
tables checked, all exact row counts matched, the migration version
(`20260820042618`) matched, and all ten largest-table content checksums
matched.

One finding: `terroir_restore_drill_age_identity` (the second identity
credential provisioned for this slice) does **not** decrypt artifacts
produced by the current `BACKUP_AGE_RECIPIENT` — only
`terroir_backup_age_identity` does. This drill used
`terroir_backup_age_identity`, matching `docs/runbooks/database-backup-restore.md`.
If `terroir_restore_drill_age_identity` is meant to become the drill-specific
identity going forward, the workflow's `BACKUP_AGE_RECIPIENT` secret needs to
be rotated to its matching recipient first — until then it is not a usable
decryption key for any existing backup artifact.

### Per-table counts, source vs. restored

| Table | Source | Restored | Match |
| --- | ---: | ---: | :---: |
| auth.audit_log_entries | 0 | 0 | OK |
| auth.custom_oauth_providers | 0 | 0 | OK |
| auth.flow_state | 20 | 20 | OK |
| auth.identities | 3 | 3 | OK |
| auth.instances | 0 | 0 | OK |
| auth.mfa_amr_claims | 195 | 195 | OK |
| auth.mfa_challenges | 0 | 0 | OK |
| auth.mfa_factors | 0 | 0 | OK |
| auth.oauth_authorizations | 0 | 0 | OK |
| auth.oauth_client_states | 0 | 0 | OK |
| auth.oauth_clients | 0 | 0 | OK |
| auth.oauth_consents | 0 | 0 | OK |
| auth.one_time_tokens | 0 | 0 | OK |
| auth.refresh_tokens | 270 | 270 | OK |
| auth.saml_providers | 0 | 0 | OK |
| auth.saml_relay_states | 0 | 0 | OK |
| auth.schema_migrations | 77 | 77 | OK |
| auth.sessions | 195 | 195 | OK |
| auth.sso_domains | 0 | 0 | OK |
| auth.sso_providers | 0 | 0 | OK |
| auth.users | 3 | 3 | OK |
| auth.webauthn_challenges | 0 | 0 | OK |
| auth.webauthn_credentials | 0 | 0 | OK |
| public.availability_events | 10 | 10 | OK |
| public.background_jobs | 0 | 0 | OK |
| public.bins | 40 | 40 | OK |
| public.bottle_closeouts | 0 | 0 | OK |
| public.brand_kits | 0 | 0 | OK |
| public.cellar_config | 1 | 1 | OK |
| public.cellar_health | 41 | 41 | OK |
| public.inventory_items | 56 | 56 | OK |
| public.invitations | 0 | 0 | OK |
| public.invoice_scans | 6 | 6 | OK |
| public.lwin_catalog | 211498 | 211498 | OK |
| public.memberships | 4 | 4 | OK |
| public.open_bottles | 12 | 12 | OK |
| public.pour_events | 75 | 75 | OK |
| public.pricing_recommendations | 41 | 41 | OK |
| public.reason_codes | 28 | 28 | OK |
| public.reconcile_actions | 0 | 0 | OK |
| public.reconcile_batches | 0 | 0 | OK |
| public.restaurants | 4 | 4 | OK |
| public.scan_idempotency | 2 | 2 | OK |
| public.stock_adjustments | 0 | 0 | OK |
| public.wine_lineages | 148 | 148 | OK |
| public.wine_list_items | 56 | 56 | OK |
| public.wine_list_sections | 27 | 27 | OK |
| public.wine_lists | 6 | 6 | OK |
| public.wines | 60 | 60 | OK |
| realtime.schema_migrations | 69 | 69 | OK |
| realtime.subscription | 0 | 0 | OK |
| storage.buckets | 1 | 1 | OK |
| storage.buckets_analytics | 0 | 0 | OK |
| storage.buckets_vectors | 0 | 0 | OK |
| storage.migrations | 61 | 61 | OK |
| storage.objects | 1 | 1 | OK |
| storage.s3_multipart_uploads | 0 | 0 | OK |
| storage.s3_multipart_uploads_parts | 0 | 0 | OK |
| storage.vector_indexes | 0 | 0 | OK |
| supabase_migrations.schema_migrations | 40 | 40 | OK |

Sequences (`last_value`/`is_called`) and the ten largest non-empty tables'
SHA-256 content checksums also matched exactly; see the full JSON report from
this run for the checksum values (not reproduced here since they are not
useful without the underlying row bytes).

Note the 26 `public` schema tables here (plus 34 Supabase-managed
`auth`/`realtime`/`storage`/`supabase_migrations` tables, 60 total) — not the
16 originally assumed for this slice. `assert-dump-coverage.mjs`'s table
coverage check is schema-driven and table-count-agnostic by design, so it
does not need updating as the schema grows.
