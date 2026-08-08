import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext } from "@playwright/test";
import { describe, expect, test } from "vitest";
import {
  buildFixtureIdentity,
  readIsolatedE2eConfig,
} from "../../../e2e/fixtures/config";
import {
  cleanupIsolatedFixture,
  injectFixtureSession,
} from "../../../e2e/fixtures/isolated-fixture";
import { redactBrowserEvidence } from "../../../e2e/fixtures/evidence";

const STAGING_REF = "wwhxcgtcecsftcivosop";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

function baseEnvironment(): Record<string, string> {
  const publishableKey = jwt({ ref: STAGING_REF, role: "anon" });
  const serviceRoleKey = jwt({ ref: STAGING_REF, role: "service_role" });
  return {
    TERROIR_E2E_ENABLED: "1",
    TERROIR_E2E_BASE_URL: "https://terroir-web-staging.up.railway.app",
    TERROIR_E2E_RUN_ID: "run-12345678",
    TERROIR_E2E_SUPABASE_URL: `https://${STAGING_REF}.supabase.co`,
    TERROIR_E2E_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    TERROIR_E2E_SUPABASE_PUBLISHABLE_KEY_SHA256: createHash("sha256")
      .update(publishableKey)
      .digest("hex"),
    TERROIR_E2E_SERVICE_ROLE_KEY: serviceRoleKey,
    TERROIR_E2E_SERVICE_ROLE_KEY_SHA256: createHash("sha256")
      .update(serviceRoleKey)
      .digest("hex"),
  };
}

describe("isolated E2E configuration", () => {
  test("accepts only the named staging application and Supabase project", () => {
    const config = readIsolatedE2eConfig(baseEnvironment());

    expect(config).toMatchObject({
      baseUrl: "https://terroir-web-staging.up.railway.app",
      runId: "run-12345678",
      stagingProjectRef: STAGING_REF,
      supabaseUrl: `https://${STAGING_REF}.supabase.co`,
    });
  });

  test.each([
    ["production application", { TERROIR_E2E_BASE_URL: "https://terroir-web-production.up.railway.app" }],
    ["production database", { TERROIR_E2E_SUPABASE_URL: "https://qcfmwphlaekfkqwkfyth.supabase.co" }],
    ["wrong service role", credentialOverride("TERROIR_E2E_SERVICE_ROLE_KEY", jwt({ ref: "qcfmwphlaekfkqwkfyth", role: "service_role" }))],
    ["anon key used as service role", credentialOverride("TERROIR_E2E_SERVICE_ROLE_KEY", jwt({ ref: STAGING_REF, role: "anon" }))],
  ])("rejects %s", (_label, overrides) => {
    expect(() =>
      readIsolatedE2eConfig({ ...baseEnvironment(), ...overrides }),
    ).toThrow();
  });

  test("rejects credentials whose value differs from the staging fingerprint", () => {
    const env = baseEnvironment();
    env.TERROIR_E2E_SUPABASE_PUBLISHABLE_KEY_SHA256 = "0".repeat(64);

    expect(() => readIsolatedE2eConfig(env)).toThrow(/fingerprint/i);
  });

  test("returns null unless the isolated suite is explicitly enabled", () => {
    expect(readIsolatedE2eConfig({})).toBeNull();
  });
});

