import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_BACKUP_AGE_MS = 30 * 60 * 60 * 1000;

function parseTime(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} timestamp is invalid.`);
  return time;
}

export function assertReleaseBackupHealth({
  latestBackup,
  artifacts,
  proof,
  expectedRunId,
  now = new Date().toISOString(),
}) {
  if (
    latestBackup?.status !== "completed" ||
    latestBackup.conclusion !== "success"
  ) {
    throw new Error("The latest DB Backup run is not successful.");
  }
  if (
    latestBackup.head_branch !== "main" ||
    !/^[0-9a-f]{40}$/u.test(latestBackup.head_sha ?? "")
  ) {
    throw new Error("The latest DB Backup run is not a valid main run.");
  }
  const runId = String(latestBackup.id);
  if (!/^\d+$/u.test(expectedRunId) || runId !== expectedRunId) {
    throw new Error("The requested backup is not the latest DB Backup run.");
  }
  const nowTime = parseTime(now, "Current");
  const backupTime = parseTime(latestBackup.created_at, "Backup");
  if (backupTime > nowTime || nowTime - backupTime > MAX_BACKUP_AGE_MS) {
    throw new Error("The latest DB Backup run is stale.");
  }
  if (
    proof?.format_version !== 1 ||
    proof.backup_run_id !== runId ||
    proof.backup_head_sha !== latestBackup.head_sha
  ) {
    throw new Error("Restore proof is not bound to the latest DB Backup run.");
  }
  const verifiedTime = parseTime(proof.verified_at, "Restore proof");
  if (verifiedTime < backupTime || verifiedTime > nowTime) {
    throw new Error("Restore proof timestamp is outside the backup window.");
  }

  const unexpired = artifacts?.artifacts?.filter(
    ({ expired }) => expired === false,
  );
  if (unexpired?.length !== 1) {
    throw new Error("The latest DB Backup run lacks one unexpired artifact.");
  }
  const artifact = unexpired[0];
  if (
    String(artifact.id) !== proof.backup_artifact_id ||
    artifact.digest !== proof.backup_artifact_digest
  ) {
    throw new Error("Restore proof artifact digest does not match GitHub.");
  }
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(proof.backup_artifact_digest ?? "") ||
    !/^[0-9a-f]{64}$/u.test(proof.restore_report_sha256 ?? "")
  ) {
    throw new Error("Restore proof digests are invalid.");
  }
  if (
    proof.restore_ok !== true ||
    proof.restore_failure_count !== 0 ||
    !Number.isSafeInteger(proof.source_table_count) ||
    proof.source_table_count < 1 ||
    !Number.isSafeInteger(proof.source_non_empty_table_count) ||
    proof.source_non_empty_table_count < 1 ||
    proof.source_non_empty_table_count > proof.source_table_count ||
    !Number.isSafeInteger(proof.restored_table_count) ||
    proof.restored_table_count < proof.source_table_count ||
    typeof proof.migration_version !== "string" ||
    proof.migration_version.length === 0
  ) {
    throw new Error("Restore proof does not record a successful complete restore.");
  }
  if (
    !Number.isSafeInteger(proof.required_content_checksums) ||
    proof.required_content_checksums < 1 ||
    proof.required_content_checksums > 10 ||
    proof.required_content_checksums !==
      Math.min(10, proof.source_non_empty_table_count) ||
    proof.checked_content_checksums !== proof.required_content_checksums
  ) {
    throw new Error("Restore proof checksum coverage is incomplete.");
  }
}

function main() {
  const latestRunFile = process.env.BACKUP_LATEST_RUN_FILE;
  const artifactsFile = process.env.BACKUP_ARTIFACTS_FILE;
  const proofFile = process.env.BACKUP_RELEASE_PROOF_FILE;
  const expectedRunId = process.env.BACKUP_EXPECTED_RUN_ID;
  if (!latestRunFile || !artifactsFile || !proofFile || !expectedRunId) {
    throw new Error("Database release gate file inputs are required.");
  }
  const runs = JSON.parse(readFileSync(latestRunFile, "utf8"));
  if (!Array.isArray(runs.workflow_runs) || runs.workflow_runs.length !== 1) {
    throw new Error("GitHub did not return exactly one latest DB Backup run.");
  }
  assertReleaseBackupHealth({
    latestBackup: runs.workflow_runs[0],
    artifacts: JSON.parse(readFileSync(artifactsFile, "utf8")),
    proof: JSON.parse(readFileSync(proofFile, "utf8")),
    expectedRunId,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
