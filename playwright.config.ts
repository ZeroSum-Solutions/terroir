import { defineConfig } from "@playwright/test";

const realAuthE2e = process.env.AUTH_E2E_ENABLED === "1";
const externalBaseUrl = realAuthE2e
  ? process.env.AUTH_E2E_BASE_URL
  : process.env.UI_CRAWL_BASE_URL;

if (realAuthE2e && !externalBaseUrl) {
  throw new Error("AUTH_E2E_BASE_URL must be set when AUTH_E2E_ENABLED=1.");
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: externalBaseUrl ?? "http://localhost:3000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    launchOptions: process.env.UI_CRAWL_BROWSER_PATH
      ? { executablePath: process.env.UI_CRAWL_BROWSER_PATH }
      : undefined,
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "pnpm dev",
        port: 3000,
        reuseExistingServer: true,
      },
});
