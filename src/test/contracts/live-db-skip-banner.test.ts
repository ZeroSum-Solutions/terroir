import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import setup from "../../../vitest.global-setup";

// The banner exists because a local `pnpm test` reports success while seven
// live-DB suites — cross-tenant containment among them — quietly skip. A guard
// that can be deleted or broken without any test noticing is the same class of
// problem it was written to solve, so it is pinned here.

const LIVE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:57321",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

function runTeardownCapturingStderr(env: Record<string, string | undefined>) {
  const original = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  let written = "";
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      written += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });

  try {
    // setup() reads env at call time and returns the teardown that prints.
    setup()();
  } finally {
    spy.mockRestore();
    process.env = original;
  }
  return written;
}

describe("live-DB skip banner", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
  });

  test("warns, and names every gated suite, when no live stack is configured", () => {
    const out = runTeardownCapturingStderr({
      NEXT_PUBLIC_SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      CI: undefined,
    });

    expect(out).toContain("THIS RUN WAS GREEN WITHOUT THE LIVE-DATABASE SUITES");

    // Named individually rather than counted: a count assertion would keep
    // passing if the scan silently started matching the wrong files.
    expect(out).toContain("src/domains/identity/tenant-isolation.test.ts");
    expect(out).toContain("src/domains/import/tenant-isolation.test.ts");
    expect(out).toContain("src/lib/jobs/tenant-isolation.test.ts");
    expect(out).toContain("src/domains/import/p3-live.test.ts");
    expect(out).toContain("src/domains/import/import-hardening-live.test.ts");
    expect(out).toContain("src/domains/identity/merge.test.ts");

    // And it must say how to fix it, or it is just noise.
    expect(out).toContain("supabase start");
  });

  test("stays silent when the live stack IS configured", () => {
    const out = runTeardownCapturingStderr({ ...LIVE_ENV, CI: undefined });
    expect(out).toBe("");
  });

  test("stays silent in CI, which fails loudly on its own", () => {
    const out = runTeardownCapturingStderr({
      NEXT_PUBLIC_SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      CI: "1",
    });
    expect(out).toBe("");
  });

  test("never throws when src/ is unreadable from the cwd", () => {
    // A crashing globalSetup teardown would take down an otherwise-green run.
    process.chdir("/");
    expect(() =>
      runTeardownCapturingStderr({
        NEXT_PUBLIC_SUPABASE_URL: undefined,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
        CI: undefined,
      }),
    ).not.toThrow();
  });
});
