import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_BACKUP_AGE_MS = 30 * 60 * 60 * 1000;
const REQUIRED_BACKUP_HISTORY = 3;

function parseTime(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} timestamp is invalid.`);
  return time;
}

function completedBackupsByRecency(backupRuns) {
  if (!Array.isArray(backupRuns)) {
    throw new Error("GitHub did not return DB Backup workflow runs.");
  }
  return backupRuns
    .filter(({ status }) => status === "completed")
    .map((run) => ({
      run,
      createdTime: parseTime(run.created_at, "Backup"),
    }))
    .sort(
      (left, right) =>
        right.createdTime - left.createdTime || Number(right.run.id) - Number(left.run.id),
    )
    .map(({ run }) => run);
}

function oneUnexpiredArtifact(artifacts, label) {
  const unexpired = artifacts?.artifacts?.filter(
    ({ expired }) => expired === false,
  );
  if (unexpired?.length !== 1) {
    throw new Error(`${label} lacks one unexpired artifact.`);
  }
  return unexpired[0];
}

export function assertReleaseBackupHealth({
  backupRuns,
  artifacts,
  restoreRun,
  restoreArtifacts,
  proof,
  restoreReportBytes,
  expectedRunId,
  expectedRestoreRunId,
  expectedCandidateSha,
  expectedTrustedWorkflowSha,
  now = new Date().toISOString(),
}) {
  if (
    !/^\d+$/u.test(expectedRunId ?? "") ||
    !/^\d+$/u.test(expectedRestoreRunId ?? "") ||
    !/^[0-9a-f]{40}$/u.test(expectedCandidateSha ?? "") ||
    !/^[0-9a-f]{40}$/u.test(expectedTrustedWorkflowSha ?? "")
  ) {
    throw new Error("Database release gate identities are invalid.");
  }

  const completedBackups = completedBackupsByRecency(backupRuns);
  const latestBackup = completedBackups[0];
  if (!latestBackup || latestBackup.conclusion !== "success") {
    throw new Error("The latest DB Backup run is not successful.");
  }
  const recentBackups = completedBackups.slice(0, REQUIRED_BACKUP_HISTORY);
  if (
    recentBackups.length !== REQUIRED_BACKUP_HISTORY ||
    recentBackups.some(({ conclusion }) => conclusion !== "success") ||
    !recentBackups.some(({ event }) => event === "schedule")
  ) {
    throw new Error(
      "Release requires three successful backups including a scheduled run.",
    );
  }

  if (String(latestBackup.id) !== expectedRunId) {
    throw new Error("The requested backup is not the latest completed DB Backup run.");
  }
  if (
    latestBackup.head_branch !== "main" ||
    !/^[0-9a-f]{40}$/u.test(latestBackup.head_sha ?? "")
  ) {
    throw new Error("The latest DB Backup run is not a valid main run.");
  }

  const nowTime = parseTime(now, "Current");
  const backupTime = parseTime(latestBackup.created_at, "Backup");
  if (backupTime > nowTime || nowTime - backupTime > MAX_BACKUP_AGE_MS) {
    throw new Error("The latest DB Backup run is stale.");
  }

  if (
    String(restoreRun?.id) !== expectedRestoreRunId ||
    restoreRun.status !== "completed" ||
    restoreRun.conclusion !== "success" ||
    restoreRun.event !== "workflow_dispatch" ||
    restoreRun.head_branch !== "main" ||
    restoreRun.path !== ".github/workflows/db-restore-drill.yml" ||
    restoreRun.head_sha !== expectedTrustedWorkflowSha
  ) {
    throw new Error("Restore proof is not from a successful trusted main workflow run.");
  }
  const restoreTime = parseTime(
    restoreRun.run_started_at ?? restoreRun.created_at,
    "Restore workflow",
  );
  if (restoreTime < backupTime || restoreTime > nowTime) {
    throw new Error("Restore workflow timestamp is outside the backup window.");
  }

  if (
    proof?.format_version !== 1 ||
    proof.backup_run_id !== expectedRunId ||
    proof.backup_head_sha !== latestBackup.head_sha ||
    proof.restore_workflow_run_id !== expectedRestoreRunId ||
    proof.restore_workflow_head_sha !== restoreRun.head_sha ||
    proof.candidate_sha !== expectedCandidateSha
  ) {
    throw new Error(
      "Restore proof is not bound to the backup, workflow run, and candidate.",
    );
  }
  const verifiedTime = parseTime(proof.verified_at, "Restore proof");
  if (verifiedTime < restoreTime || verifiedTime > nowTime) {
    throw new Error("Restore proof timestamp is outside the restore workflow window.");
  }

  const artifact = oneUnexpiredArtifact(
    artifacts,
    "The latest DB Backup run",
  );
  if (
    !/^terroir-db-backup-/u.test(artifact.name ?? "") ||
    String(artifact.id) !== proof.backup_artifact_id ||
    artifact.digest !== proof.backup_artifact_digest
  ) {
    throw new Error("Restore proof artifact digest does not match GitHub.");
  }
  const restoreArtifact = oneUnexpiredArtifact(
    restoreArtifacts,
    "The restore workflow run",
  );
  if (
    restoreArtifact.name !== `database-restore-proof-${expectedRestoreRunId}` ||
    !/^sha256:[0-9a-f]{64}$/u.test(restoreArtifact.digest ?? "")
  ) {
    throw new Error("Restore workflow artifact identity is invalid.");
  }

  if (
    !/^sha256:[0-9a-f]{64}$/u.test(proof.backup_artifact_digest ?? "") ||
    !/^[0-9a-f]{64}$/u.test(proof.restore_report_sha256 ?? "") ||
    !Buffer.isBuffer(restoreReportBytes) ||
    createHash("sha256").update(restoreReportBytes).digest("hex") !==
      proof.restore_report_sha256
  ) {
    throw new Error("Restore proof report digest is invalid.");
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

  let restoreReport;
  try {
    restoreReport = JSON.parse(restoreReportBytes.toString("utf8"));
  } catch {
    throw new Error("Restore report is not valid JSON.");
  }
  if (
    restoreReport.ok !== true ||
    !Array.isArray(restoreReport.failures) ||
    restoreReport.failures.length !== 0 ||
    restoreReport.verified_at !== proof.verified_at ||
    restoreReport.migration_version !== proof.migration_version ||
    restoreReport.source_table_count !== proof.source_table_count ||
    restoreReport.source_non_empty_table_count !==
      proof.source_non_empty_table_count ||
    restoreReport.table_count !== proof.restored_table_count ||
    restoreReport.required_content_checksums !==
      proof.required_content_checksums ||
    restoreReport.checked_content_checksums !==
      proof.checked_content_checksums
  ) {
    throw new Error("Restore report does not match its release proof.");
  }

}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function main() {
  const runs = JSON.parse(
    readFileSync(requiredEnv("BACKUP_RUNS_FILE"), "utf8"),
  );
  const restoreReportBytes = readFileSync(
    requiredEnv("BACKUP_RESTORE_REPORT_FILE"),
  );
  assertReleaseBackupHealth({
    backupRuns: runs.workflow_runs,
    artifacts: JSON.parse(
      readFileSync(requiredEnv("BACKUP_ARTIFACTS_FILE"), "utf8"),
    ),
    restoreRun: JSON.parse(
      readFileSync(requiredEnv("RESTORE_RUN_FILE"), "utf8"),
    ),
    restoreArtifacts: JSON.parse(
      readFileSync(requiredEnv("RESTORE_ARTIFACTS_FILE"), "utf8"),
    ),
    proof: JSON.parse(
      readFileSync(requiredEnv("BACKUP_RELEASE_PROOF_FILE"), "utf8"),
    ),
    restoreReportBytes,
    expectedRunId: requiredEnv("BACKUP_EXPECTED_RUN_ID"),
    expectedRestoreRunId: requiredEnv("RESTORE_EXPECTED_RUN_ID"),
    expectedCandidateSha: requiredEnv("RELEASE_CANDIDATE_SHA"),
    expectedTrustedWorkflowSha: requiredEnv("RELEASE_TRUSTED_WORKFLOW_SHA"),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
