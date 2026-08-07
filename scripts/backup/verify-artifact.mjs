import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { streamFileEvidence } from "./file-evidence.mjs";

async function assertFileEvidence(file, expected, label) {
  const observed = await streamFileEvidence(file);
  if (observed.bytes !== expected.bytes) {
    throw new Error(`${label} byte length does not match the manifest.`);
  }
  if (observed.sha256 !== expected.sha256) {
    throw new Error(`${label} SHA-256 does not match the manifest.`);
  }
}

export async function verifyBackupArtifact({
  manifestFile,
  encryptedFile,
  payloadFile,
  dumpFile,
  evidenceFile,
}) {
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
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
  await assertFileEvidence(
    encryptedFile,
    manifest.encrypted_artifact,
    "Encrypted artifact",
  );
  if (payloadFile) {
    await assertFileEvidence(
      payloadFile,
      manifest.plaintext_payload,
      "Decrypted payload",
    );
  }
  if (dumpFile) {
    await assertFileEvidence(dumpFile, manifest.dump, "Database dump");
  }
  if (evidenceFile) {
    await assertFileEvidence(
      evidenceFile,
      manifest.source_evidence,
      "Source evidence",
    );
  }
  return manifest;
}

async function main() {
  const required = {
    manifestFile: process.env.BACKUP_MANIFEST_FILE,
    encryptedFile: process.env.BACKUP_ENCRYPTED_FILE,
  };
  for (const [name, value] of Object.entries(required)) {
    if (!value) throw new Error(`${name} is required.`);
  }
  await verifyBackupArtifact({
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
  await main();
}
