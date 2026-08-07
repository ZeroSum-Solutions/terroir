// @vitest-environment node
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const fixtureToken = "synthetic-alert-drill-token-00000001";

function run(baseUrl: string, token = fixtureToken) {
  return spawnSync(process.execPath, ["scripts/run-alert-drill.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ALERT_DRILL_BASE_URL: baseUrl,
      ALERT_DRILL_TOKEN: token,
    },
    encoding: "utf8",
  });
}

describe("alert drill script safety", () => {
  it("rejects a lookalike staging hostname before any request", () => {
    const result = run("https://terroir-web-staging.attacker.example");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Remote alert drills are restricted to https://terroir-web-staging.up.railway.app",
    );
    expect(result.stderr).not.toContain(fixtureToken);
  });

  it("rejects URL credentials and short tokens", () => {
    const credentials = run("http://user:password@127.0.0.1:3317");
    expect(credentials.status).not.toBe(0);
    expect(credentials.stderr).toContain("must not contain credentials");

    const shortToken = run("http://127.0.0.1:3317", "too-short");
    expect(shortToken.status).not.toBe(0);
    expect(shortToken.stderr).toContain("32 to 256 characters");
  });
});
