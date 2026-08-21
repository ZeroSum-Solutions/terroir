import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const devEmail = process.env.DEV_BYPASS_EMAIL;
const localSeedPassword =
  process.env.LOCAL_SEED_USER_PASSWORD ?? "Terroir-local-123!";
const hasLocalFixtureCredentials = Boolean(
  supabaseUrl &&
    publishableKey &&
    serviceRoleKey &&
    devEmail &&
    ["localhost", "127.0.0.1"].includes(new URL(supabaseUrl).hostname),
);

test.describe("team mobile cards", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !hasLocalFixtureCredentials,
    "Requires localhost Supabase public/service credentials and DEV_BYPASS_EMAIL.",
  );

  const invitationEmail = `team-mobile-${Date.now()}@example.com`;
  let invitationId = "";
  let devRole = "";

  test.beforeAll(async () => {
    const admin = localAdminClient();
    const identity = await resolveDevIdentity();
    devRole = identity.role;
    if (devRole !== "owner") return;

    const { data, error } = await admin
      .from("invitations")
      .insert({
        restaurant_id: identity.restaurantId,
        email: invitationEmail,
        role: "staff",
        invited_by: identity.userId,
      })
      .select("id")
      .single();
    if (error) throw error;
    invitationId = data.id;
  });

  test.afterAll(async () => {
    if (!invitationId) return;
    const { error } = await localAdminClient()
      .from("invitations")
      .delete()
      .eq("id", invitationId);
    if (error) {
      throw new Error(`Team mobile fixture cleanup failed: ${error.message}`);
    }
  });

  test("team cards fit at 390px and retain pending actions", async ({ page }) => {
    test.skip(devRole !== "owner", "Requires an owner local fixture user.");
    await page.setViewportSize({ width: 390, height: 844 });
    await loginWithLocalFixture(page);
    await page.goto("/team");

    await expect(page.getByRole("heading", { name: /Members/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Pending/ })).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: `Copy invite link for ${invitationEmail}`,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: `Revoke invitation for ${invitationEmail}`,
      }),
    ).toBeVisible();

    const createInvite = page.getByRole("button", {
      name: "Create invite link",
    });
    await expect(createInvite).toBeVisible();
    expect(await controlHeight(createInvite)).toBeGreaterThanOrEqual(44);

    const toolbar = page.locator('[data-testid="team-toolbar"]');
    expect(
      await toolbar.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});

function localAdminClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Local Supabase fixture credentials are unavailable.");
  }
  const hostname = new URL(supabaseUrl).hostname;
  if (!["localhost", "127.0.0.1"].includes(hostname)) {
    throw new Error(`Refusing to write team fixtures to ${hostname}.`);
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

async function resolveDevIdentity() {
  if (!devEmail) throw new Error("DEV_BYPASS_EMAIL is unavailable.");
  if (!supabaseUrl || !publishableKey) {
    throw new Error("Local Supabase public credentials are unavailable.");
  }
  const userClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: session, error: signInError } =
    await userClient.auth.signInWithPassword({
      email: devEmail,
      password: localSeedPassword,
    });
  if (signInError) throw signInError;

  const admin = localAdminClient();
  const { data, error } = await admin
    .from("memberships")
    .select("restaurant_id, role")
    .eq("user_id", session.user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (error) throw error;
  return {
    userId: session.user.id,
    restaurantId: data.restaurant_id,
    role: data.role,
  };
}

async function loginWithLocalFixture(page: Page) {
  const response = await page.request.get("/api/dev-login");
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function controlHeight(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((node) => node.getBoundingClientRect().height);
}
