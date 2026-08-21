import { describe, expect, it } from "vitest";
import {
  getRealAuthE2eConfig,
  isolatedAuthE2eEmail,
  isolatedAuthE2ePassword,
} from "../../../e2e/auth-e2e-config";

const valid = {
  AUTH_E2E_ENABLED: "1",
  AUTH_E2E_BASE_URL: "https://terroir-web-staging.example",
  AUTH_E2E_MAILBOX_URL: "https://mailpit-staging.example",
  AUTH_E2E_SUPABASE_URL: "https://staging-project.supabase.co",
  AUTH_E2E_PRODUCTION_SUPABASE_URL_PATTERN: "production-project",
  AUTH_E2E_SERVICE_ROLE_KEY: "test-only-service-role",
  AUTH_E2E_EMAIL_DOMAIN: "auth-e2e.example.test",
  AUTH_E2E_RUN_ID: "github-run-12345678",
};

describe("real auth E2E configuration", () => {
  it("does nothing until explicitly enabled", () => {
    expect(getRealAuthE2eConfig({})).toBeNull();
  });

  it("accepts only an isolated staging contract and generates an email fixture", () => {
    const config = getRealAuthE2eConfig(valid);
    expect(config).toMatchObject({
      baseUrl: "https://terroir-web-staging.example",
      mailboxUrl: "https://mailpit-staging.example",
    });
    expect(isolatedAuthE2eEmail(config!, "auth")).toBe(
      "terroir-auth-github-run-12345678@auth-e2e.example.test",
    );
  });

  it("keeps maximum-length run identifiers within the email local-part limit", () => {
    const config = getRealAuthE2eConfig({
      ...valid,
      AUTH_E2E_RUN_ID: "a".repeat(80),
    })!;
    const email = isolatedAuthE2eEmail(config, `auth-${Date.now()}`);
    const [localPart] = email.split("@");

    expect(localPart.length).toBeLessThanOrEqual(64);
    expect(isolatedAuthE2eEmail(config, "auth-fixed")).toBe(
      isolatedAuthE2eEmail(config, "auth-fixed"),
    );
    const firstPassword = isolatedAuthE2ePassword("first");
    const secondPassword = isolatedAuthE2ePassword("second");
    const repeatedPurposePassword = isolatedAuthE2ePassword("first");
    expect(firstPassword.length).toBeLessThanOrEqual(72);
    expect(secondPassword.length).toBeLessThanOrEqual(72);
    expect(firstPassword).not.toBe(secondPassword);
    expect(firstPassword).not.toBe(repeatedPurposePassword);
    expect(firstPassword).toMatch(/[A-Z]/);
    expect(firstPassword).toMatch(/[a-z]/);
    expect(firstPassword).toMatch(/[0-9]/);
    expect(firstPassword).toMatch(/[^A-Za-z0-9]/);
  });

  it.each([
    { ...valid, AUTH_E2E_BASE_URL: "https://terroir.example" },
    { ...valid, AUTH_E2E_BASE_URL: "http://terroir-staging.example" },
    { ...valid, AUTH_E2E_EMAIL_DOMAIN: "not a domain" },
    { ...valid, AUTH_E2E_RUN_ID: "short" },
  ])("rejects a target or fixture identity that is not safely isolated", (env) => {
    expect(() => getRealAuthE2eConfig(env)).toThrow();
  });
});
