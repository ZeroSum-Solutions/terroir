import { createHash } from "node:crypto";
import { basename } from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { streamFileEvidence } from "./file-evidence.mjs";

export async function createBackupManifest(env = process.env) {
  const required = [
    "BACKUP_DUMP_FILE",
    "BACKUP_EVIDENCE_FILE",
    "BACKUP_PAYLOAD_FILE",
    "BACKUP_ENCRYPTED_FILE",
    "BACKUP_TABLE_DATA_ENTRIES",
    "BACKUP_PROJECT_REF",
    "BACKUP_AGE_RECIPIENT",
    "RESTORE_DRILL_AGE_RECIPIENT",
    "BACKUP_PG_DUMP_VERSION",
    "BACKUP_AGE_VERSION",
    "GITHUB_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
  ];
  for (const name of required) {
    if (!env[name]) throw new Error(`${name} is required.`);
  }

  const tableEntries = Number(env.BACKUP_TABLE_DATA_ENTRIES);
  if (!Number.isSafeInteger(tableEntries) || tableEntries <= 0) {
    throw new Error("BACKUP_TABLE_DATA_ENTRIES must be positive.");
  }

  return {
    format_version: 1,
    created_at: new Date().toISOString(),
    source: {
      project_ref: env.BACKUP_PROJECT_REF,
      git_sha: env.GITHUB_SHA,
      github_run_id: env.GITHUB_RUN_ID,
      github_run_attempt: env.GITHUB_RUN_ATTEMPT,
    },
    dump: {
      name: basename(env.BACKUP_DUMP_FILE),
      format: "postgres-custom",
      pg_dump_version: env.BACKUP_PG_DUMP_VERSION,
      table_data_entries: tableEntries,
      ...(await streamFileEvidence(env.BACKUP_DUMP_FILE)),
    },
    source_evidence: {
      name: basename(env.BACKUP_EVIDENCE_FILE),
      ...(await streamFileEvidence(env.BACKUP_EVIDENCE_FILE)),
    },
    plaintext_payload: await streamFileEvidence(env.BACKUP_PAYLOAD_FILE),
    encrypted_artifact: {
      name: basename(env.BACKUP_ENCRYPTED_FILE),
      ...(await streamFileEvidence(env.BACKUP_ENCRYPTED_FILE)),
    },
    encryption: {
      algorithm: "age-x25519",
      age_version: env.BACKUP_AGE_VERSION,
      recipient_sha256: createHash("sha256")
        .update(env.BACKUP_AGE_RECIPIENT)
        .digest("hex"),
      restore_drill_recipient_sha256: createHash("sha256")
        .update(env.RESTORE_DRILL_AGE_RECIPIENT)
        .digest("hex"),
    },
  };
}

export async function writeBackupManifest({
  file = process.env.BACKUP_MANIFEST_FILE,
  env = process.env,
} = {}) {
  if (!file) throw new Error("BACKUP_MANIFEST_FILE is required.");
  await writeFile(
    file,
    `${JSON.stringify(await createBackupManifest(env), null, 2)}\n`,
    "utf8",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await writeBackupManifest();
}
