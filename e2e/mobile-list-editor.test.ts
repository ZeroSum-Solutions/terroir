import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const devEmail = process.env.DEV_BYPASS_EMAIL;
const hasLocalFixtureCredentials = Boolean(
  supabaseUrl &&
    serviceRoleKey &&
    devEmail &&
    ["localhost", "127.0.0.1"].includes(new URL(supabaseUrl).hostname),
);

test.describe("mobile wine-list editor", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !hasLocalFixtureCredentials,
    "Requires localhost Supabase credentials and DEV_BYPASS_EMAIL.",
  );

  let listId = "";

  test.beforeAll(async () => {
    const admin = localAdminClient();
    const restaurantId = await resolveRestaurantId();
    const { data: list, error: listError } = await admin
      .from("wine_lists")
      .insert({
        restaurant_id: restaurantId,
        name: `Mobile editor E2E ${Date.now()}`,
        template: "classic",
      })
      .select("id")
      .single();
    if (listError) throw listError;
    listId = list.id;

    const { error: sectionError } = await admin
      .from("wine_list_sections")
      .insert({
        wine_list_id: listId,
        name: "Reds",
        position: 0,
      });
    if (sectionError) throw sectionError;
  });

  test.afterAll(async () => {
    if (!listId) return;
    const { error } = await localAdminClient()
      .from("wine_lists")
      .delete()
      .eq("id", listId);
    if (error) throw new Error(`Mobile editor fixture cleanup failed: ${error.message}`);
  });

  test("essential editor actions stay reachable at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginWithLocalFixture(page);
    await page.goto(`/lists/${listId}`);

    const mobile = page.locator('[data-testid="mobile-list-controls"]:visible');
    await expect(mobile).toBeVisible();
    await expect(mobile.getByRole("button", { name: "Add section" })).toBeVisible();
    await expect(mobile.getByRole("button", { name: /Rename/ })).toBeVisible();
    await expect(mobile.getByRole("button", { name: /Delete/ })).toBeVisible();
    await expect(mobile.getByText("Template", { exact: true })).toBeVisible();

    for (const label of [
      "Download PDF",
      "Toast Export",
      "CSV",
      "Preview",
      "Print",
      "Publish",
    ]) {
      const action = mobile
        .getByRole("button", { name: label, exact: true })
        .or(mobile.getByRole("link", { name: label, exact: true }))
        .first();
      await expect(action).toBeVisible();
      expect(await controlHeight(action)).toBeGreaterThanOrEqual(44);
    }

    for (const control of [
      mobile.getByRole("button", { name: "Add section" }),
      mobile.getByRole("button", { name: /Rename/ }),
      mobile.getByRole("button", { name: /Delete/ }),
      mobile.getByRole("button", { name: "Classic" }),
    ]) {
      expect(await controlHeight(control)).toBeGreaterThanOrEqual(44);
    }

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
    throw new Error(`Refusing to write mobile editor fixtures to ${hostname}.`);
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

async function resolveRestaurantId() {
  if (!devEmail) throw new Error("DEV_BYPASS_EMAIL is unavailable.");
  const admin = localAdminClient();
  const { data: users, error: userError } = await admin.auth.admin.listUsers({
    perPage: 200,
  });
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
  return data.restaurant_id;
}

async function loginWithLocalFixture(page: Page) {
  const response = await page.request.get("/api/dev-login");
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function controlHeight(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((node) => node.getBoundingClientRect().height);
}
