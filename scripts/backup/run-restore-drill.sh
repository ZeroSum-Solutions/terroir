#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo="wiggdevin/terroir"
run_id="${BACKUP_RUN_ID:-}"
target_url="${PG_DATABASE_URL:-postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres}"
proof_root="$HOME/Inbox/notes/terroir-backup-drills"
requested_proof_dir="${BACKUP_PROOF_DIR:-$proof_root/$(date -u +%Y%m%dT%H%M%SZ)}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/terroir-restore.XXXXXX")"
stack_started=false

cleanup() {
  if [ "$stack_started" = true ]; then
    supabase stop --no-backup >/dev/null 2>&1 || true
  fi
  if [[ "$work_dir" == "${TMPDIR:-/tmp}/terroir-restore."* ]]; then
    rm -rf "$work_dir"
  fi
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'Restore drill failed: %s\n' "$1" >&2
  exit 1
}

find_one() {
  local pattern="$1"
  local -a matches=()
  while IFS= read -r match; do
    matches+=("$match")
  done < <(find "$work_dir/artifact" -type f -name "$pattern" -print)
  [ "${#matches[@]}" -eq 1 ] || fail "expected exactly one $pattern artifact"
  [ ! -L "${matches[0]}" ] || fail "artifact files must not be symbolic links"
  printf '%s\n' "${matches[0]}"
}

[[ "$run_id" =~ ^[0-9]+$ ]] || fail "BACKUP_RUN_ID must be a numeric successful workflow run ID"
case "$requested_proof_dir" in
  "$proof_root"/*) proof_name="${requested_proof_dir#"$proof_root"/}" ;;
  *) fail "BACKUP_PROOF_DIR must be below $proof_root" ;;
esac
[[ "$proof_name" =~ ^[A-Za-z0-9._-]+$ && "$proof_name" != "." && "$proof_name" != ".." ]] || \
  fail "BACKUP_PROOF_DIR must be one safe directory below the proof root"
mkdir -p "$proof_root" "$work_dir/artifact"
proof_root="$(cd "$proof_root" && pwd -P)"
mkdir -p "$proof_root/$proof_name"
proof_dir="$(cd "$proof_root/$proof_name" && pwd -P)"
case "$proof_dir" in
  "$proof_root"/*) ;;
  *) fail "BACKUP_PROOF_DIR must resolve below $proof_root" ;;
esac
chmod 700 "$proof_dir" "$work_dir"

PG_DATABASE_URL="$target_url" node scripts/backup/assert-disposable-target.mjs
supabase_version="$(supabase --version)"
SUPABASE_CLI_VERSION="$supabase_version" \
  node scripts/backup/assert-supabase-cli-version.mjs

gh run view "$run_id" --repo "$repo" \
  --json url,headSha,createdAt,conclusion > "$proof_dir/github-run.json"
jq -e '.conclusion == "success"' "$proof_dir/github-run.json" >/dev/null || \
  fail "the selected backup run was not successful"
gh run download "$run_id" --repo "$repo" --dir "$work_dir/artifact"

encrypted_file="$(find_one '*.tar.age')"
manifest_file="$(find_one '*.manifest.json')"
checksums_file="$(find_one '*.sha256')"
BACKUP_CHECKSUMS_FILE="$checksums_file" \
BACKUP_ENCRYPTED_FILE="$encrypted_file" \
BACKUP_MANIFEST_FILE="$manifest_file" \
  node scripts/backup/verify-checksum-file.mjs
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$checksums_file")" && sha256sum --check "$(basename "$checksums_file")")
else
  (cd "$(dirname "$checksums_file")" && shasum -a 256 --check "$(basename "$checksums_file")")
fi
BACKUP_MANIFEST_FILE="$manifest_file" \
BACKUP_ENCRYPTED_FILE="$encrypted_file" \
  node scripts/backup/verify-artifact.mjs
jq -e --arg run_id "$run_id" \
  '.source.github_run_id == $run_id' "$manifest_file" >/dev/null || \
  fail "manifest provenance does not match BACKUP_RUN_ID"

gh api "repos/$repo/actions/runs/$run_id/artifacts" \
  > "$proof_dir/github-artifacts.json"
artifact_count="$(jq '[.artifacts[] | select(.expired == false)] | length' "$proof_dir/github-artifacts.json")"
[ "$artifact_count" -eq 1 ] || fail "expected exactly one unexpired artifact for the run"
artifact_id="$(jq -er '.artifacts[] | select(.expired == false) | .id' "$proof_dir/github-artifacts.json")"
artifact_digest="$(jq -er '.artifacts[] | select(.expired == false) | .digest' "$proof_dir/github-artifacts.json")"
[[ "$artifact_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "artifact API digest is invalid"

ledger_issue="$(gh issue list --repo "$repo" --state all \
  --search '"Database backup integrity ledger" in:title' \
  --json number,title \
  --jq '.[] | select(.title == "Database backup integrity ledger") | .number' | head -n 1)"
[ -n "$ledger_issue" ] || fail "integrity ledger issue was not found"
gh api "repos/$repo/issues/$ledger_issue/comments" --paginate \
  > "$proof_dir/integrity-ledger-comments.json"
jq -e --arg artifact_id "$artifact_id" --arg artifact_digest "$artifact_digest" \
  'any(.[]; (.body | contains("Artifact ID: `" + $artifact_id + "`")) and (.body | contains("SHA-256: `" + $artifact_digest + "`")))' \
  "$proof_dir/integrity-ledger-comments.json" >/dev/null || \
  fail "artifact digest is not anchored in the integrity ledger"

identity_file="$work_dir/age-identity.txt"
zsvault get terroir_backup_age_identity > "$identity_file"
[ -s "$identity_file" ] || fail "backup age identity is unavailable"
chmod 600 "$identity_file"
payload_file="$work_dir/backup.tar"
age --decrypt --identity "$identity_file" --output "$payload_file" "$encrypted_file"

payload_members=()
while IFS= read -r member; do
  payload_members+=("$member")
done < <(tar -tf "$payload_file")
[ "${#payload_members[@]}" -eq 2 ] || fail "backup payload must contain exactly two files"
dump_member=""
evidence_member=""
for member in "${payload_members[@]}"; do
  [[ "$member" != */* && "$member" != .* && "$member" != -* && "$member" != *..* ]] || \
    fail "backup payload contains an unsafe member name"
  case "$member" in
    *.dump) [ -z "$dump_member" ] || fail "backup payload contains multiple dumps"; dump_member="$member" ;;
    source-evidence.json) evidence_member="$member" ;;
    *) fail "backup payload contains an unexpected member" ;;
  esac
