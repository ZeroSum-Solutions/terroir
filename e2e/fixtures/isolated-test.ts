import {
  expect,
  test as base,
  type Page,
  type TestInfo,
} from "@playwright/test";
import {
  buildFixtureIdentity,
  readIsolatedE2eConfig,
  type IsolatedE2eConfig,
} from "./config";
import {
  cleanupIsolatedFixture,
  injectFixtureSession,
  provisionIsolatedFixture,
  type IsolatedFixture,
} from "./isolated-fixture";

type IsolatedFixtures = {
  isolatedConfig: IsolatedE2eConfig;
  isolatedFixture: IsolatedFixture;
  runtimeFailureCapture: void;
};

export const test = base.extend<IsolatedFixtures>({
  isolatedConfig: async ({}, applyFixture) => {
    const config = readIsolatedE2eConfig();
    if (!config) {
      throw new Error(
        "TERROIR_E2E_ENABLED=1 is required for the isolated E2E fixture.",
      );
    }
    await applyFixture(config);
  },

  isolatedFixture: async (
    { isolatedConfig, page },
    applyFixture,
    testInfo,
  ) => {
    const testSlot = `${testInfo.file}:${testInfo.title}`;
    const identity = buildFixtureIdentity(
      isolatedConfig.runId,
      testSlot,
      testInfo.parallelIndex,
    );
    const fixture = await provisionIsolatedFixture(isolatedConfig, identity);
    try {
      await injectFixtureSession(page.context(), isolatedConfig, fixture);
      await applyFixture(fixture);
    } finally {
      await cleanupIsolatedFixture(isolatedConfig, identity);
    }
  },

  runtimeFailureCapture: [
    async ({ page }, applyFixture, testInfo) => {
      const capture = observePage(page, testInfo);
      try {
        await applyFixture();
      } finally {
        await capture.finish();
      }
    },
    { auto: true },
  ],
});

export { expect };

function observePage(page: Page, testInfo: TestInfo) {
  const consoleMessages: Array<{ text: string; type: string }> = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const network: Array<Record<string, unknown>> = [];
  const networkFailures: string[] = [];
  const serverErrors: Array<Record<string, unknown>> = [];

  page.on("console", (message) => {
    consoleMessages.push({ text: message.text(), type: message.type() });
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "request failed";
    const record = {
      failure,
      method: request.method(),
      path: safePath(request.url()),
      status: null,
    };
    network.push(record);
    networkFailures.push(`${record.method} ${record.path}: ${failure}`);
  });
  page.on("response", (response) => {
    const record = {
      method: response.request().method(),
      path: safePath(response.url()),
      status: response.status(),
    };
    network.push(record);
    if (response.status() >= 500) serverErrors.push(record);
  });

  return {
    async finish() {
      await Promise.all([
        attachJson(testInfo, "console.json", consoleMessages),
        attachJson(testInfo, "network.json", network),
        attachJson(testInfo, "page-errors.json", pageErrors),
        attachJson(testInfo, "unexpected-5xx.json", serverErrors),
      ]);

      const failures = [
        ...consoleErrors.map((message) => `console: ${message}`),
        ...pageErrors.map((message) => `page: ${message}`),
        ...networkFailures.map((message) => `network: ${message}`),
        ...serverErrors.map(
          (record) => `server: ${record.status} ${record.method} ${record.path}`,
        ),
      ];
      expect(failures, "browser runtime must not emit errors or 5xx responses").toEqual([]);
    },
  };
}

async function attachJson(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json",
  });
}

function safePath(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}
