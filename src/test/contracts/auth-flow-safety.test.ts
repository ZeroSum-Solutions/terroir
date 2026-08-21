import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const authRoot = path.join(process.cwd(), "src/app/auth");

function readAuthSources(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return readAuthSources(entryPath);
      return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
        ? [readFileSync(entryPath, "utf8")]
        : [];
    })
    .join("\n");
}

describe("authentication flow safety contract", () => {
  it("does not expose a fragment-token session completion route", () => {
    expect(existsSync(path.join(authRoot, "complete/page.tsx"))).toBe(false);
    expect(readAuthSources(authRoot)).not.toMatch(
      /setSession\s*\(\s*\{\s*access_token\s*,\s*refresh_token\s*\}/,
    );
  });
});
