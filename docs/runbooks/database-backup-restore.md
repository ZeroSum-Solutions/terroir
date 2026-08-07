# Database backup and restore runbook

This runbook is the operational gate for TER-002. The GitHub workflow creates
an encrypted PostgreSQL custom-format dump plus source evidence. A backup is
healthy only after the encrypted artifact, manifest, and checksum file upload
successfully. A release that includes a migration remains blocked unless the
latest backup is healthy and the most recent disposable restore drill passed.

The workflow never receives the decryption identity. Production connection
credentials and the offline age identity live only in ZS Vault. Never put a
database URL, password, or age identity in command arguments or logs.
The coverage gate includes every non-system, non-extension-owned schema that
owns a dumpable relation. Empty schemas are intentionally outside the gate
because PostgreSQL custom archives need not represent them.
The archive, source table counts, migration version, and ten content checksums
are all read from one exported PostgreSQL snapshot, so concurrent production
writes cannot create self-inconsistent evidence.

Remote libpq services use `sslmode=verify-full` and the repository-pinned
Supabase Root 2021 CA. The backup role disables PostgreSQL statement and
idle-in-transaction timeouts; the bounded 20-minute Actions job remains the
outer timeout and the exported-snapshot holder explicitly applies both settings.

## One-time provisioning

The production project is `qcfmwphlaekfkqwkfyth`. Reset the `postgres`
database password in the Supabase dashboard if the current value is unknown.
From the Connect panel, select the IPv4-compatible **session pooler** on port
5432 for database `postgres`—never the transaction pooler on port 6543—and
save that admin URL to ZS Vault as `terroir_supabase_admin_db_url`. GitHub-hosted
runners cannot safely assume access to the direct IPv6 endpoint. This reset
does not change Supabase API keys, but it must be recorded as a credential
rotation.

Create a dedicated read-only role. The helper sends the role password to
`psql` over stdin; it never places the password in process arguments.
The role has no write, create, replication, or ownership capability. It does
have `BYPASSRLS` because PostgreSQL otherwise refuses a complete `pg_dump` of
RLS-protected tenant tables; treat this credential as full read access.

```bash
umask 077
export PGSERVICEFILE="$TMPDIR/terroir-admin.pg_service.conf"
export PGSERVICE_NAME=terroir_admin
export PG_DATABASE_URL="$(zsvault get terroir_supabase_admin_db_url)"
node scripts/backup/write-pg-service.mjs
unset PG_DATABASE_URL

export BACKUP_ROLE_PASSWORD="$(openssl rand -base64 48)"
printf '%s' "$BACKUP_ROLE_PASSWORD" |
  zsvault add terroir_backup_db_password \
    --type plain_secret \
    --label "Terroir backup-only database role" \
    --env-name TERROIR_BACKUP_DB_PASSWORD \
    --yes \
    --value-stdin
PGSERVICE=terroir_admin node scripts/backup/provision-backup-role.mjs
unset BACKUP_ROLE_PASSWORD
rm -f "$PGSERVICEFILE"
unset PGSERVICEFILE PGSERVICE_NAME
```

Derive the backup role's session-pooler URL, save it to ZS Vault, and then set
GitHub from stdin. The helper rejects direct/transaction-pooler endpoints,
wrong project usernames, and short passwords. No URL is printed to the
terminal.

```bash
export SUPABASE_SESSION_POOLER_URL="$(
  zsvault get terroir_supabase_admin_db_url
)"
export BACKUP_ROLE_PASSWORD="$(zsvault get terroir_backup_db_password)"
node scripts/backup/create-backup-database-url.mjs |
  zsvault add terroir_supabase_backup_db_url \
    --type plain_secret \
    --label "Terroir backup role session-pooler URL" \
    --env-name TERROIR_BACKUP_DB_URL \
    --yes \
    --value-stdin
unset SUPABASE_SESSION_POOLER_URL BACKUP_ROLE_PASSWORD

zsvault get terroir_supabase_backup_db_url |
  gh secret set SUPABASE_DB_URL --repo wiggdevin/terroir
```

Generate a distinct offline age identity, save the private identity to ZS
Vault, and send only its public recipient to GitHub.

```bash
umask 077
identity_file="$TMPDIR/terroir-backup-age-identity.txt"
age-keygen -o "$identity_file"
age-keygen -y "$identity_file" > "$TMPDIR/terroir-backup-age-recipient.txt"
zsvault add terroir_backup_age_identity \
  --type plain_secret \
  --label "Terroir database backup age identity" \
  --env-name TERROIR_BACKUP_AGE_IDENTITY \
  --yes \
  --value-stdin < "$identity_file"
gh secret set BACKUP_AGE_RECIPIENT \
  --repo wiggdevin/terroir \
  < "$TMPDIR/terroir-backup-age-recipient.txt"
rm -f "$identity_file" "$TMPDIR/terroir-backup-age-recipient.txt"
```

Confirm the repository has both secret names. GitHub never returns values.

