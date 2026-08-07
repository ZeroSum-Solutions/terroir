import { describe, expect, it } from "vitest";
import { assertDeploymentConfiguration, inspectRuntimeConfiguration } from "./runtime";

const core = {
  NODE_ENV: "test",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  ACTIVE_RESTAURANT_COOKIE_SECRET: "at-least-sixteen-chars",
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
      expect(String(error)).toContain("NEXT_PUBLIC_SUPABASE_URL (valid URL)");
    }
  });

  it("marks optional providers as degraded without treating them as a core deployment failure", () => {
    const config = assertDeploymentConfiguration(core);
    expect(config).toMatchObject({
      core: "configured",
      integrations: { invoice_scanning: "degraded", wine_search: "degraded", email: "not_configured", worker: "not_configured" },
    });
  });

  it("requires an all-or-nothing emergency auth bypass", () => {
    const config = inspectRuntimeConfiguration({ ...core, TEMP_AUTH_BYPASS_EMAIL: "operator@example.test" });
    expect(config.configurationErrors).toEqual(["TEMP_AUTH_BYPASS_* must be configured together or left unset"]);
    expect(() => assertDeploymentConfiguration({ ...core, TEMP_AUTH_BYPASS_EMAIL: "operator@example.test" })).toThrow("TEMP_AUTH_BYPASS_*");
  });
});
