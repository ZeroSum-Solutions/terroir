import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function assertFileEvidence(file, expected, label) {
  if (statSync(file).size !== expected.bytes) {
    throw new Error(`${label} byte length does not match the manifest.`);
  }
  if (sha256(file) !== expected.sha256) {
    throw new Error(`${label} SHA-256 does not match the manifest.`);
  }
}

export function verifyBackupArtifact({
  manifestFile,
  encryptedFile,
  payloadFile,
  dumpFile,
  evidenceFile,
}) {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (manifest.format_version !== 1) {
    throw new Error("Unsupported backup manifest version.");
  }
  if (
    manifest.encryption?.algorithm !== "age-x25519" ||
    manifest.dump?.format !== "postgres-custom"
  ) {
    throw new Error("Backup manifest declares unsupported formats.");
  }
  if (manifest.encrypted_artifact.name !== basename(encryptedFile)) {
    throw new Error("Encrypted artifact name does not match the manifest.");
  }
  assertFileEvidence(
    encryptedFile,
    manifest.encrypted_artifact,
    "Encrypted artifact",
  );
  if (payloadFile) {
    assertFileEvidence(
      payloadFile,
      manifest.plaintext_payload,
      "Decrypted payload",
    );
  }
  if (dumpFile) {
    assertFileEvidence(dumpFile, manifest.dump, "Database dump");
  }
  if (evidenceFile) {
    assertFileEvidence(
      evidenceFile,
      manifest.source_evidence,
      "Source evidence",
    );
  }
  return manifest;
}

function main() {
  const required = {
    manifestFile: process.env.BACKUP_MANIFEST_FILE,
    encryptedFile: process.env.BACKUP_ENCRYPTED_FILE,
  };
  for (const [name, value] of Object.entries(required)) {
    if (!value) throw new Error(`${name} is required.`);
  }
  verifyBackupArtifact({
    ...required,
    payloadFile: process.env.BACKUP_PAYLOAD_FILE,
    dumpFile: process.env.BACKUP_DUMP_FILE,
    evidenceFile: process.env.BACKUP_EVIDENCE_FILE,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
