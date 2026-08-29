import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  assertLiveDbTargetIsLocal,
  isLoopbackDbUrl,
} from "../live-db-target";

const repoRoot = path.resolve(__dirname, "../../..");

describe("live-DB target guard", () => {
  test("accepts every loopback form the local stack can print", () => {
    for (const url of [
      "http://127.0.0.1:57321",
      "http://localhost:54321",
      "http://[::1]:54321",
      "https://127.0.0.1:57321/rest/v1",
    ]) {
      expect(isLoopbackDbUrl(url), url).toBe(true);
      expect(() => assertLiveDbTargetIsLocal(url), url).not.toThrow();
    }
  });

  test("refuses the production Supabase project", () => {
    expect(() =>
      assertLiveDbTargetIsLocal("https://qcfmwphlaekfkqwkfyth.supabase.co"),
    ).toThrow(/non-loopback/i);
  });

  test("refuses an unknown remote host it has never been told about", () => {
    // Allow-list, not deny-list: the guard must refuse hosts nobody enumerated.
    expect(() =>
      assertLiveDbTargetIsLocal("https://some-new-project.supabase.co"),
    ).toThrow(/non-loopback/i);
    expect(isLoopbackDbUrl("https://db.internal.example")).toBe(false);
  });

  test("is not fooled by a loopback address outside the host", () => {
    // A substring check would pass all three of these.
    for (const url of [
      "https://evil.test/?redirect=127.0.0.1",
      "https://127.0.0.1.evil.test",
      "https://user:127.0.0.1@evil.test",
    ]) {
      expect(isLoopbackDbUrl(url), url).toBe(false);
      expect(() => assertLiveDbTargetIsLocal(url), url).toThrow(/non-loopback/i);
    }
  });

  test("refuses a malformed URL rather than assuming it is safe", () => {
    for (const url of ["", "not-a-url", "127.0.0.1:57321"]) {
      expect(isLoopbackDbUrl(url), url).toBe(false);
    }
  });

  test("the error explains the danger and the fix", () => {
    let message = "";
    try {
      assertLiveDbTargetIsLocal("https://qcfmwphlaekfkqwkfyth.supabase.co");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/service-role/i);
    expect(message).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  // The guard is only worth having if every privileged suite actually calls it.
  // This is the load-bearing half: a live suite added later without the guard
  // fails here rather than silently inheriting the old, unguarded behaviour.
  test("every service-role test suite is wired to the guard", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".test.ts")) files.push(full);
      }
    };
    walk(path.join(repoRoot, "src"));
    expect(files.length).toBeGreaterThan(50);

    const unguarded: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // A suite is "privileged" when it reads the REAL RLS-bypassing key out
      // of the environment. Suites that mock @supabase/supabase-js and stub a
      // fake key string never reach a database and are correctly exempt.
      if (!source.includes("process.env.SUPABASE_SERVICE_ROLE_KEY")) continue;
      if (!source.includes("assertLiveDbTargetIsLocal")) {
        unguarded.push(path.relative(repoRoot, file));
      }
    }

    // Sanity: the predicate must actually be selecting the live suites. If a
    // rename made it match nothing, the assertion above would pass vacuously.
    const privileged = files.filter((file) =>
      readFileSync(file, "utf8").includes("process.env.SUPABASE_SERVICE_ROLE_KEY"),
    );
    expect(privileged.length).toBeGreaterThanOrEqual(7);

    expect(unguarded, "service-role suites missing the local-target guard").toEqual([]);
  });
});
