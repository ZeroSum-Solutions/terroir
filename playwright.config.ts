import { defineConfig } from "@playwright/test";

const realAuthE2e = process.env.AUTH_E2E_ENABLED === "1";
// AF-D: lets a suite target an already-running dev server on a fixed,
// non-default port (e.g. a worktree pinned to :3105) instead of spawning
// another one on :3000. Unset by default — every existing invocation is
// unaffected.
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const failOnSkippedTests = process.env.FAIL_ON_SKIPPED_TESTS === "1";
const baseURL = realAuthE2e
  ? process.env.AUTH_E2E_BASE_URL
  : (externalBaseURL ?? "http://127.0.0.1:3000");

if (realAuthE2e && !baseURL) {
  throw new Error("AUTH_E2E_BASE_URL must be set when AUTH_E2E_ENABLED=1.");
}

export default defineConfig({
  testDir: "./e2e",
  reporter: failOnSkippedTests
    ? [["list"], ["./e2e/no-skips-reporter.ts"]]
    : undefined,
  // Turbopack compiles routes on first navigation in CI. Give that first
  // deterministic pass headroom instead of masking cold-start timeouts with
  // retries; local runs keep the faster feedback budget.
  timeout: process.env.CI ? 60_000 : 30_000,
  // Suites share one dev-login identity and one database: parallel workers
  // invalidate each other's magic-link tokens and race config mutations.
  workers: 1,
  retries: 0,
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: realAuthE2e || externalBaseURL
    ? undefined
    : {
        command: "scripts/local/dev-local.sh",
        port: 3000,
        reuseExistingServer: false,
      },
});
