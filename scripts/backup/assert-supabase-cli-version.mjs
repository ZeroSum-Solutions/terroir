import { pathToFileURL } from "node:url";

const MINIMUM_VERSION = [2, 112, 0];

export function assertSupabaseCliVersion(rawVersion) {
  const match = rawVersion.trim().match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) throw new Error("Supabase CLI returned an invalid version.");
  const observed = match.slice(1).map(Number);
  const isCurrentEnough = observed.some(
    (part, index) =>
      part > MINIMUM_VERSION[index] &&
      observed.slice(0, index).every((value, prior) =>
        value === MINIMUM_VERSION[prior]),
  ) || observed.every((part, index) => part === MINIMUM_VERSION[index]);
  if (!isCurrentEnough) {
    throw new Error(
      `Supabase CLI ${rawVersion.trim()} is too old; restore drills require 2.112.0 or newer.`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assertSupabaseCliVersion(process.env.SUPABASE_CLI_VERSION ?? "");
}
