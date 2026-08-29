import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { assertScratchRestoreTarget } from "../../../scripts/restore-drill.mjs";

// scripts/restore-drill.mjs is the recovery path: it decrypts a backup
// artifact and restores it into a throwaway PostgreSQL container. Until now it
// had NO tests and — per the absent proof directory the runbook asks for — has
// never been executed even once. Recovery code that has never run is exactly
// the code that fails when it is finally needed, and the one function standing
// between a drill and a real database had nothing pinning it at all.

const repoRoot = path.resolve(__dirname, "../../..");

describe("restore drill: scratch-target guard", () => {
  test("accepts only loopback targets", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(() => assertScratchRestoreTarget(host)).not.toThrow();
    }
  });

  test("refuses the production Supabase host", () => {
    expect(() =>
      assertScratchRestoreTarget("db.qcfmwphlaekfkqwkfyth.supabase.co"),
    ).toThrow(/non-loopback/i);
  });

  test("refuses the pooler host", () => {
    expect(() =>
      assertScratchRestoreTarget("aws-0-us-east-1.pooler.supabase.com"),
    ).toThrow(/non-loopback/i);
  });

  test("refuses anything else that is not loopback", () => {
    // The point is that the guard is an ALLOW-list, not a deny-list of known
    // production names: an unknown host it has never heard of must still be
    // refused, or the guard would only protect against the hosts someone
    // remembered to enumerate.
    for (const host of [
      "10.0.0.5",
      "192.168.1.10",
      "some-staging-box.internal",
      "127.0.0.1.evil.example.com",
      "",
    ]) {
      expect(() => assertScratchRestoreTarget(host), host).toThrow();
    }
  });

  test("is case-insensitive about loopback spellings it does not allow", () => {
    // "LOCALHOST" is not in the allow-list, and the guard must not quietly
    // normalise its way into accepting a spelling it never vetted.
    expect(() => assertScratchRestoreTarget("LOCALHOST")).toThrow();
  });
});

describe("restore drill: wiring", () => {
  test("is reachable as a package script, not only as a loose file", () => {
    // It sat in scripts/ with no package.json entry and no CI job, so nothing
    // pointed at it and nobody would find it during an incident.
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["drill:restore"]).toBe("node scripts/restore-drill.mjs");
  });

  test("its runbook exists where the backup runbook says it does", () => {
    expect(existsSync(path.join(repoRoot, "docs/RESTORE-DRILL.md"))).toBe(true);
  });
});
