import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertRestoreReport } from "./assert-restore-report.mjs";

export function createRestoreReleaseProof({
  runId,
  githubRun,
  githubArtifacts,
  source,
  report,
  reportBytes,
}) {
  if (!/^\d+$/u.test(runId) || githubRun?.conclusion !== "success") {
    throw new Error("Release proof requires a successful numeric backup run.");
  }
  if (!/^[0-9a-f]{40}$/u.test(githubRun.headSha ?? "")) {
    throw new Error("Backup run head SHA is invalid.");
  }
  const artifacts = githubArtifacts?.artifacts?.filter(
    ({ expired }) => expired === false,
  );
  if (artifacts?.length !== 1) {
    throw new Error("Release proof requires one unexpired backup artifact.");
  }
  const artifact = artifacts[0];
  if (
    !Number.isSafeInteger(artifact.id) ||
    !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest ?? "")
  ) {
    throw new Error("Backup artifact identity is invalid.");
  }
  assertRestoreReport(source, report);

  return {
    format_version: 1,
    backup_run_id: runId,
    backup_head_sha: githubRun.headSha,
    backup_artifact_id: String(artifact.id),
    backup_artifact_digest: artifact.digest,
    restore_report_sha256: createHash("sha256")
      .update(reportBytes)
      .digest("hex"),
    verified_at: report.verified_at,
    migration_version: report.migration_version,
    restore_ok: true,
    restore_failure_count: 0,
    source_table_count: report.source_table_count,
    source_non_empty_table_count: report.source_non_empty_table_count,
    restored_table_count: report.table_count,
    required_content_checksums: report.required_content_checksums,
    checked_content_checksums: report.checked_content_checksums,
  };
}

function main() {
  const runId = process.env.BACKUP_RUN_ID;
  const runFile = process.env.BACKUP_GITHUB_RUN_FILE;
  const artifactsFile = process.env.BACKUP_GITHUB_ARTIFACTS_FILE;
  const sourceFile = process.env.BACKUP_SOURCE_EVIDENCE_FILE;
  const reportFile = process.env.BACKUP_RESTORE_REPORT_FILE;
  const proofFile = process.env.BACKUP_RELEASE_PROOF_FILE;
  if (
    !runId ||
    !runFile ||
    !artifactsFile ||
    !sourceFile ||
    !reportFile ||
    !proofFile
  ) {
    throw new Error("Restore release proof file inputs are required.");
  }
  const reportBytes = readFileSync(reportFile);
  const proof = createRestoreReleaseProof({
    runId,
    githubRun: JSON.parse(readFileSync(runFile, "utf8")),
    githubArtifacts: JSON.parse(readFileSync(artifactsFile, "utf8")),
    source: JSON.parse(readFileSync(sourceFile, "utf8")),
    report: JSON.parse(reportBytes.toString("utf8")),
    reportBytes,
  });
  writeFileSync(proofFile, `${JSON.stringify(proof, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
