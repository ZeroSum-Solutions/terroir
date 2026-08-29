import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { checkMigrationManifest } from "../../../scripts/check-migration-manifest.mjs";

const manifestPath = join(
  process.cwd(),
  "docs/plans/2026-08-24-visual-wine-platform-spec-list.md",
);
const checkerPath = join(
  process.cwd(),
  "scripts/check-migration-manifest.mjs",
);
const fixtureRoots: string[] = [];

const manifestDocument = `
## 1. Migration manifest (normative)

| # | File | Contents | Depends on | Spec |
|---|---|---|---|---|
| 0112 | \`wine_editions.sql\` | editions | — | SPEC-01 |
| 0113 | \`image_licenses.sql\` | licenses | — | SPEC-02 |
| 0127 | \`match_lwin_deterministic_tiebreak.sql\` | deterministic LWIN tie-break | 0078 | — |
| 0128 | \`apply_import_batch_chunk_sibling_lock.sql\` | atomic sibling-applied guard | 0108 | — |
| 0129 | \`import_batches_digest_boundary.sql\` | digest boundary | 0128 | — |
| 0130+ | reserved | future work | per decision | — |

## 2. Spec slices
`;

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("check-migration-manifest", () => {
  test("accepts the current migration tree", () => {
    const migrationFiles = readdirSync(
      join(process.cwd(), "supabase", "migrations"),
      { withFileTypes: true },
    )
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name);
    const manifestMarkdown = readFileSync(manifestPath, "utf8");

    const result = checkMigrationManifest({
      migrationFiles,
      manifestMarkdown,
    });

    expect(result.violations).toEqual([]);
  });

  test("rejects duplicate migration numbers while allowing gaps", () => {
    const result = checkMigrationManifest({
      migrationFiles: ["0001_initial.sql", "0100_first.sql", "0100_second.sql"],
      manifestMarkdown: manifestDocument,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("migration number 0100 is duplicated");
    expect(result.violations[0]).toContain("0100_first.sql");
    expect(result.violations[0]).toContain("0100_second.sql");
  });

  test("rejects a malformed migration filename", () => {
    const result = checkMigrationManifest({
      migrationFiles: ["112_missing_digit.sql"],
      manifestMarkdown: manifestDocument,
    });

    expect(result.violations).toEqual([
      "migration filename must match NNNN_name.sql: 112_missing_digit.sql",
    ]);
  });

  test("rejects a post-0111 migration absent from the manifest", () => {
    const result = checkMigrationManifest({
      migrationFiles: ["0114_unlisted.sql"],
      manifestMarkdown: manifestDocument,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("0114_unlisted.sql has no manifest row");
    expect(result.violations[0]).toContain(
      '"No migration file in this range may be created except from this manifest."',
    );
    expect(result.violations[0]).toContain(
      "docs/plans/2026-08-24-visual-wine-platform-spec-list.md §1",
    );
  });

  test("rejects a post-0111 migration whose name differs from the manifest", () => {
    const result = checkMigrationManifest({
      migrationFiles: ["0112_wrong_name.sql"],
      manifestMarkdown: manifestDocument,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain(
      "0112_wrong_name.sql does not match manifest row 0112",
    );
    expect(result.violations[0]).toContain("expected 0112_wine_editions.sql");
  });

  test("accepts a post-0111 migration named by its manifest row", () => {
    const result = checkMigrationManifest({
      migrationFiles: ["0112_wine_editions.sql"],
      manifestMarkdown: manifestDocument,
    });

    expect(result.violations).toEqual([]);
  });

  test("fails closed when the manifest document cannot be parsed", () => {
    const result = checkMigrationManifest({
      migrationFiles: ["0001_initial.sql"],
      manifestMarkdown: "# Document without the normative table\n",
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain(
      "could not parse the migration manifest",
    );
  });

  test("rejects out-of-order manifest rows", () => {
    const outOfOrderManifest = manifestDocument.replace(
      "| 0112 | `wine_editions.sql` | editions | — | SPEC-01 |\n| 0113 | `image_licenses.sql` | licenses | — | SPEC-02 |",
      "| 0113 | `image_licenses.sql` | licenses | — | SPEC-02 |\n| 0112 | `wine_editions.sql` | editions | — | SPEC-01 |",
    );

    const result = checkMigrationManifest({
      migrationFiles: [],
      manifestMarkdown: outOfOrderManifest,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("out of order");
    expect(result.violations[0]).toContain("strictly increasing");
  });

  test("examines and rejects a non-lowercase migration extension", () => {
    const root = mkdtempSync(join(tmpdir(), "terroir-manifest-"));
    fixtureRoots.push(root);
    const migrationsDir = join(root, "supabase", "migrations");
    const plansDir = join(root, "docs", "plans");
    mkdirSync(migrationsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(migrationsDir, "0112_wine_editions.SQL"), "select 1;\n");
    writeFileSync(
      join(plansDir, "2026-08-24-visual-wine-platform-spec-list.md"),
      manifestDocument,
    );

    const result = spawnSync(process.execPath, [checkerPath], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "migration filename must match NNNN_name.sql: 0112_wine_editions.SQL",
    );
  });
});
