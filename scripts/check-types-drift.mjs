// Schema-drift gate for src/types/database.ts.
//
// `pnpm run types:gen` regenerates this file from hosted Supabase. CI compares
// it with the local schema produced by the checked-out migrations, and fails
// when the committed file no longer matches. That gate is about SCHEMA drift:
// a migration landed without regenerating.
//
// The generated artifact also carries an `__InternalSupabase` block reporting
// the PostgREST deployment it was generated against. Nothing about it is
// schema:
//
//   - Supabase can change the version with no commit on our side, and when
//     they do a plain `git diff` gate turns red on EVERY branch at once for a
//     reason no branch author can act on. (Observed 2026-08-29: "14.17" ->
//     "14.5", one line, zero schema difference.)
//   - The hosted generator emits the block; the CLI's `--local` generator does
//     not emit it at all. Normalizing only the version string therefore made
//     the local comparison fail on every run, with a diff that looked like the
//     whole file had changed because the line offsets cascade.
//
// So the comparison strips the entire block from BOTH sides and compares
// everything else byte-for-byte. The committed file keeps its real value —
// supabase-js reads it for type inference, so it is deliberately NOT rewritten
// — only the equality test ignores it.
//
// This is the same rule the import work learned the hard way: never gate on a
// value that depends on ambient environment rather than on the code.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = "src/types/database.ts";

// Deliberately anchored to the exact block, including the two generator
// comments that introduce it. A looser pattern would erase real schema and
// blind the gate.
const AMBIENT_INTERNAL_BLOCK =
  /[ \t]*\/\/ Allows to automatically instantiate createClient with right options\n[ \t]*\/\/ instead of createClient<Database, \{ PostgrestVersion: 'XX' \}>\(URL, KEY\)\n[ \t]*__InternalSupabase:\s*\{[^}]*?\}\n/;

// Belt and braces: if the generator ever emits the block without its comment
// preamble, drop it on its own.
const AMBIENT_INTERNAL_BARE = /[ \t]*__InternalSupabase:\s*\{[^}]*?\}\n/;

export function normalizeAmbientTypeFields(text) {
  return text.replace(AMBIENT_INTERNAL_BLOCK, "").replace(AMBIENT_INTERNAL_BARE, "");
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
    [
      "scripts/generate-supabase-types.mjs",
      ...(process.argv.includes("--local") ? ["--local"] : []),
    ],
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
    const source = process.argv.includes("--local") ? "local" : "live";
    console.log(
      `${OUT} matches the ${source} schema (ambient PostgrestVersion ignored).`,
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
