import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  extractAuthEmailLink,
  getRealAuthE2eConfig,
  isolatedAuthE2eEmail,
  waitForMailpitEmail,
  type RealAuthE2eConfig,
} from "./auth-e2e-config";

const config = getRealAuthE2eConfig();

test.skip(
  !config,
  "Real auth E2E is opt-in: configure the isolated staging and Mailpit contract.",
);

test.describe("real Supabase email authentication", () => {
  test.setTimeout(180_000);

  test("signup, password login, reset, and magic link use only a generated fixture", async ({
    page,
  }) => {
    if (!config) throw new Error("Missing real auth E2E configuration.");

    const email = isolatedAuthE2eEmail(config, `auth-${Date.now()}`);
    const initialPassword = `Terroir-${config.runId}-first!`;
    const replacementPassword = `Terroir-${config.runId}-second!`;
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));

    try {
      await page.goto("/login?mode=signup");
      await page.getByLabel("Work email").fill(email);
      await page.getByLabel("Password").fill(initialPassword);
      await page.getByLabel("Confirm password").fill(initialPassword);
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page.getByText("Check your inbox to continue creating your account.")).toBeVisible();

      const signupMail = await waitForMailpitEmail(config, email);
      const signupLink = extractAuthEmailLink(signupMail);
      await page.goto(signupLink);
      await expect(page).toHaveURL(new RegExp(`^${escapeForRegExp(config.baseUrl)}`));
      expect(await page.context().cookies(config.baseUrl)).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining("auth-token") })]),
      );

      await signOut(page);
      await page.goto("/login?mode=password");
      await page.getByLabel("Work email").fill(email);
      await page.getByLabel("Password").fill(initialPassword);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect
        .poll(() => page.context().cookies(config.baseUrl))
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining("auth-token") })]));

      await signOut(page);
      await page.goto("/login?forgot=1");
      await page.getByLabel("Work email").fill(email);
      await page.getByRole("button", { name: "Send reset link" }).click();
      await expect(page.getByText("If that email is registered")).toBeVisible();

      const resetMail = await waitForMailpitEmail(config, email);
      await page.goto(extractAuthEmailLink(resetMail));
      await expect(page).toHaveURL(`${config.baseUrl}/auth/reset-password`);
      await page.getByLabel("New password").fill(replacementPassword);
      await page.getByLabel("Confirm password").fill(replacementPassword);
      await page.getByRole("button", { name: "Save password" }).click();
      await expect(page.getByText("Password updated.")).toBeVisible();

      await page.goto("/login?mode=password");
      await page.getByLabel("Work email").fill(email);
      await page.getByLabel("Password").fill(replacementPassword);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect
        .poll(() => page.context().cookies(config.baseUrl))
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining("auth-token") })]));

      await signOut(page);
      await page.goto("/login");
      await page.getByLabel("Work email").fill(email);
      await page.getByRole("button", { name: "Send magic link" }).click();
      const magicMail = await waitForMailpitEmail(config, email);
      await page.goto(extractAuthEmailLink(magicMail));
      await expect
        .poll(() => page.context().cookies(config.baseUrl))
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining("auth-token") })]));

      expect(browserErrors).toEqual([]);
    } finally {
      await deleteFixtureUser(config, email);
    }
  });
});

async function signOut(page: Page) {
  await page.request.post("/auth/signout", { maxRedirects: 0 });
  await expect
    .poll(async () => (await page.context().cookies()).filter((cookie) => cookie.name.includes("auth-token")))
    .toEqual([]);
}

async function deleteFixtureUser(
  config: RealAuthE2eConfig,
  email: string,
): Promise<void> {
  const admin = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Unable to list the isolated auth fixture: ${error.message}`);
    const user = data.users.find((candidate) => candidate.email === email);
    if (!user) {
      if (data.users.length < 1000) return;
      continue;
    }
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteError) throw new Error(`Unable to delete the isolated auth fixture: ${deleteError.message}`);
    return;
  }
  throw new Error("Isolated auth fixture was not found in the staging user pages.");
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
