import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { makeScan } from "../src/test/fixtures/invoices/scans";
import { extractAuthEmailLink, waitForMailpitEmail } from "./auth-e2e-config";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const devEmail = process.env.DEV_BYPASS_EMAIL;
const hasLocalFixtureCredentials = Boolean(
  supabaseUrl &&
    publishableKey &&
    serviceRoleKey &&
    devEmail &&
    ["localhost", "127.0.0.1"].includes(new URL(supabaseUrl).hostname),
);

test.describe("mobile demo critical journeys", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !hasLocalFixtureCredentials,
    "Requires localhost Supabase credentials and DEV_BYPASS_EMAIL.",
  );

  test("invoice upload reaches review and save confirmation at 390px", async ({ page }) => {
    const scan = makeScan();
    let scanRequests = 0;
    let saveRequests = 0;
    await page.route("**/api/scan", async (route) => {
      scanRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scan) });
    });
    await page.route("**/api/inventory/save-scan", async (route) => {
      saveRequests += 1;
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ scanId: "e2e-scan", itemCount: 2, wineCount: 2 }),
      });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await loginWithLocalFixture(page);
    const seededImage = await page.request.get(
      "/api/scans/de100004-0000-4000-8000-000000000001/image",
    );
    expect(seededImage.status(), await seededImage.text()).toBe(200);
    await page.goto("/scan/de100004-0000-4000-8000-000000000001");
    await expect(page.getByRole("heading", { name: "Review scan" })).toBeVisible();
    await expect(page.getByLabel("Wine name").first()).toHaveValue(
      "Burgundy Pinot Noir Lot 001",
    );
    await expect(page.getByText("14 bottles", { exact: true })).toBeVisible();
    await page.goto("/scan");
    await page.evaluate(() => localStorage.removeItem("terroir:current-scan"));
    await page.reload();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload file" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "demo-invoice.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });

    await expect(page.getByRole("heading", { name: "Invoice scan results" })).toBeVisible();
    await expect(page.getByLabel("Supplier")).toHaveValue("Test Distributor");
    await expect(page.getByLabel("Producer").first()).toHaveValue("Domaine Drouhin");
    const save = page.getByRole("button", { name: "Save to Inventory" });
    expect(await controlHeight(save)).toBeGreaterThanOrEqual(44);
    await save.click();
    await expect(page.getByRole("status")).toContainText(
      "Saved 2 items to inventory (2 distinct wines)",
    );
    expect(scanRequests).toBe(1);
    expect(saveRequests).toBe(1);
    await expectNoDocumentOverflow(page);
  });

  test("draft publishes publicly and unpublishes through the UI at 390px", async ({ page }) => {
    const admin = localAdminClient();
    const identity = await resolveDevIdentity();
    const run = Date.now();
    const listName = `Mobile publish E2E ${run}`;
    const slug = `mobile-publish-e2e-${run}`;
    const { data: list, error } = await admin
      .from("wine_lists")
      .insert({ restaurant_id: identity.restaurantId, name: listName, template: "classic" })
      .select("id")
      .single();
    if (error) throw error;

    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await loginWithLocalFixture(page);
      await page.goto(`/lists/${list.id}`);
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      const publishDialog = page.getByRole("dialog", { name: "Publish wine list" });
      await publishDialog.getByLabel("Public URL slug").fill(slug);
      await publishDialog.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Your wine list is live" })).toBeVisible();

      const publicResponse = await page.request.get(`/list/${slug}`);
      expect(publicResponse.status()).toBe(200);
      expect(await publicResponse.text()).toContain(listName);
      await page.goto(`/list/${slug}`);
      await expect(page.getByRole("heading", { name: listName })).toBeVisible();
      await expectNoDocumentOverflow(page);

      await page.goto(`/lists/${list.id}`);
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await page.getByRole("dialog", { name: "Your wine list is live" })
        .getByRole("button", { name: "Unpublish" })
        .click();
      await page.getByRole("dialog", { name: "Unpublish list" })
        .getByRole("button", { name: "Unpublish list" })
        .click();
      await expect(page.getByRole("heading", { name: "Publish wine list" })).toBeVisible();
      expect((await page.request.get(`/list/${slug}`)).status()).toBe(404);
    } finally {
      await admin.from("wine_lists").delete().eq("id", list.id);
    }
  });

  test("invited staff member signs in, accepts, and lands in Cellar at 390px", async ({ page }) => {
    test.setTimeout(60_000);
    const admin = localAdminClient();
    const identity = await resolveDevIdentity();
    const run = Date.now();
    const inviteeEmail = `mobile-invite-${run}@terroir.test`;
    const inviteePassword = "Terroir-e2e-Invite-123!";
    const { data: invitee, error: createUserError } = await admin.auth.admin.createUser({
      email: inviteeEmail,
      password: inviteePassword,
      email_confirm: true,
    });
    if (createUserError) throw createUserError;
    let invitationId = "";

    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await loginWithLocalFixture(page);
      const invitationResponse = await page.request.post("/api/team/invite", {
        data: { email: inviteeEmail, role: "staff" },
      });
      expect(invitationResponse.ok(), await invitationResponse.text()).toBeTruthy();
      const invitation = await invitationResponse.json() as {
        id: string;
        token: string;
        inviteUrl: string;
      };
      invitationId = invitation.id;
      const invitePath = new URL(invitation.inviteUrl).pathname;

      await page.context().clearCookies();
      await page.goto(
        `http://127.0.0.1:3000/login?mode=password&next=${encodeURIComponent(invitePath)}`,
      );
      await page.getByLabel("Work email").fill(inviteeEmail);
      await page.getByLabel("Password", { exact: true }).fill(inviteePassword);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL(`**${invitePath}`);
      await page.waitForURL("**/cellar", { timeout: 20_000 });
      await expect(page.getByRole("heading", { name: /cellar beyond/i })).toBeVisible();
      await expectNoDocumentOverflow(page);

      const { data: membership, error: membershipError } = await admin
        .from("memberships")
        .select("role")
        .eq("restaurant_id", identity.restaurantId)
        .eq("user_id", invitee.user.id)
        .single();
      if (membershipError) throw membershipError;
      expect(membership.role).toBe("staff");
      const { data: accepted, error: acceptedError } = await admin
        .from("invitations")
        .select("accepted_at")
        .eq("id", invitationId)
        .single();
      if (acceptedError) throw acceptedError;
      expect(accepted.accepted_at).toBeTruthy();
    } finally {
      await admin
        .from("memberships")
        .delete()
        .eq("restaurant_id", identity.restaurantId)
        .eq("user_id", invitee.user.id);
      if (invitationId) await admin.from("invitations").delete().eq("id", invitationId);
      await admin.auth.admin.deleteUser(invitee.user.id);
    }
  });

  test("password recovery, session refresh, and logout work at 390px", async ({ page }) => {
    test.setTimeout(60_000);
    const admin = localAdminClient();
    const identity = await resolveDevIdentity();
    const run = Date.now();
    const email = `mobile-recovery-${run}@terroir.test`;
    const initialPassword = "Terroir-e2e-Recovery-123!";
    const replacementPassword = "Terroir-e2e-Recovered-456!";
    const { data: fixture, error: createUserError } = await admin.auth.admin.createUser({
      email,
      password: initialPassword,
      email_confirm: true,
    });
    if (createUserError) throw createUserError;

    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("http://127.0.0.1:3000/login?forgot=1");
      await page.getByLabel("Work email").fill(email);
      await page.getByRole("button", { name: "Send reset link" }).click();
      await expect(page.getByText(/If that email is registered/i)).toBeVisible();

      const resetMail = await waitForMailpitEmail(
        {
          baseUrl: "http://localhost:3000",
          emailDomain: "terroir.test",
          // Mailpit lives on the committed local stack's 57324 (see
          // supabase/config.toml), not the supabase-cli default 54324 —
          // E2E_MAILBOX_URL (exported in ci.yml from `supabase status`)
          // wins so a port change never silently breaks this again.
          mailboxUrl: process.env.E2E_MAILBOX_URL ?? "http://127.0.0.1:57324",
          runId: String(run),
          supabaseUrl: supabaseUrl!,
          serviceRoleKey: serviceRoleKey!,
        },
        email,
      );
      await page.goto(extractAuthEmailLink(resetMail));
      await expect(page).toHaveURL("http://127.0.0.1:3000/auth/reset-password");
      await expectNoDocumentOverflow(page);
      await page.getByLabel("New password").fill(replacementPassword);
      await page.getByLabel("Confirm password").fill(replacementPassword);
      await page.getByRole("button", { name: "Save password" }).click();
      await expect(page.getByText("Password updated.")).toBeVisible();

      const { error: membershipError } = await admin.from("memberships").insert({
        user_id: fixture.user.id,
        restaurant_id: identity.restaurantId,
        role: "staff",
      });
      if (membershipError) throw membershipError;

      await page.goto("http://127.0.0.1:3000/login?mode=password");
      await page.getByLabel("Work email").fill(email);
      await page.getByLabel("Password", { exact: true }).fill(replacementPassword);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL("**/cellar");
      await page.reload();
      await expect(page.getByRole("heading", { name: /cellar beyond/i })).toBeVisible();

      const signOutResponse = await page.request.post(
        "http://127.0.0.1:3000/auth/signout",
        { maxRedirects: 0 },
      );
      expect(signOutResponse.status()).toBe(303);
      await page.goto("http://127.0.0.1:3000/login");
      await expect(page.getByRole("heading", { name: /Sign in/i })).toBeVisible();
      expect(
        (await page.context().cookies()).filter((cookie) => cookie.name.includes("auth-token")),
      ).toEqual([]);
    } finally {
      await admin
        .from("memberships")
        .delete()
        .eq("restaurant_id", identity.restaurantId)
        .eq("user_id", fixture.user.id);
      await admin.auth.admin.deleteUser(fixture.user.id);
    }
  });
});

function localAdminClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Local Supabase fixture credentials are unavailable.");
  }
  const hostname = new URL(supabaseUrl).hostname;
  if (!["localhost", "127.0.0.1"].includes(hostname)) {
    throw new Error(`Refusing to write demo fixtures to ${hostname}.`);
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

async function resolveDevIdentity() {
  if (!devEmail) throw new Error("DEV_BYPASS_EMAIL is unavailable.");
  const admin = localAdminClient();
  const { data: users, error: userError } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (userError) throw userError;
  const user = users.users.find((candidate) => candidate.email === devEmail);
  if (!user) throw new Error(`Dev user ${devEmail} not found.`);
  const { data, error } = await admin
    .from("memberships")
    .select("restaurant_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (error) throw error;
  return { userId: user.id, restaurantId: data.restaurant_id };
}

async function loginWithLocalFixture(page: Page) {
  const response = await page.request.get("/api/dev-login");
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function expectNoDocumentOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
}

async function controlHeight(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((node) => node.getBoundingClientRect().height);
}
