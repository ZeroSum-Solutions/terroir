import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// G1-4 — CSV cellar import journey: upload -> preview -> confirm ->
// apply -> verify inventory -> revert. Runs against a local Supabase
// like the other live-fixture suites (demo-critical-journeys.test.ts) —
// not skipped in CI, only when local Supabase credentials aren't
// configured.

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const devEmail = process.env.DEV_BYPASS_EMAIL;
const hasLocalFixtureCredentials = Boolean(
  supabaseUrl &&
    serviceRoleKey &&
    devEmail &&
    ["localhost", "127.0.0.1"].includes(new URL(supabaseUrl).hostname),
);

function localAdminClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Local Supabase fixture credentials are unavailable.");
  }
  return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
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
  return { userId: user.id, restaurantId: (data as { restaurant_id: string }).restaurant_id };
}

async function loginWithLocalFixture(page: Page) {
  const response = await page.request.get("/api/dev-login");
  expect(response.ok(), await response.text()).toBeTruthy();
}

test.describe("G1-4 CSV import journey", () => {
  test.skip(!hasLocalFixtureCredentials, "Requires localhost Supabase credentials and DEV_BYPASS_EMAIL.");
  test.describe.configure({ mode: "serial" });

  const run = Date.now();
  const producer = `E2E Import Producer ${run}`;
  const wineName = `E2E Import Wine ${run}`;
  const csv = `producer,name,vintage,quantity,unit_cost\n${producer},${wineName},2021,4,42.50\n`;

  let restaurantId: string;

  test.beforeAll(async () => {
    ({ restaurantId } = await resolveDevIdentity());
  });

  test.afterAll(async () => {
    const admin = localAdminClient();
    // Cascades via wine_id/restaurant_id — clean up whatever this run
    // created regardless of where the test stopped.
    const { data: wines } = await admin
      .from("wines")
      .select("id")
      .eq("restaurant_id", restaurantId)
      .eq("producer", producer);
    const wineIds = (wines ?? []).map((w) => (w as { id: string }).id);
    if (wineIds.length) {
      await admin.from("inventory_items").delete().in("wine_id", wineIds);
      await admin.from("wines").delete().in("id", wineIds);
    }
    await admin.from("import_batches").delete().eq("restaurant_id", restaurantId).eq("filename", "e2e-import.csv");
  });

  test("upload, preview, apply, verify inventory, and revert at 390px", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await loginWithLocalFixture(page);

    await page.goto("/import");
    await expect(page.getByRole("heading", { name: "Import cellar" })).toBeVisible();

    await page.setInputFiles("#import-file", {
      name: "e2e-import.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });

    const previewButton = page.getByRole("button", { name: "Preview import" });
    expect(await controlHeight(previewButton)).toBeGreaterThanOrEqual(44);
    await previewButton.click();

    await expect(page.getByRole("heading", { name: /^Preview:/ })).toBeVisible();
    await expect(page.getByText("Passing validation")).toBeVisible();

    const confirmButton = page.getByRole("button", { name: "Confirm import" });
    expect(await controlHeight(confirmButton)).toBeGreaterThanOrEqual(44);
    await confirmButton.click();

    await expect(page.getByText("e2e-import.csv")).toBeVisible();

    // A brand-new test wine won't match the (unseeded, in this local
    // environment) LWIN catalog — it lands in the "needs your decision"
    // bucket. Resolve it by including it as a new, unlinked wine, which
    // exercises the same operator-resolution path bar 3 requires.
    const includeAnywayButton = page.getByRole("button", { name: "Include anyway" });
    await expect(includeAnywayButton).toBeVisible();
    expect(await controlHeight(includeAnywayButton)).toBeGreaterThanOrEqual(44);
    await includeAnywayButton.click();
    await expect(page.getByText("Needs your decision")).toHaveCount(0);

    const applyButton = page.getByRole("button", { name: /^Apply \d+ row/ });
    await expect(applyButton).toBeVisible();
    expect(await controlHeight(applyButton)).toBeGreaterThanOrEqual(44);
    await applyButton.click();

    await expect(page.getByText("Completed")).toBeVisible({ timeout: 15_000 });

    // Verify inventory: the imported wine now has a real inventory row.
    const admin = localAdminClient();
    await expect
      .poll(async () => {
        const { data: wine } = await admin
          .from("wines")
          .select("id")
          .eq("restaurant_id", restaurantId)
          .eq("producer", producer)
          .eq("name", wineName)
          .maybeSingle();
        if (!wine) return 0;
        const { data: items } = await admin
          .from("inventory_items")
          .select("id, quantity, unit_cost")
          .eq("wine_id", (wine as { id: string }).id);
        return items?.length ?? 0;
      })
      .toBe(1);

    const { data: wineRow } = await admin
      .from("wines")
      .select("id")
      .eq("restaurant_id", restaurantId)
      .eq("producer", producer)
      .eq("name", wineName)
      .single();
    const { data: inventoryRow } = await admin
      .from("inventory_items")
      .select("quantity, unit_cost")
      .eq("wine_id", (wineRow as { id: string }).id)
      .single();
    expect(inventoryRow).toMatchObject({ quantity: 4, unit_cost: 42.5 });

    // Revert.
    const revertButton = page.getByRole("button", { name: "Revert this import" });
    expect(await controlHeight(revertButton)).toBeGreaterThanOrEqual(44);
    await revertButton.click();
    await page.getByRole("dialog", { name: "Revert this import?" })
      .getByRole("button", { name: "Revert import" })
      .click();

    // Sol audit 2026-08-27 round 5, finding 5: the "Import cellar" heading
    // is the page's own outer <h1>, always rendered regardless of step —
    // asserting it alone (as this test used to, right after clicking
    // revert) proves nothing about the revert's actual outcome. Assert the
    // success panel's own reported counts instead: this wine was freshly
    // created by this batch's own apply (an unmatched-LWIN "Include
    // anyway" row) with no other reference once its inventory is gone, so
    // orphan-wine cleanup deletes it too — one inventory row removed, one
    // wine deleted.
    await expect(page.getByRole("heading", { name: "Import reverted" })).toBeVisible();
    await expect(page.getByText(/Removed 1 inventory row\(s\)/)).toBeVisible();
    await expect(page.getByText(/deleted 1 wine\(s\)/)).toBeVisible();

    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: "Import cellar" })).toBeVisible();

    await expect
      .poll(async () => {
        const { data: items } = await admin
          .from("inventory_items")
          .select("id")
          .eq("wine_id", (wineRow as { id: string }).id);
        return items?.length ?? 0;
      })
      .toBe(0);

    await expectNoDocumentOverflow(page);
  });
});

async function expectNoDocumentOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
}

async function controlHeight(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((node) => node.getBoundingClientRect().height);
}
