import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function assertChecksumFile(contents, expectedFiles) {
  const expectedNames = new Set(expectedFiles.map((file) => basename(file)));
  const observedNames = new Set();
  const lines = contents.trim().split("\n");
  if (lines.length !== expectedNames.size) {
    throw new Error("Checksum file must contain exactly the expected artifacts.");
  }
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64}) {2}([^/]+)$/u);
    if (!match || !expectedNames.has(match[2]) || observedNames.has(match[2])) {
      throw new Error("Checksum file contains an unsafe or unexpected entry.");
    }
    observedNames.add(match[2]);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const checksumFile = process.env.BACKUP_CHECKSUMS_FILE;
  const encryptedFile = process.env.BACKUP_ENCRYPTED_FILE;
  const manifestFile = process.env.BACKUP_MANIFEST_FILE;
  if (!checksumFile || !encryptedFile || !manifestFile) {
    throw new Error(
      "BACKUP_CHECKSUMS_FILE, BACKUP_ENCRYPTED_FILE, and BACKUP_MANIFEST_FILE are required.",
    );
  }
  assertChecksumFile(await readFile(checksumFile, "utf8"), [
    encryptedFile,
    manifestFile,
  ]);
}
