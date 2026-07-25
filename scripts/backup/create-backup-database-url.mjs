import { pathToFileURL } from "node:url";

const PROJECT_REF = "qcfmwphlaekfkqwkfyth";

export function createBackupDatabaseUrl({
  adminUrl,
  backupPassword,
} = {}) {
  if (!adminUrl) {
    throw new Error("SUPABASE_SESSION_POOLER_URL is required.");
  }
  if (typeof backupPassword !== "string" || backupPassword.length < 32) {
    throw new Error("BACKUP_ROLE_PASSWORD must be at least 32 characters.");
  }

  const url = new URL(adminUrl);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname.endsWith(".pooler.supabase.com") ||
    url.port !== "5432" ||
    url.pathname !== "/postgres" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Admin URL must be the Supabase session pooler on port 5432 for database postgres.",
    );
  }
  if (decodeURIComponent(url.username) !== `postgres.${PROJECT_REF}`) {
    throw new Error(
      "Admin URL username must target the expected Supabase project.",
    );
  }

  url.username = `terroir_backup.${PROJECT_REF}`;
  url.password = backupPassword;
  return url.href;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.stdout.write(
    createBackupDatabaseUrl({
      adminUrl: process.env.SUPABASE_SESSION_POOLER_URL,
      backupPassword: process.env.BACKUP_ROLE_PASSWORD,
    }),
  );
}