done
[ -n "$dump_member" ] && [ -n "$evidence_member" ] || \
  fail "backup payload is missing dump or source evidence"
dump_file="$work_dir/$dump_member"
source_evidence="$work_dir/$evidence_member"
tar -xOf "$payload_file" -- "$dump_member" > "$dump_file"
tar -xOf "$payload_file" -- "$evidence_member" > "$source_evidence"
BACKUP_MANIFEST_FILE="$manifest_file" \
BACKUP_ENCRYPTED_FILE="$encrypted_file" \
BACKUP_PAYLOAD_FILE="$payload_file" \
BACKUP_DUMP_FILE="$dump_file" \
BACKUP_EVIDENCE_FILE="$source_evidence" \
  node scripts/backup/verify-artifact.mjs

printf 'Starting the disposable Supabase stack (status output suppressed).\n'
if ! supabase start > "$work_dir/supabase-start.log" 2>&1; then
  fail "supabase start failed; output was suppressed because it can contain local credentials"
fi
stack_started=true
printf 'Resetting the disposable Supabase database.\n'
if ! supabase db reset > "$work_dir/supabase-reset.log" 2>&1; then
  fail "supabase db reset failed; output was suppressed because it can contain local credentials"
fi
PG_DATABASE_URL="$target_url" node scripts/backup/assert-disposable-target.mjs
export PGSERVICEFILE="$work_dir/restore.pg_service.conf"
export PGSERVICE_NAME=terroir_restore
export PG_DATABASE_URL="$target_url"
node scripts/backup/write-pg-service.mjs
unset PG_DATABASE_URL
restore_identity="$(psql 'service=terroir_restore' -X -A -t -v ON_ERROR_STOP=1 \
  -c "select current_user || '|' || rolsuper::text from pg_catalog.pg_roles where rolname = current_user")"
[ "$restore_identity" = "supabase_admin|true" ] || \
  fail "restore target must authenticate as local supabase_admin"
BACKUP_SOURCE_EVIDENCE_FILE="$source_evidence" \
  node scripts/backup/prepare-disposable-restore.mjs | \
  psql 'service=terroir_restore' -X -q -v ON_ERROR_STOP=1
archive_list="$work_dir/archive.list"
restore_use_list="$work_dir/restore.use-list"
pg_restore --list "$dump_file" > "$archive_list"
BACKUP_ARCHIVE_LIST_FILE="$archive_list" \
BACKUP_SOURCE_EVIDENCE_FILE="$source_evidence" \
BACKUP_RESTORE_USE_LIST_FILE="$restore_use_list" \
  node scripts/backup/create-restore-use-list.mjs
pg_restore --dbname=service=terroir_restore \
  --data-only \
  --disable-triggers \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --use-list="$restore_use_list" \
  "$dump_file"

restored_evidence="$work_dir/restored-evidence.json"
restore_report="$proof_dir/restore-report.json"
PGSERVICE=terroir_restore \
BACKUP_CHECKSUM_SOURCE_FILE="$source_evidence" \
BACKUP_EVIDENCE_FILE="$restored_evidence" \
  node scripts/backup/collect-database-evidence.mjs
BACKUP_SOURCE_EVIDENCE_FILE="$source_evidence" \
BACKUP_RESTORED_EVIDENCE_FILE="$restored_evidence" \
BACKUP_RESTORE_REPORT_FILE="$restore_report" \
  node scripts/backup/compare-database-evidence.mjs
BACKUP_SOURCE_EVIDENCE_FILE="$source_evidence" \
BACKUP_RESTORE_REPORT_FILE="$restore_report" \
  node scripts/backup/assert-restore-report.mjs
jq -n --arg supabase_cli "$supabase_version" --arg run_id "$run_id" '{
  format_version: 1,
  run_id: $run_id,
  supabase_cli_version: $supabase_cli,
  restore_mode: "data-only",
  target: "canonical-local-supabase",
  platform_ddl_preserved: true
}' > "$proof_dir/restore-method.json"
BACKUP_RUN_ID="$run_id" \
BACKUP_GITHUB_RUN_FILE="$proof_dir/github-run.json" \
BACKUP_GITHUB_ARTIFACTS_FILE="$proof_dir/github-artifacts.json" \
BACKUP_SOURCE_EVIDENCE_FILE="$source_evidence" \
BACKUP_RESTORE_REPORT_FILE="$restore_report" \
BACKUP_RELEASE_PROOF_FILE="$proof_dir/release-proof.json" \
  node scripts/backup/create-restore-release-proof.mjs

cp "$manifest_file" "$checksums_file" "$proof_dir/"
printf 'Restore drill PASS for run %s\n' "$run_id"
