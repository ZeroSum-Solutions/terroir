import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_VARIABLES,
  assertDeploymentConfiguration,
} from "./runtime";

const core = {
  NODE_ENV: "test",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  ACTIVE_RESTAURANT_COOKIE_SECRET: "at-least-sixteen-chars",
  NEXT_PUBLIC_APP_URL: "https://terroir.example.test",
} as const;

describe("runtime configuration", () => {
  it("fails deployment validation with variable names, never values", () => {
    const secret = "do-not-disclose-this-value";
    expect(() => assertDeploymentConfiguration({ ...core, SUPABASE_SERVICE_ROLE_KEY: secret, ACTIVE_RESTAURANT_COOKIE_SECRET: "too-short" }))
      .toThrow("ACTIVE_RESTAURANT_COOKIE_SECRET");
    try {
      assertDeploymentConfiguration({ ...core, NEXT_PUBLIC_SUPABASE_URL: "not a URL", SUPABASE_SERVICE_ROLE_KEY: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain("NEXT_PUBLIC_SUPABASE_URL (invalid)");
    }
  });

  it("marks optional providers as degraded without treating them as a core deployment failure", () => {
    const config = assertDeploymentConfiguration(core);
    expect(config).toMatchObject({
      core: "configured",
      integrations: { invoice_scanning: "degraded", wine_search: "degraded", email: "not_configured", worker: "not_configured" },
    });
  });

  it("fails on malformed optional values without exposing them", () => {
    const malformedDsn = "not-a-private-dsn";
    expect(() =>
      assertDeploymentConfiguration({
        ...core,
        SENTRY_DSN: malformedDsn,
        SENTRY_TRACES_SAMPLE: "2",
      }),
    ).toThrow("SENTRY_DSN (invalid), SENTRY_TRACES_SAMPLE (invalid)");
    try {
      assertDeploymentConfiguration({ ...core, SENTRY_DSN: malformedDsn });
    } catch (error) {
      expect(String(error)).not.toContain(malformedDsn);
    }
  });

  it("requires an HTTPS public app origin in production", () => {
    expect(() =>
      assertDeploymentConfiguration({
        ...core,
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "http://terroir.example.test",
      }),
    ).toThrow("NEXT_PUBLIC_APP_URL (HTTPS required in production)");
  });

  it("documents every app-owned runtime variable", () => {
    const example = readFileSync(".env.example", "utf8");
    for (const name of RUNTIME_VARIABLES) {
      expect(example, `${name} must appear in .env.example`).toMatch(
        new RegExp(`^${name}=`, "m"),
      );
    }
  });
});