describe("fixture identity isolation", () => {
  test("is stable for a retry of the same test slot", () => {
    const first = buildFixtureIdentity("run-12345678", "pour-flow", 2);
    const rerun = buildFixtureIdentity("run-12345678", "pour-flow", 2);

    expect(rerun).toEqual(first);
  });

  test("keeps parallel runs and workers in distinct namespaces", () => {
    const identities = [
      buildFixtureIdentity("run-12345678", "pour-flow", 0),
      buildFixtureIdentity("run-12345678", "pour-flow", 1),
      buildFixtureIdentity("run-87654321", "pour-flow", 0),
    ];

    expect(new Set(identities.map((value) => value.namespace))).toHaveLength(3);
    expect(new Set(identities.map((value) => value.restaurantId))).toHaveLength(3);
    expect(
      new Set(identities.map((value) => value.secondRestaurantId)),
    ).toHaveLength(3);
    expect(
      new Set(identities.map((value) => value.foreignRestaurantId)),
    ).toHaveLength(3);
    expect(new Set(identities.map((value) => value.email))).toHaveLength(3);
    expect(
      identities.every(
        (value) =>
          new Set([
            value.restaurantId,
            value.secondRestaurantId,
            value.foreignRestaurantId,
          ]).size === 3,
      ),
    ).toBe(true);
    expect(
      identities.every((value) =>
        value.storagePath.startsWith(`${value.restaurantId}/`),
      ),
    ).toBe(true);
  });

  test("refuses to delete a tenant without fixture provenance", async () => {
    const config = readIsolatedE2eConfig(baseEnvironment())!;
    const identity = buildFixtureIdentity(config.runId, "cleanup", 0);
    const unknownRestaurantId =
      "99999999-9999-4999-8999-999999999999";
    const deletedRestaurantIds: string[] = [];
    let deletedUser = false;
    const admin = {
      auth: {
        admin: {
          deleteUser: async () => {
            deletedUser = true;
            return { error: null };
          },
          listUsers: async () => ({
            data: {
              users: [{ email: identity.email, id: "fixture-user" }],
            },
            error: null,
          }),
        },
      },
      from: (table: string) => {
        if (table === "memberships") {
          return {
            select: () => ({
              eq: async () => ({
                data: [
                  {
                    restaurant_id: unknownRestaurantId,
                    restaurants: { name: "Unrelated staging tenant" },
                  },
                ],
                error: null,
              }),
            }),
          };
        }
        return {
          delete: () => ({
            eq: async (_column: string, restaurantId: string) => {
              deletedRestaurantIds.push(restaurantId);
              return { error: null };
            },
            in: async () => ({ error: null }),
          }),
        };
      },
      storage: {
        from: () => ({
          list: async () => ({ data: [], error: null }),
          remove: async () => ({ error: null }),
        }),
      },
    };

    await expect(
      cleanupIsolatedFixture(config, identity, admin as never),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: expect.stringMatching(/fixture provenance/i),
        }),
      ],
    });
    expect(deletedRestaurantIds).not.toContain(unknownRestaurantId);
    expect(deletedUser).toBe(false);
  });
});

describe("valid session injection", () => {
  test("rejects a forged production config before any provider request", async () => {
    const stagingConfig = readIsolatedE2eConfig(baseEnvironment())!;
    const identity = buildFixtureIdentity(stagingConfig.runId, "pour-flow", 0);
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      throw new Error("network must not be reached");
    };

    try {
      await expect(
        injectFixtureSession(
          { addCookies: async () => undefined } as never,
          {
            ...stagingConfig,
            supabaseUrl: "https://qcfmwphlaekfkqwkfyth.supabase.co",
          },
          {
            ...identity,
            password: "synthetic-password",
            userId: "10000000-0000-4000-8000-000000000001",
          },
        ),
      ).rejects.toThrow(/validated staging configuration/i);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestCount).toBe(0);
  });

  test("stores provider-issued SSR cookies in only the supplied browser context", async () => {
    const env = baseEnvironment();
    const config = readIsolatedE2eConfig(env)!;
    const identity = buildFixtureIdentity(config.runId, "pour-flow", 0);
    const addedCookies: Array<Record<string, unknown>> = [];
    const accessToken = jwt({
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      role: "authenticated",
      sub: "10000000-0000-4000-8000-000000000001",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      expect(String(input)).toContain("/auth/v1/token?grant_type=password");
      return new Response(
        JSON.stringify({
          access_token: accessToken,
          expires_in: 3600,
          refresh_token: "synthetic-refresh-token",
          token_type: "bearer",
          user: {
            aud: "authenticated",
            email: identity.email,
            id: "10000000-0000-4000-8000-000000000001",
            role: "authenticated",
          },
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 },
      );
    };

    try {
      await injectFixtureSession(
        {
          addCookies: async (
            cookies: Parameters<BrowserContext["addCookies"]>[0],
          ) => {
            addedCookies.push(...cookies);
          },
        } as never,
        config,
        {
          ...identity,
          password: "synthetic-password",
          userId: "10000000-0000-4000-8000-000000000001",
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(addedCookies).not.toHaveLength(0);
    expect(addedCookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expect.stringContaining("auth-token"),
          secure: true,
          url: config.baseUrl,
        }),
      ]),
    );
  });
});

