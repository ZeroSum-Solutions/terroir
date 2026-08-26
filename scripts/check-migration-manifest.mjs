#!/usr/bin/env node

// Guards the normative migration manifest in the visual-wine platform spec.
// Only root-level forward migrations are checked; down migrations have their
// own gate in check-down-migrations.mjs.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATIONS_DIR = "supabase/migrations";
const MANIFEST_PATH =
  "docs/plans/2026-08-24-visual-wine-platform-spec-list.md";
const MANIFEST_START = 112;
const MIGRATION_PATTERN = /^(\d{4})_(.+)\.sql$/;
const POLICY_QUOTE =
  '"No migration file in this range may be created except from this manifest."';
const POLICY_REFERENCE = `${MANIFEST_PATH} §1`;

function parseTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;

  const inner = trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
  return inner.split("|").map((cell) => cell.trim());
}

export function parseMigrationManifest(manifestMarkdown) {
  const lines = manifestMarkdown.replaceAll("\r\n", "\n").split("\n");
  const sectionStart = lines.findIndex((line) =>
    /^##\s+1\.\s+Migration manifest\b/i.test(line.trim()),
  );
  if (sectionStart === -1) {
    throw new Error("§1 Migration manifest section was not found");
  }

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) {
      sectionEnd = index;
      break;
    }
  }

  let headerIndex = -1;
  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    const cells = parseTableRow(lines[index]);
    if (cells?.[0] === "#" && cells[1] === "File") {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex === -1) {
    throw new Error("manifest table header was not found in §1");
  }

  const header = parseTableRow(lines[headerIndex]);
  const delimiter = parseTableRow(lines[headerIndex + 1] ?? "");
  if (
    !delimiter ||
    delimiter.length !== header.length ||
    delimiter.some((cell) => !/^:?-{3,}:?$/.test(cell))
  ) {
    throw new Error("manifest table delimiter row is malformed");
  }

  const entries = new Map();
  for (let index = headerIndex + 2; index < sectionEnd; index += 1) {
    const cells = parseTableRow(lines[index]);
    if (!cells) break;
    if (!/^\d{4}$/.test(cells[0] ?? "")) continue;

    const number = cells[0];
    const filenameMatch = (cells[1] ?? "").match(/^`([^`]+\.sql)`$/);
    if (!filenameMatch) {
      throw new Error(`manifest row ${number} has an invalid File cell`);
    }
    if (entries.has(number)) {
      throw new Error(`manifest row ${number} is duplicated`);
    }
    entries.set(number, filenameMatch[1]);
  }

  if (!entries.has("0112")) {
    throw new Error("manifest table has no parseable 0112 row");
  }

  return entries;
}

export function checkMigrationManifest({ migrationFiles, manifestMarkdown }) {
  let manifest;
  try {
    manifest = parseMigrationManifest(manifestMarkdown);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      manifestEntryCount: 0,
      violations: [
        `could not parse the migration manifest at ${POLICY_REFERENCE}: ${detail}`,
      ],
    };
  }

  const violations = [];
  const migrationsByNumber = new Map();

  for (const filename of [...migrationFiles].sort()) {
    const match = filename.match(MIGRATION_PATTERN);
    if (!match) {
      violations.push(
        `migration filename must match NNNN_name.sql: ${filename}`,
      );
      continue;
    }

    const [, number] = match;
    const files = migrationsByNumber.get(number) ?? [];
    files.push(filename);
    migrationsByNumber.set(number, files);

    if (Number(number) < MANIFEST_START) continue;

    const manifestName = manifest.get(number);
    if (!manifestName) {
      violations.push(
        `${filename} has no manifest row for ${number}. ${POLICY_QUOTE} See ${POLICY_REFERENCE}.`,
      );
      continue;
    }

    const expectedFilename = `${number}_${manifestName}`;
    if (filename !== expectedFilename) {
      violations.push(
        `${filename} does not match manifest row ${number}; expected ${expectedFilename}. ${POLICY_QUOTE} See ${POLICY_REFERENCE}.`,
      );
    }
  }

  for (const [number, files] of migrationsByNumber) {
    if (files.length > 1) {
      violations.push(
        `migration number ${number} is duplicated: ${files.join(", ")}`,
      );
    }
  }

  return { manifestEntryCount: manifest.size, violations };
}

function main() {
  let migrationFiles;
  let manifestMarkdown;
  try {
    migrationFiles = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name);
    manifestMarkdown = readFileSync(MANIFEST_PATH, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Migration manifest check failed: ${detail}`);
    process.exitCode = 1;
    return;
  }

  const result = checkMigrationManifest({ migrationFiles, manifestMarkdown });
  if (result.violations.length === 0) {
    console.log(
      `Migration manifest check passed: ${migrationFiles.length} migration file(s), ${result.manifestEntryCount} manifest row(s).`,
    );
    return;
  }

  console.error(
    `Migration manifest check failed with ${result.violations.length} violation(s):`,
  );
  for (const violation of result.violations) {
    console.error(`  - ${violation}`);
  }
  process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  main();
}
