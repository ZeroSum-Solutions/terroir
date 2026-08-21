import { defineConfig } from "@playwright/test";

const realAuthE2e = process.env.AUTH_E2E_ENABLED === "1";
const baseURL = realAuthE2e
  ? process.env.AUTH_E2E_BASE_URL
  : "http://127.0.0.1:3000";

if (realAuthE2e && !baseURL) {
  throw new Error("AUTH_E2E_BASE_URL must be set when AUTH_E2E_ENABLED=1.");
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  // Suites share one dev-login identity and one database: parallel workers
  // invalidate each other's magic-link tokens and race config mutations.
  workers: 1,
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: realAuthE2e
    ? undefined
    : {
        command: "pnpm dev",
        port: 3000,
        reuseExistingServer: true,
      },
});
