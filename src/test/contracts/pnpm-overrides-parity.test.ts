import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

// The security overrides are declared TWICE on purpose, and this test is the
// reason that is safe rather than a bug waiting to happen.
//
// pnpm moved `overrides` out of package.json and into pnpm-workspace.yaml in
// version 10. CI pins pnpm 9; developer machines here run 11. So:
//
//   * pnpm 9 reads package.json's `pnpm.overrides` and ignores the workspace
//     file's;
//   * pnpm 11 reads pnpm-workspace.yaml's and ignores package.json's (silently,
//     with a warning).
//
// Declaring them in only one place means one of the two resolves "no overrides",
// disagrees with the lockfile's `overrides:` block, and fails
// `--frozen-lockfile` with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH — a failure whose
// message points nowhere near its cause. Declaring the SAME set in both places
// makes every supported pnpm compute the same resolution.
//
// The obvious risk is drift: someone edits one file and not the other, and the
// two majors quietly resolve different dependency trees. That is what this test
// prevents. Delete it only when the toolchain is pinned to a single pnpm major
// and one of the two declarations is removed.

const repoRoot = path.resolve(__dirname, "../../..");

function parseWorkspaceOverrides(yaml: string): Record<string, string> {
  const afterKey = yaml.split(/^overrides:\s*$/m)[1];
  if (afterKey === undefined) return {};
  const out: Record<string, string> = {};
  for (const rawLine of afterKey.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Stop at the next top-level key.
    if (!rawLine.startsWith(" ") && !rawLine.startsWith("\t")) break;
    const match = /^"?([^":]+(?:@\d+)?)"?:\s*"([^"]+)"$/.exec(line);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

describe("pnpm overrides parity", () => {
  const pkg = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as { pnpm?: { overrides?: Record<string, string> } };
  const workspace = readFileSync(
    path.join(repoRoot, "pnpm-workspace.yaml"),
    "utf8",
  );

  const fromPackageJson = pkg.pnpm?.overrides ?? {};
  const fromWorkspace = parseWorkspaceOverrides(workspace);

  test("both declarations are non-empty", () => {
    // Guards the parser itself: a silently-empty parse would make the equality
    // assertion below pass for the wrong reason.
    expect(Object.keys(fromWorkspace).length).toBeGreaterThan(0);
    expect(Object.keys(fromPackageJson).length).toBeGreaterThan(0);
  });

  test("package.json and pnpm-workspace.yaml declare an identical override set", () => {
    expect(fromPackageJson).toEqual(fromWorkspace);
  });
});
