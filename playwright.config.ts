import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.UI_CRAWL_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: externalBaseUrl ?? "http://localhost:3000",
    screenshot: "only-on-failure",
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