```bash
gh secret list --repo wiggdevin/terroir |
  grep -E '^(SUPABASE_DB_URL|BACKUP_AGE_RECIPIENT)[[:space:]]'
```

## Run and inspect a backup

Dispatch a manual run and watch the exact run to completion.

```bash
gh workflow run "DB Backup" --repo wiggdevin/terroir
run_id="$(
  gh run list \
    --repo wiggdevin/terroir \
    --workflow "DB Backup" \
    --event workflow_dispatch \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId'
)"
gh run watch "$run_id" --repo wiggdevin/terroir --exit-status
```

The workflow must report:

- a non-privileged role with `pg_read_all_data`;
- a non-empty custom dump containing table-data entries;
- successful age encryption;
- removal of every plaintext file before artifact upload; and
- one uploaded artifact retained for 90 days; and
- a matching SHA-256 anchor appended to the persistent GitHub issue named
  `Database backup integrity ledger`.

Do not download or expose the artifact during routine health checks. Record the
run URL. TER-002 requires three consecutive successful runs, including at
least one scheduled run.

## Disposable local restore drill

The only supported drill entrypoint is the fail-closed repository script. It
downloads and authenticates one successful run, verifies every encrypted and
plaintext digest with streaming reads, obtains the offline age identity from
ZS Vault without logging it, resets the exact local Supabase target, restores
authenticated data, compares evidence, and removes plaintext on every exit.

```bash
BACKUP_RUN_ID="<successful run id>" \
  scripts/backup/run-restore-drill.sh
```

The script requires Supabase CLI 2.112.0 or newer because older local runtime
images do not match the production-managed auth schema. It accepts only
`supabase_admin@127.0.0.1:54322/postgres`, verifies that account is the local
superuser, resets the canonical stack, and prepares only tables listed in the
authenticated source evidence. The narrow compatibility adjustment adds the
three production migration-metadata columns when needed and rejects conflicting
types. `pg_restore --data-only --disable-triggers` preserves all local
Supabase-owned DDL and global event triggers while `--exit-on-error` makes any
remaining runtime/schema mismatch fail the drill.

The detailed commands below document the evidence flow for incident review;
they are not a second supported procedure and must not be run independently.

Create a proof directory under `~/Inbox/notes/terroir-backup-drills/`. Keep
only the manifest, checksum file, authenticated GitHub run/artifact metadata,
integrity-ledger comments, and final redacted report there.
Decrypted database material stays under a mode-700 temporary directory and is
deleted at the end.

The repository's canonical local Supabase stack from TER-004 is a prerequisite.
Do not improvise a new `supabase/config.toml` or repair migration history during
this drill; if that stack is not green, TER-002 remains blocked at the restore
gate.

```bash
set -euo pipefail
run_id="<successful run id>"
proof_dir="$HOME/Inbox/notes/terroir-backup-drills/$(date -u +%Y%m%dT%H%M%SZ)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/terroir-restore.XXXXXX")"
chmod 700 "$work_dir"
cleanup_restore_drill() {
  supabase stop --no-backup >/dev/null 2>&1 || true
  if [ -n "${work_dir:-}" ] &&
     [[ "$work_dir" == "${TMPDIR:-/tmp}/terroir-restore."* ]]; then
    rm -rf "$work_dir"
  fi
}
trap cleanup_restore_drill EXIT HUP INT TERM
mkdir -p "$proof_dir"
gh run download "$run_id" \
  --repo wiggdevin/terroir \
  --dir "$work_dir/artifact"

encrypted_file="$(find "$work_dir/artifact" -name '*.tar.age' -type f -print -quit)"
manifest_file="$(find "$work_dir/artifact" -name '*.manifest.json' -type f -print -quit)"
checksums_file="$(find "$work_dir/artifact" -name '*.sha256' -type f -print -quit)"
test -n "$encrypted_file"
test -n "$manifest_file"
test -n "$checksums_file"
(cd "$(dirname "$checksums_file")" && sha256sum --check "$(basename "$checksums_file")")

BACKUP_MANIFEST_FILE="$manifest_file" \
BACKUP_ENCRYPTED_FILE="$encrypted_file" \
  node scripts/backup/verify-artifact.mjs
```

Before accepting the extracted files, also retain the authenticated GitHub
artifact metadata from the run. Actions v4 artifacts are immutable after
upload; the API record binds the artifact ID, digest, creator run, and effective
expiration. The workflow itself rejects retention shorter than 89 days and
writes the immutable digest to its step summary.

