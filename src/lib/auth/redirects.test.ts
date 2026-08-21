import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_LINK_ERROR,
  appUrl,
  authCallbackUrl,
  authErrorMessage,
  getAppOrigin,
  loginUrl,
} from "./redirects";

describe("authentication redirect configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses an explicit localhost default outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(getAppOrigin()).toBe("http://localhost:3000");
    expect(authCallbackUrl("/cellar?section=reds")).toBe(
      "http://localhost:3000/auth/callback?next=%2Fcellar%3Fsection%3Dreds",
    );
  });

  it("requires a configured HTTPS origin in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(() => getAppOrigin()).toThrow("NEXT_PUBLIC_APP_URL must be set");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://staging.terroir.example");
    expect(() => getAppOrigin()).toThrow("must use HTTPS");
  });

  it("rejects credentials, paths, queries, and fragments in the app origin", () => {
    vi.stubEnv("NODE_ENV", "test");
    for (const value of [
      "https://user:password@staging.terroir.example",
      "https://staging.terroir.example/app",
      "https://staging.terroir.example?preview=1",
      "https://staging.terroir.example#fragment",
    ]) {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", value);
      expect(() => getAppOrigin()).toThrow("must be an origin");
    }
  });

  it("uses the configured origin and rejects an open redirect", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://staging.terroir.example");
    expect(appUrl("/cellar").toString()).toBe(
      "https://staging.terroir.example/cellar",
    );
    expect(authCallbackUrl("//evil.example")).toBe(
      "https://staging.terroir.example/auth/callback?next=%2F",
    );
    expect(loginUrl({ error: AUTH_LINK_ERROR })).toBe(
      "https://staging.terroir.example/login?error=link",
    );
  });

  it("maps only known error codes to user-facing messages", () => {
    expect(authErrorMessage(AUTH_LINK_ERROR)).toContain("invalid or has expired");
    expect(authErrorMessage("provider-secret-detail")).toBeUndefined();
  });
});
