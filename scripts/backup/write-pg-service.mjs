import { chmodSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function createPgServiceConfig(
  rawUrl,
  serviceName = "terroir_backup",
  expectedProjectRef = process.env.BACKUP_PROJECT_REF,
) {
  if (!/^[A-Za-z0-9_.-]+$/u.test(serviceName)) {
    throw new Error("PGSERVICE_NAME contains unsupported characters.");
  }
  const url = new URL(rawUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("SUPABASE_DB_URL must use postgresql://.");
  }
  if (!url.hostname || !url.username || !url.password) {
    throw new Error(
      "SUPABASE_DB_URL must include host, username, and password.",
    );
  }
  if (url.search || url.hash) {
    throw new Error(
      "SUPABASE_DB_URL query parameters and fragments are not supported.",
    );
  }

  if (expectedProjectRef) {
    const expectedUser = `terroir_backup.${expectedProjectRef}`;
    if (
      !url.hostname.endsWith(".pooler.supabase.com") ||
      url.port !== "5432" ||
      url.pathname !== "/postgres" ||
      decodeURIComponent(url.username) !== expectedUser
    ) {
      throw new Error(
        "SUPABASE_DB_URL must use the expected backup role on the Supabase session pooler port 5432.",
      );
    }
  }

  const database = url.pathname.replace(/^\/+/, "");
  if (!database || database.includes("/")) {
    throw new Error("SUPABASE_DB_URL must name exactly one database.");
  }

  const isCanonicalLocalRestore =
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname) &&
    url.port === "54322" &&
    decodeURIComponent(url.username) === "postgres" &&
    database === "postgres";
  const values = {
    host: url.hostname,
    port: url.port || "5432",
    dbname: decodeURIComponent(database),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    sslmode: isCanonicalLocalRestore ? "disable" : "require",
  };
  return [
    `[${serviceName}]`,
    ...Object.entries(values).map(
      ([key, value]) => `${key}=${serviceValue(value)}`,
    ),
    "",
  ].join("\n");
}

function serviceValue(value) {
  if (!/^[A-Za-z0-9._:/+=@-]+$/u.test(value)) {
    throw new Error(
      "Database connection fields must use service-file-safe characters.",
    );
  }
  return value;
}

export function writePgServiceFile({
  rawUrl = process.env.PG_DATABASE_URL ?? process.env.SUPABASE_DB_URL,
  file = process.env.PGSERVICEFILE,
  serviceName = process.env.PGSERVICE_NAME ?? "terroir_backup",
} = {}) {
  if (!rawUrl || !file) {
    throw new Error(
      "PG_DATABASE_URL or SUPABASE_DB_URL and PGSERVICEFILE are required.",
    );
  }
  writeFileSync(file, createPgServiceConfig(rawUrl, serviceName), {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(file, 0o600);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  writePgServiceFile();
}
