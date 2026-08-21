import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * OPP-1 wave-0 E2E (@opp-1) — vintage lineage on the Cellar surface.
 * Evals: EV-1.1 (lineage block, expandable, per-vintage rows), EV-1.2
 * (duplicate suspect chip + merge combines stock, keeps history),
 * EV-1.3 (cross-vintage merge rejected 422 server-side).
 *
 * Same conventions as pour-flow.test.ts: dev-login auth, service-role
 * client for fixtures, local-only (skipped in CI). The test creates its
 * own uniquely-named wines and removes them afterwards, so it is safe
 * on the shared dev DB.
 */

test.describe("@opp-1 vintage lineage", () => {
  test.skip(
    !!process.env.CI,
    "Requires DEV_BYPASS_EMAIL; shared DB — run locally only for now.",
  );
  test.describe.configure({ mode: "serial" });

  const RUN = `${Date.now()}`;
  const PRODUCER = `E2E Lineage ${RUN}`;
  const CUVEE = "Test Côte";
  // Any 7-digit prefix forms an LWIN7 identity; unique per run so the
  // three wines share one fresh lineage.
  const LWIN = `9${RUN.slice(-6)}`;

  function adminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "lineage E2E requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return createClient(url, key, { auth: { persistSession: false } });
  }

  async function resolveRestaurantId(): Promise<string> {
    const email = process.env.DEV_BYPASS_EMAIL;
    if (!email) throw new Error("DEV_BYPASS_EMAIL not set");
    const admin = adminClient();
    const { data: users, error: userErr } = await admin.auth.admin.listUsers({
      perPage: 200,
    });
    if (userErr) throw userErr;
    const user = users.users.find((u) => u.email === email);
    if (!user) throw new Error(`Dev user ${email} not found`);
    const { data: rows, error } = await admin
      .from("memberships")
      .select("restaurant_id, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!rows?.[0]) throw new Error("No membership for dev user");
    return rows[0].restaurant_id as string;
  }

  async function login(page: Page) {
    const res = await page.request.get("/api/dev-login");
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  let restaurantId: string;
  let wineIds: { v2016: string; v2019: string; twin2019: string };

  test.beforeAll(async () => {
    restaurantId = await resolveRestaurantId();
    const admin = adminClient();

    // Three wines, one LWIN identity: a 2016, a 2019, and a 2019 twin
    // under a variant spelling (the derive trigger must land all three
    // in one lineage; the 2019 pair becomes a duplicate suspect).
    const inserts = [
      { name: CUVEE, vintage: 2016 },
      { name: CUVEE, vintage: 2019 },
      { name: `${CUVEE} (dup)`, vintage: 2019 },
    ].map((w) => ({
      restaurant_id: restaurantId,
      producer: PRODUCER,
      name: w.name,
      vintage: w.vintage,
      size_ml: 750,
      lwin_id: LWIN,
    }));
    const { data, error } = await admin
      .from("wines")
      .insert(inserts)
      .select("id, vintage, name");
    if (error) throw error;
    const v2016 = data!.find((w) => w.vintage === 2016)!.id;
    const v2019 = data!.find((w) => w.vintage === 2019 && w.name === CUVEE)!.id;
    const twin2019 = data!.find((w) => w.name.endsWith("(dup)"))!.id;
    wineIds = { v2016, v2019, twin2019 };

    // Stock: 3 sealed on the keeper, 2 on the twin — post-merge total 5.
    const { error: invErr } = await admin.from("inventory_items").insert([
      { restaurant_id: restaurantId, wine_id: v2019, quantity: 3, unit_cost: 210 },
      { restaurant_id: restaurantId, wine_id: twin2019, quantity: 2, unit_cost: 190 },
    ]);
    if (invErr) throw invErr;
  });

  test.afterAll(async () => {
    const admin = adminClient();
    const ids = Object.values(wineIds ?? {});
    if (ids.length) {
      await admin.from("inventory_items").delete().in("wine_id", ids);
      await admin.from("wines").delete().in("id", ids);
    }
    // Remove the run's lineage row (name-normalised producer is unique
    // to this run, so this cannot touch anything else).
    await admin
      .from("wine_lineages")
      .delete()
      .eq("restaurant_id", restaurantId)
      .eq("producer_norm", PRODUCER.toLowerCase());
  });

  test("EV-1.1: siblings render as one expandable lineage block with per-vintage rows", async ({ page }) => {
    await login(page);
    await page.goto("/cellar");
    await page
      .getByPlaceholder("Search name, producer, region…")
      .fill(PRODUCER);

    const block = page.locator("[data-lineage-id]", { hasText: PRODUCER });
    await expect(block).toHaveCount(1);

    const rollup = block.locator("[data-lineage-rollup]");
    await expect(rollup).toContainText("3 wines");
    await expect(rollup).toContainText("2016–2019");
    await expect(rollup).toContainText("5 btls");

    // Per-vintage child rows, newest first, each its own row.
    await expandLineage(block);
    const children = block.locator("[data-lineage-children]");
    await expect(children).toBeVisible();
    await expect(children.getByText("2016", { exact: false }).first()).toBeVisible();

    // Collapse hides the children; the rollup stays.
    await block.locator("[data-lineage-header]").click();
    await expect(children).toHaveCount(0);
    await expect(rollup).toBeVisible();
  });

  test("EV-1.2: duplicate suspects are chipped and merge combines stock", async ({ page }) => {
    await login(page);
    await page.goto("/cellar");
    await page
      .getByPlaceholder("Search name, producer, region…")
      .fill(PRODUCER);

    const block = page.locator("[data-lineage-id]", { hasText: PRODUCER });
    await expect(block).toHaveCount(1);
    await expandLineage(block);
    await expect(
      block.locator("[data-duplicate-suspect]").first(),
    ).toBeVisible();

    // Open the keeper 2019's drawer → merge panel lists the twin.
    // (Click inside the children container — the lineage HEADER also carries
    // the exact cuvée text, and clicking it would collapse the block.)
    await block
      .locator("[data-lineage-children]")
      .getByText(CUVEE, { exact: true })
      .first()
      .click();
    const mergePanel = page.locator("[data-merge-duplicates]");
    await expect(mergePanel).toBeVisible();
    await mergePanel.getByRole("button", { name: /Merge .*dup/ }).click();
    await mergePanel.getByRole("button", { name: "Confirm merge" }).click();

    // Twin is gone; combined stock (3 + 2 = 5) survives on the keeper.
    await expect(page.getByText("Duplicate merged", { exact: false })).toBeVisible();
    const admin = adminClient();
    const { data: gone } = await admin
      .from("wines")
      .select("id")
      .eq("id", wineIds.twin2019);
    expect(gone).toHaveLength(0);
    const { data: stock } = await admin
      .from("inventory_items")
      .select("quantity, unit_cost")
      .eq("wine_id", wineIds.v2019);
    const total = (stock ?? []).reduce((a, r) => a + r.quantity, 0);
    expect(total).toBe(5);
    // Audit trail intact: both lots keep their own cost basis.
    expect((stock ?? []).map((r) => Number(r.unit_cost)).sort()).toEqual([190, 210]);
  });

  test("EV-1.3: cross-vintage merge is rejected 422 server-side", async ({ page }) => {
    await login(page);
    const res = await page.request.post("/api/wines/merge", {
      data: { source_id: wineIds.v2016, target_id: wineIds.v2019 },
    });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("cross_vintage_merge");
    // Both vintages still exist — nothing was touched.
    const admin = adminClient();
    const { data } = await admin
      .from("wines")
      .select("id")
      .in("id", [wineIds.v2016, wineIds.v2019]);
    expect(data).toHaveLength(2);
  });
});

async function expandLineage(block: ReturnType<Page["locator"]>) {
  const header = block.locator("[data-lineage-header]");
  if ((await header.getAttribute("aria-expanded")) !== "true") {
    await header.click();
  }
  await expect(header).toHaveAttribute("aria-expanded", "true");
}