describe("fixture helper shipping boundary", () => {
  test("application and real-auth sources cannot import the shortcut", () => {
    const repositoryRoot = process.cwd();
    const fixtureImport = /fixtures\/(?:isolated-fixture|isolated-test)/;
    const sourceFiles = walk(path.join(repositoryRoot, "src"));
    const applicationFiles = sourceFiles.filter(
      (file) => !/\.test\.[cm]?[jt]sx?$/.test(file),
    );
    const authSource = fs.readFileSync(
      path.join(repositoryRoot, "e2e/auth-real-provider.test.ts"),
      "utf8",
    );

    expect(applicationFiles.filter((file) => fixtureImport.test(fs.readFileSync(file, "utf8")))).toEqual([]);
    expect(authSource).not.toMatch(fixtureImport);
    expect(
      sourceFiles.filter(
        (file) => file.includes(`${path.sep}app${path.sep}api${path.sep}`)
          && /(?:^|[/\\])(?:e2e-)?fixtures?(?:[/\\]|\.)/i.test(file),
      ),
    ).toEqual([]);
  });
});

describe("failure evidence redaction", () => {
  test("removes bearer, Supabase, JWT, and auth-query credentials", () => {
    const message = [
      "Bearer top-secret-token",
      "sb_secret_stagingvalue",
      jwt({ sub: "fixture-user" }),
      "https://example.test/callback?token=magic-value&next=/cellar",
    ].join(" ");

    const redacted = redactBrowserEvidence(message);

    expect(redacted).not.toContain("top-secret-token");
    expect(redacted).not.toContain("stagingvalue");
    expect(redacted).not.toContain("fixture-user");
    expect(redacted).not.toContain("magic-value");
    expect(redacted).toContain("[redacted]");
  });

  test("keeps the forced-failure drill dispatch-only and uploads evidence", () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/staging-smoke.yml"),
      "utf8",
    );

    expect(workflow).toMatch(/force_evidence_failure:[\s\S]*?type: boolean/);
    expect(workflow).toMatch(/run_pdf_worker_pilot:[\s\S]*?type: boolean/);
    expect(workflow).toMatch(/run_cellar_pilot:[\s\S]*?type: boolean/);
    expect(workflow).toMatch(/run_wine_intelligence_pilot:[\s\S]*?type: boolean/);
    expect(workflow).toMatch(
      /run_wine_enrichment_worker_pilot:[\s\S]*?type: boolean/,
    );
    expect(workflow).toMatch(/run_bottle_scan_pilot:[\s\S]*?type: boolean/);
    expect(workflow).toMatch(/run_analytics_pilot:[\s\S]*?type: boolean/);
    expect(workflow).toMatch(
      /github\.event_name == 'workflow_dispatch' && inputs\.force_evidence_failure/,
    );
    expect(workflow).toContain("TERROIR_E2E_FORCE_FAILURE:");
    expect(workflow).toContain('PDF_WORKER_E2E_ENABLED: "1"');
    expect(workflow).toContain('CELLAR_E2E_ENABLED: "1"');
    expect(workflow).toContain('WINE_INTELLIGENCE_E2E_ENABLED: "1"');
    expect(workflow).toContain(
      'WINE_ENRICHMENT_WORKER_E2E_ENABLED: "1"',
    );
    expect(workflow).toContain('BOTTLE_SCAN_E2E_ENABLED: "1"');
    expect(workflow).toContain(
      "pnpm exec playwright test e2e/lists/pdf-worker.test.ts --workers=1",
    );
    expect(workflow).toContain("inputs.run_pdf_worker_pilot && matrix.slot == 1");
    expect(workflow).toContain(
      "pnpm exec playwright test e2e/cellar-staging.test.ts --workers=1",
    );
    expect(workflow).toContain("inputs.run_cellar_pilot && matrix.slot == 1");
    expect(workflow).toContain(
      "inputs.run_wine_intelligence_pilot && matrix.slot == 1",
    );
    expect(workflow).toContain(
      "pnpm exec playwright test e2e/wine-intelligence-staging.test.ts --workers=1 --trace=on",
    );
    expect(workflow).toContain(
      "pnpm exec playwright test e2e/wine-enrichment-worker.test.ts --workers=1 --trace=on",
    );
    expect(workflow).toContain(
      "pnpm exec playwright test e2e/bottle-scan.test.ts --workers=1 --trace=on",
    );
    expect(workflow).toContain(
      "inputs.run_bottle_scan_pilot && matrix.slot == 1",
    );
    expect(workflow).toContain(
      "inputs.run_wine_enrichment_worker_pilot && matrix.slot == 1",
    );
    expect(workflow).toContain(
      "inputs.run_analytics_pilot && matrix.slot == 1",
    );
    expect(workflow).toContain(
      "pnpm exec playwright test e2e/analytics-staging.test.ts --workers=1 --trace=on",
    );
    expect(workflow).toContain("group: staging-smoke-staging");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 25");
    expect(workflow).toContain(
      "TERROIR_E2E_BROWSER_PATH: /usr/bin/google-chrome",
    );
    expect(workflow).not.toContain("playwright install --with-deps");
    expect(workflow).toMatch(
      /Run the PDF worker browser and load pilot[\s\S]*?inputs\.run_pdf_worker_pilot && matrix\.slot == 1[\s\S]*?PDF_WORKER_E2E_ENABLED: "1"[\s\S]*?e2e\/lists\/pdf-worker\.test\.ts/,
    );
    expect(workflow).toMatch(
      /Run the isolated cellar pilot[\s\S]*?inputs\.run_cellar_pilot && matrix\.slot == 1[\s\S]*?CELLAR_E2E_ENABLED: "1"[\s\S]*?e2e\/cellar-staging\.test\.ts/,
    );
    expect(workflow).toMatch(
      /Run the isolated wine-intelligence pilot[\s\S]*?inputs\.run_wine_intelligence_pilot && matrix\.slot == 1[\s\S]*?WINE_INTELLIGENCE_E2E_ENABLED: "1"[\s\S]*?e2e\/wine-intelligence-staging\.test\.ts/,
    );
    expect(workflow).toMatch(
      /Run the isolated wine-enrichment worker pilot[\s\S]*?inputs\.run_wine_enrichment_worker_pilot && matrix\.slot == 1[\s\S]*?WINE_ENRICHMENT_WORKER_E2E_ENABLED: "1"[\s\S]*?e2e\/wine-enrichment-worker\.test\.ts/,
    );
    expect(workflow).toMatch(
      /Run the isolated bottle-scan pilot[\s\S]*?inputs\.run_bottle_scan_pilot && matrix\.slot == 1[\s\S]*?BOTTLE_SCAN_E2E_ENABLED: "1"[\s\S]*?e2e\/bottle-scan\.test\.ts/,
    );
    expect(workflow).toMatch(
      /Run the isolated analytics pilot[\s\S]*?inputs\.run_analytics_pilot && matrix\.slot == 1[\s\S]*?ANALYTICS_E2E_ENABLED: "1"[\s\S]*?e2e\/analytics-staging\.test\.ts/,
    );
    expect(workflow).toMatch(
      /Encrypt browser evidence[\s\S]*?id: encrypt_evidence[\s\S]*?rm -f "\$archive" "\$encrypted" "\$encrypted\.sha256"[\s\S]*?evidence_paths=\(\)[\s\S]*?No browser evidence directory was produced before failure[\s\S]*?age -r[\s\S]*?sha256sum "\$encrypted"[\s\S]*?rm -rf playwright-report test-results\/playwright/,
    );
    expect(workflow).toContain(
      "if: ${{ always() && steps.encrypt_evidence.outcome == 'success' }}",
    );
    expect(workflow).toContain(
      "test-results/isolated-e2e-${{ matrix.slot }}.tar.gz.age",
    );
  });

  test("retains trace and video only inside encrypted workflow evidence", () => {
    const config = fs.readFileSync(
      path.join(process.cwd(), "playwright.config.ts"),
      "utf8",
    );

    expect(config).toContain('trace: "retain-on-failure"');
    expect(config).toContain('video: "retain-on-failure"');
  });
});

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function credentialOverride(name: string, value: string): Record<string, string> {
  return {
    [name]: value,
    [`${name}_SHA256`]: createHash("sha256").update(value).digest("hex"),
  };
}
