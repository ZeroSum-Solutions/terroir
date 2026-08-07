import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve(process.cwd(), "scripts/test-staging.mjs");

function runWith(env: Partial<NodeJS.ProcessEnv>) {
  try {
    execFileSync(process.execPath, [script], {
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
    return "";
  } catch (error) {
    return (error as { stderr: Buffer }).stderr.toString();
  }
}

describe("test:staging target guard", () => {
  it("refuses a production-like host before sending a request", () => {
    const stderr = runWith({ STAGING_URL: "https://terroir-web.up.railway.app" });

    expect(stderr).toContain("refusing to target anything except");
  });

  it("refuses an invalid candidate SHA before sending a request", () => {
    const stderr = runWith({ STAGING_EXPECTED_SHA: "not-a-sha" });

    expect(stderr).toContain("STAGING_EXPECTED_SHA must be a Git SHA");
  });

  it("bounds retry attempts before sending a request", () => {
    const stderr = runWith({ STAGING_SMOKE_ATTEMPTS: "21" });

    expect(stderr).toContain("must not exceed 20");
  });
});
