import { pathToFileURL } from "node:url";

export function assertDisposableRestoreUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Restore target must use postgresql://.");
  }
  if (url.hostname !== "127.0.0.1") {
    throw new Error(
      "Restore drill refuses every non-loopback database target.",
    );
  }
  if (
    url.port !== "54322" ||
    decodeURIComponent(url.username) !== "supabase_admin"
  ) {
    throw new Error(
      "Restore drill target must be the canonical local Supabase postgres service on port 54322.",
    );
  }
  if (url.pathname.replace(/^\/+/, "") !== "postgres") {
    throw new Error("Restore drill target must be the disposable postgres DB.");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const rawUrl = process.env.PG_DATABASE_URL;
  if (!rawUrl) throw new Error("PG_DATABASE_URL is required.");
  assertDisposableRestoreUrl(rawUrl);
}
