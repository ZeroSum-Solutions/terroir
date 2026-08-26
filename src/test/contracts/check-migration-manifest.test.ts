import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { checkMigrationManifest } from "../../../scripts/check-migration-manifest.mjs";

const manifestPath = join(
  process.cwd(),
  "docs/plans/2026-08-24-visual-wine-platform-spec-list.md",
);

const manifestDocument = `
## 1. Migration manifest (normative)

| # | File | Contents | Depends on | Spec |
|---|---|---|---|---|
| 0112 | \`wine_editions.sql\` | editions | — | SPEC-01 |
| 0113 | \`image_licenses.sql\` | licenses | — | SPEC-02 |
| 0127+ | reserved | future work | per decision | — |

## 2. Spec slices
`;

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
});
