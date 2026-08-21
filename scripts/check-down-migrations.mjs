#!/usr/bin/env node
// INT-006 CI gate — verifies every forward migration from 0011 onward
// has a paired down migration at supabase/migrations/down/ and that
// forward and down migration versions are unique.
//
// Policy:
//   - Forward:  supabase/migrations/NNNN_<name>.sql
//   - Down:     supabase/migrations/down/NNNN_<name>.down.sql
// The basename (minus extension) must match, including the 4-digit
// prefix and the underscore-joined name.
//
// Migrations 0001-0010 predate the convention and are exempt.
//
// Usage:
//   node scripts/check-down-migrations.mjs
// Exits 0 on pass, 1 on any missing pair.

import { readdirSync } from "node:fs";
import { join } from "node:path";

const FORWARD_DIR = "supabase/migrations";
const DOWN_DIR = "supabase/migrations/down";
const CONVENTION_STARTS_AT = 11; // first migration covered by the convention
const FORWARD_VERSION_PATTERN = /^(\d{4})(?:_.+)?\.sql$/;
const DOWN_VERSION_PATTERN = /^(\d{4})_.+\.down\.sql$/;

function listForward() {
  return readdirSync(FORWARD_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .filter((f) => {
      const n = Number(f.slice(0, 4));
      return n >= CONVENTION_STARTS_AT;
    })
    .sort();
}

function listDown() {
  let entries;
  try {
    entries = readdirSync(DOWN_DIR);
  } catch {
    return [];
  }
  return entries.filter((f) => /^\d{4}_.+\.down\.sql$/.test(f));
}

function listMigrationVersions(directory, pattern) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries
    .map((file) => {
      const match = file.match(pattern);
      return match ? { file, version: match[1] } : null;
    })
    .filter(Boolean);
}

function findDuplicateVersions(entries) {
  const filesByVersion = new Map();
  for (const entry of entries) {
    const files = filesByVersion.get(entry.version) ?? [];
    files.push(entry.file);
    filesByVersion.set(entry.version, files);
  }
  return [...filesByVersion.entries()].filter(([, files]) => files.length > 1);
}

const forwards = listForward();
const downs = new Set(listDown().map((f) => f.replace(/\.down\.sql$/, "")));
const duplicateForwardVersions = findDuplicateVersions(
  listMigrationVersions(FORWARD_DIR, FORWARD_VERSION_PATTERN),
);
const duplicateDownVersions = findDuplicateVersions(
  listMigrationVersions(DOWN_DIR, DOWN_VERSION_PATTERN),
);

const missing = forwards
  .map((f) => f.replace(/\.sql$/, ""))
  .filter((base) => !downs.has(base));

if (
  missing.length === 0 &&
  duplicateForwardVersions.length === 0 &&
  duplicateDownVersions.length === 0
) {
  console.log(
    `All ${forwards.length} forward migration(s) from ${CONVENTION_STARTS_AT.toString().padStart(4, "0")} onward have a paired down, and migration versions are unique.`,
  );
  process.exit(0);
}

if (missing.length > 0) {
  console.error(
    `\nINT-006 policy violation: ${missing.length} forward migration(s) ` +
      `missing a paired down at ${DOWN_DIR}/:`,
  );
  for (const base of missing) {
    console.error(`  - expected ${join(DOWN_DIR, `${base}.down.sql`)}`);
  }
}

for (const [version, files] of duplicateForwardVersions) {
  console.error(
    `\nINT-006 policy violation: forward migration version ${version} is duplicated:`,
  );
  for (const file of files) {
    console.error(`  - ${join(FORWARD_DIR, file)}`);
  }
}

for (const [version, files] of duplicateDownVersions) {
  console.error(
    `\nINT-006 policy violation: down migration version ${version} is duplicated:`,
  );
  for (const file of files) {
    console.error(`  - ${join(DOWN_DIR, file)}`);
  }
}

if (missing.length > 0) {
  console.error(
    "\nIf the migration is structurally irreversible (e.g., `alter type add value`),\n" +
      "still create the .down.sql file with a single comment explaining why.\n" +
      "See supabase/migrations/down/README.md for the convention.",
  );
}
process.exit(1);
