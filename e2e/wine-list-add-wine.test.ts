/**
 * LIST-06 — completing an add-wine and seeing the row.
 *
 * `mobile-list-editor.test.ts` opens the add-wine modal and cancels; nothing in
 * the suite had ever completed an add, which is why "wines added to a wine list
 * don't register" survived. This drives the whole flow: search inventory, pick
 * a wine, submit, and assert the row is on screen without a reload.
 *
 * Fixtures are created and torn down by this spec so it does not depend on, or
 * disturb, the seeded lists other suites read.
 */
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

test.describe("adding a wine to a list", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !hasLocalFixtureCredentials,
    "Requires localhost Supabase credentials and DEV_BYPASS_EMAIL.",
  );

  const RUN = Date.now().toString();
  const PRODUCER = `E2E Domaine ${RUN}`;
  const WINE_NAME = "Add Registers";

  let listId = "";
  let wineId = "";

  test.beforeAll(async () => {
    const admin = localAdminClient();
    const restaurantId = await resolveRestaurantId();

    // A red with a retail median, so LIST-03's suggestion is computable and the
    // row cannot render "—" for a reason unrelated to the add.
    const { data: wine, error: wineError } = await admin
      .from("wines")
      .insert({
        restaurant_id: restaurantId,
        producer: PRODUCER,
        name: WINE_NAME,
        vintage: 2019,
        varietal: "Pinot Noir",
        region: "Burgundy",
        colour: "red",
        size_ml: 750,
        retail_median: 65,
      })
      .select("id")
      .single();
    if (wineError) throw wineError;
    wineId = wine.id;

    const { data: list, error: listError } = await admin
      .from("wine_lists")
      .insert({
        restaurant_id: restaurantId,
        name: `Add-wine E2E ${RUN}`,
        template: "classic",
      })
      .select("id")
      .single();
    if (listError) throw listError;
    listId = list.id;

    // Two sections, Sparkling first: the wine is a red, so a correct add has to
    // move the editor to a section the user was not looking at.
    const { error: sectionError } = await admin
      .from("wine_list_sections")
      .insert([
        { wine_list_id: listId, name: "Sparkling", position: 0 },
        { wine_list_id: listId, name: "Red", position: 1 },
      ]);
    if (sectionError) throw sectionError;
  });

  test.afterAll(async () => {
    const admin = localAdminClient();
    const errors: Error[] = [];
    if (listId) {
      const { error } = await admin.from("wine_lists").delete().eq("id", listId);
      if (error) errors.push(new Error(`list cleanup failed: ${error.message}`));
    }
    if (wineId) {
      const { error } = await admin.from("wines").delete().eq("id", wineId);
      if (error) errors.push(new Error(`wine cleanup failed: ${error.message}`));
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "add-wine E2E cleanup failed");
    }
  });

  test("the wine appears in its section straight away", async ({ page }) => {
    await login(page);
    await page.goto(`/lists/${listId}`);

    await expect(
      page.getByRole("heading", { name: "Sparkling", exact: true }),
    ).toBeVisible();
    await page.locator("main button").filter({ hasText: "Add wine" }).first().click();

    const dialog = page.getByRole("dialog", { name: /Add wine to/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Search wines" }).fill(PRODUCER);
    await dialog
      .getByRole("button", { name: new RegExp(`${PRODUCER}, ${WINE_NAME}`) })
      .click();

    // LIST-06 cause B: the destination is the wine's own section, and the modal
    // says so rather than naming whatever was on screen.
    await expect(dialog.getByRole("heading", { name: "Add wine to Red" })).toBeVisible();
    await dialog.getByRole("button", { name: "Add to Red" }).click();

    // LIST-06 cause A: the row is on screen with no reload.
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Added ${PRODUCER}, ${WINE_NAME} to Red.`)).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Remove ${WINE_NAME}` }).first(),
    ).toBeVisible();
    await expect(page.locator("main")).toContainText(WINE_NAME);

    // And it survives a reload, which is what proves the write landed too.
    await page.reload();
    await page.locator("aside").getByRole("button", { name: /^Red\b/ }).click();
    await expect(page.locator("main")).toContainText(WINE_NAME);
  });
});

function localAdminClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Local Supabase fixture credentials are unavailable.");
  }
  const hostname = new URL(supabaseUrl).hostname;
  if (!["localhost", "127.0.0.1"].includes(hostname)) {
    throw new Error(`Refusing to write add-wine fixtures to ${hostname}.`);
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

async function login(page: Page) {
  const response = await page.request.get("/api/dev-login");
  expect(response.ok(), await response.text()).toBeTruthy();
}
