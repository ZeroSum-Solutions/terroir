import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const checkerPath = join(process.cwd(), "scripts", "check-down-migrations.mjs");

const fixtureRoots: string[] = [];

function createFixture(
  forwardFiles: string[],
  downFiles: string[],
): string {
  const root = mkdtempSync(join(tmpdir(), "terroir-migrations-"));
  fixtureRoots.push(root);

  const forwardDir = join(root, "supabase", "migrations");
  const downDir = join(forwardDir, "down");
  mkdirSync(downDir, { recursive: true });

  for (const file of forwardFiles) {
    writeFileSync(join(forwardDir, file), "select 1;\n");
  }
  for (const file of downFiles) {
    writeFileSync(join(downDir, file), "select 1;\n");
  }

  return root;
}

function runChecker(root: string) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: root,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("check-down-migrations", () => {
  test("rejects duplicate forward migration versions", () => {
    const root = createFixture(
      ["0011_first.sql", "0011_second.sql"],
      ["0011_first.down.sql", "0011_second.down.sql"],
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "forward migration version 0011 is duplicated",
    );
    expect(result.stderr).toContain("0011_first.sql");
    expect(result.stderr).toContain("0011_second.sql");
  });

  test("rejects duplicate down migration versions", () => {
    const root = createFixture(
      ["0011_first.sql"],
      ["0011_first.down.sql", "0011_second.down.sql"],
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "down migration version 0011 is duplicated",
    );
    expect(result.stderr).toContain("0011_first.down.sql");
    expect(result.stderr).toContain("0011_second.down.sql");
  });
});
