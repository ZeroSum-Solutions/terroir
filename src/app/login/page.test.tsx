import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import LoginPage from "./page";

async function render(searchParams: Record<string, string> = {}) {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEV_BYPASS_EMAIL", "");
  return renderToStaticMarkup(
    await LoginPage({ searchParams: Promise.resolve(searchParams) }),
  );
}

describe("login choices", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("offers magic-link, password, signup, and recovery choices", async () => {
    const html = await render();
    expect(html).toContain("Send magic link");
    expect(html).toContain("Sign in with password");
    expect(html).toContain("Create an account");
    expect(html).toContain("Forgot password?");
  });

  it("renders an accessible password sign-in form", async () => {
    const html = await render({ mode: "password" });
    expect(html).toContain("autoComplete=\"current-password\"");
    expect(html).toContain("Sign in with a magic link");
  });

  it("renders password confirmation for account creation", async () => {
    const html = await render({ mode: "signup" });
    expect(html).toContain("Confirm password");
    expect(html).toContain("Create account");
  });
});
