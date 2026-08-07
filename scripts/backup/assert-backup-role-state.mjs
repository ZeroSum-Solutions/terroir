import { pathToFileURL } from "node:url";

export const EXPECTED_BACKUP_ROLE_STATE =
  "f|f|f|t|f|t|f|0|0|0|0|t|t";

export function assertBackupRoleState(observed) {
  if (observed !== EXPECTED_BACKUP_ROLE_STATE) {
    throw new Error(
      `Backup role state mismatch (expected ${EXPECTED_BACKUP_ROLE_STATE}, observed ${observed || "<empty>"}).`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assertBackupRoleState(process.env.BACKUP_ROLE_STATE ?? "");
}
