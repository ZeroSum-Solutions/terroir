// Schema-drift gate for src/types/database.ts.
//
// `pnpm run types:gen` regenerates this file from the LIVE hosted Supabase
// project, and CI fails the build when the committed file no longer matches.
// That gate is about SCHEMA drift: a migration landed without regenerating.
//
// The generated artifact also carries `__InternalSupabase.PostgrestVersion`,
// which reports the hosted project's PostgREST deployment. Supabase can change
// it with no commit on our side, and when they do a plain `git diff` gate turns
// red on EVERY branch simultaneously for a reason no branch author can act on
// or fix — the failure is indistinguishable from a real missed regeneration.
// (Observed 2026-08-29: "14.17" -> "14.5", one line, zero schema difference.)
//
// So the comparison normalizes that one ambient field on BOTH sides and
// compares everything else byte-for-byte. The committed file keeps its real
// value — supabase-js reads it for type inference, so it is deliberately NOT
// rewritten — only the equality test ignores it.
//
// This is the same rule the import work learned the hard way: never gate on a
// value that depends on ambient environment rather than on the code.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = "src/types/database.ts";

// Deliberately anchored to the exact field. A looser pattern (any quoted
// number, say) would also erase real schema literals and blind the gate.
const AMBIENT_POSTGREST_VERSION =
  /(__InternalSupabase:\s*\{[^}]*?PostgrestVersion:\s*)"[^"]*"/;

export function normalizeAmbientTypeFields(text) {
  return text.replace(AMBIENT_POSTGREST_VERSION, '$1"<ambient>"');
}

export function compareTypeArtifacts(committed, generated) {
  const a = normalizeAmbientTypeFields(committed);
  const b = normalizeAmbientTypeFields(generated);
  if (a === b) return { drifted: false, diff: "" };

  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const diff = [];
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      if (aLines[i] !== undefined) diff.push(`-${aLines[i]}`);
      if (bLines[i] !== undefined) diff.push(`+${bLines[i]}`);
    }
  }
  return { drifted: true, diff: diff.join("\n") };
}

function main() {
  const committed = readFileSync(OUT, "utf8");

  const gen = spawnSync(
    process.execPath,
    ["scripts/generate-supabase-types.mjs"],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (gen.status !== 0) {
    // Restore before exiting: a partial write must not be left behind.
    writeFileSync(OUT, committed);
    process.exit(gen.status ?? 1);
  }

  // try/finally so that ANY failure after generation — a read error, a
  // comparison throw, an interrupt — still restores the developer's file. The
  // gate reports; it never edits.
  let drifted, diff;
  try {
    const generated = readFileSync(OUT, "utf8");
    ({ drifted, diff } = compareTypeArtifacts(committed, generated));
  } finally {
    writeFileSync(OUT, committed);
  }

  if (!drifted) {
    console.log(
      `${OUT} matches the live schema (ambient PostgrestVersion ignored).`,
    );
    return;
  }

  console.error(`${OUT} is out of date with the live schema.`);
  console.error("Run `pnpm run types:gen` and commit the result.\n");
  console.error(diff);
  process.exit(1);
}

// Only run the CLI when invoked directly, so the pure helpers stay importable.
if (process.argv[1] && process.argv[1].endsWith("check-types-drift.mjs")) {
  main();
}
