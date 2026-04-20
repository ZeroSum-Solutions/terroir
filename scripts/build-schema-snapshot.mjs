#!/usr/bin/env node
// BND-012 — Build supabase/schema.snapshot.sql from the migrations dir.
//
// Usage:
//   node scripts/build-schema-snapshot.mjs           (from terroir/)
//   pnpm run snapshot                                (via package.json)
//
// The snapshot is a deterministic concatenation of every .sql file in
// supabase/migrations/ sorted alphabetically, with a header line naming
// each file. CI's snapshot:check step runs this and then
// `git diff --exit-code` against the committed copy — if they differ, a
// migration was added without regenerating the snapshot and CI fails.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const OUT = "supabase/schema.snapshot.sql";

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const body = files
  .map((f) => `-- === ${f} ===\n${readFileSync(join(DIR, f), "utf8")}`)
  .join("\n");

writeFileSync(OUT, body);
console.log(`Wrote ${OUT} (${files.length} migrations, ${body.length} bytes)`);