```bash
gh api "repos/wiggdevin/terroir/actions/runs/$run_id/artifacts" \
  > "$proof_dir/github-artifacts.json"
artifact_id="$(
  jq -er '.artifacts[] | select(.expired == false) | .id' \
    "$proof_dir/github-artifacts.json" |
    head -n 1
)"
artifact_digest="$(
  jq -er \
    --argjson artifact_id "$artifact_id" \
    '.artifacts[] | select(.id == $artifact_id) | .digest' \
    "$proof_dir/github-artifacts.json"
)"
[[ "$artifact_digest" =~ ^(sha256:)?[0-9a-f]{64}$ ]]

ledger_issue="$(
  gh issue list \
    --repo wiggdevin/terroir \
    --state all \
    --search '"Database backup integrity ledger" in:title' \
    --json number,title \
    --jq '.[] | select(.title == "Database backup integrity ledger") | .number' |
    head -n 1
)"
test -n "$ledger_issue"
gh api \
  "repos/wiggdevin/terroir/issues/$ledger_issue/comments" \
  --paginate \
  > "$proof_dir/integrity-ledger-comments.json"
jq -e \
  --arg artifact_id "$artifact_id" \
  --arg artifact_digest "$artifact_digest" \
  'any(.[];
    (.body | contains("Artifact ID: `" + $artifact_id + "`")) and
    (.body | contains("SHA-256: `" + $artifact_digest + "`"))
  )' \
  "$proof_dir/integrity-ledger-comments.json" > /dev/null
```

Decrypt with the offline identity, then verify every plaintext checksum bound
by the manifest.

```bash
identity_file="$work_dir/age-identity.txt"
zsvault get terroir_backup_age_identity > "$identity_file"
chmod 600 "$identity_file"
payload_file="$work_dir/backup.tar"
age --decrypt --identity "$identity_file" \
  --output "$payload_file" "$encrypted_file"
# The entrypoint requires exactly one safe *.dump member and one
# source-evidence.json member, then extracts each with tar -xOf. It never
# extracts arbitrary archive paths.
dump_file="$work_dir/<manifest-bound-dump-name>"
source_evidence="$work_dir/source-evidence.json"

BACKUP_MANIFEST_FILE="$manifest_file" \
BACKUP_ENCRYPTED_FILE="$encrypted_file" \
BACKUP_PAYLOAD_FILE="$payload_file" \
BACKUP_DUMP_FILE="$dump_file" \
BACKUP_EVIDENCE_FILE="$source_evidence" \
  node scripts/backup/verify-artifact.mjs
```

Start the repository's disposable local Supabase stack. The target guard
rejects every target except the exact privileged local service before the
authenticated inventory is truncated and data-only restore is allowed.

```bash
supabase start
supabase db reset
export PG_DATABASE_URL='postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres'
node scripts/backup/assert-disposable-target.mjs
export PGSERVICEFILE="$work_dir/restore.pg_service.conf"
export PGSERVICE_NAME=terroir_restore
node scripts/backup/write-pg-service.mjs

BACKUP_SOURCE_EVIDENCE_FILE="$source_evidence" \
  node scripts/backup/prepare-disposable-restore.mjs | \
  psql 'service=terroir_restore' -X -q -v ON_ERROR_STOP=1

pg_restore \
  --dbname=service=terroir_restore \
  --data-only \
  --disable-triggers \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "$dump_file"
```

Collect the restored table inventory, exact row counts, migration version, and
deterministic checksums for the ten largest non-empty tables. The comparison
fails on any missing table, count mismatch, migration mismatch, or checksum
mismatch.

```bash
restored_evidence="$work_dir/restored-evidence.json"
restore_report="$proof_dir/restore-report.json"
PGSERVICE=terroir_restore \
BACKUP_EVIDENCE_FILE="$restored_evidence" \
  node scripts/backup/collect-database-evidence.mjs

BACKUP_SOURCE_EVIDENCE_FILE="$source_evidence" \
BACKUP_RESTORED_EVIDENCE_FILE="$restored_evidence" \
BACKUP_RESTORE_REPORT_FILE="$restore_report" \
  node scripts/backup/compare-database-evidence.mjs
```

Copy only non-sensitive proof, record the GitHub run URL, and destroy the
disposable database plus every plaintext artifact.

```bash
cp "$manifest_file" "$checksums_file" "$proof_dir/"
gh run view "$run_id" \
  --repo wiggdevin/terroir \
  --json url,headSha,createdAt,conclusion \
  > "$proof_dir/github-run.json"
supabase stop --no-backup
rm -rf "$work_dir"
unset PG_DATABASE_URL PGSERVICEFILE PGSERVICE_NAME
```

Review `restore-report.json` before recording the drill as PASS. Its `ok` field
must be `true`, `failures` must be empty, and
`checked_content_checksums` must be ten unless production had fewer than ten
non-empty tables.

## Failure and rotation handling

- Missing configuration, a privileged or effectively writable backup role,
  incomplete schema coverage, an empty dump, encryption failure, upload
  failure, a missing integrity-ledger anchor, or restore mismatch is a hard
  failure.
- Never delete prior backup artifacts while repairing a run.
- If the backup role credential is exposed, rotate only that role password,
  replace `SUPABASE_DB_URL`, and run a new backup. The role can read across RLS
  boundaries even though it cannot mutate data.
- If the age identity is exposed, generate a new identity and recipient. Keep
  the old identity offline until every retained artifact encrypted to it has
  expired or been intentionally re-encrypted.
- A failed scheduled run blocks schema promotion until a new successful backup
  and, when required by the release gate, a restore drill are complete.
