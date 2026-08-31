import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * CELLAR-04 — dragging a wine between cellar sections must COMMIT, and must
 * still be committed after a reload.
 *
 * The defect this covers: dropping a wine into the "Uncategorized" group sent
 * `{"section": ""}`, which the PATCH route's zod schema rejected with a 400.
 * The optimistic move was then rolled back, so the row visibly snapped back —
 * "I can drag them but they do not stick". Nothing in e2e covered any drag
 * between sections, in either direction.
 */
test.describe("@cellar-04 section drag-and-drop", () => {
  test.skip(
    !!process.env.CI,
    "Requires DEV_BYPASS_EMAIL; shared DB — run locally only for now.",
  );
  test.describe.configure({ mode: "serial" });

  const RUN = `${Date.now()}`;
  // Sorts to the top of the (name-ascending, 50-per-page) cellar list so the
  // fixture is always on the first page regardless of cellar size.
  const WINE_NAME = `AAA DnD Fixture ${RUN}`;
  const PRODUCER = `AAA DnD Producer ${RUN}`;
  const SECTION_A = `E2E Section A ${RUN}`;
  const SECTION_B = `E2E Section B ${RUN}`;

  function adminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "cellar DnD E2E requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return createClient(url, key, { auth: { persistSession: false } });
  }

  async function resolveRestaurantId(): Promise<string> {
    const email = process.env.DEV_BYPASS_EMAIL;
    if (!email) throw new Error("DEV_BYPASS_EMAIL not set");
    const admin = adminClient();
    const { data: users, error: userError } =
      await admin.auth.admin.listUsers({ perPage: 200 });
    if (userError) throw userError;
    const user = users.users.find((candidate) => candidate.email === email);
    if (!user) throw new Error(`Dev user ${email} not found`);
    // Same cookie-less fallback resolveActiveMembership() uses: created_at DESC.
    const { data, error } = await admin
      .from("memberships")
      .select("restaurant_id, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data?.[0]) throw new Error("No membership for dev user");
    return data[0].restaurant_id as string;
  }

  let restaurantId: string;
  let wineId: string;
  let inventoryId: string;
  let configId: string | null = null;
  let priorLabels: Record<string, unknown> | null = null;

  test.beforeAll(async () => {
    restaurantId = await resolveRestaurantId();
    const admin = adminClient();

    // The section list lives in cellar_config.labels.sections; two disposable
    // sections are appended so the drag has a source and a destination that
    // cannot collide with whatever this cellar already has.
    const { data: config, error: configError } = await admin
      .from("cellar_config")
      .select("id, labels")
      .eq("restaurant_id", restaurantId)
      .limit(1)
      .maybeSingle();
    if (configError) throw configError;
    if (!config) throw new Error("Cellar has no cellar_config row");
    configId = config.id;
    priorLabels = (config.labels ?? {}) as Record<string, unknown>;
    const priorSections = Array.isArray(priorLabels.sections)
      ? (priorLabels.sections as unknown[])
      : [];
    const { error: labelError } = await admin
      .from("cellar_config")
      .update({
        labels: { ...priorLabels, sections: [SECTION_A, SECTION_B, ...priorSections] },
      })
      .eq("id", configId);
    if (labelError) throw labelError;

    const { data: wine, error: wineError } = await admin
      .from("wines")
      .insert({
        restaurant_id: restaurantId,
        name: WINE_NAME,
        producer: PRODUCER,
        vintage: 2021,
        size_ml: 750,
      })
      .select("id")
      .single();
    if (wineError) throw wineError;
    wineId = wine.id;

    const { data: inventory, error: inventoryError } = await admin
      .from("inventory_items")
      .insert({
        restaurant_id: restaurantId,
        wine_id: wineId,
        quantity: 3,
        unit_cost: 40,
        section: SECTION_A,
      })
      .select("id")
      .single();
    if (inventoryError) throw inventoryError;
    inventoryId = inventory.id;
  });

  test.afterAll(async () => {
    const admin = adminClient();
    if (inventoryId) {
      await admin.from("inventory_items").delete().eq("id", inventoryId);
    }
    if (wineId) await admin.from("wines").delete().eq("id", wineId);
    if (configId && priorLabels) {
      await admin.from("cellar_config").update({ labels: priorLabels }).eq("id", configId);
    }
  });

  /** Reads the section a wine is filed under straight from the database. */
  async function storedSection(): Promise<string | null> {
    const admin = adminClient();
    const { data, error } = await admin
      .from("inventory_items")
      .select("section")
      .eq("id", inventoryId)
      .single();
    if (error) throw error;
    return data.section;
  }

  async function dragWineInto(page: Page, sectionKey: string) {
    const row = page.locator(`[data-cellar-row="${wineId}"]`);
    await expect(row).toBeVisible();
    const handle = row.getByRole("button", { name: "Drag to reorder" });
    const target = page.locator(`[data-cellar-section="${sectionKey}"]`);
    const from = (await handle.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // PointerSensor has an 8px activation distance — the first move has to
    // clear it before dnd-kit considers the drag started.
    await page.mouse.move(from.x + from.width / 2 + 24, from.y + from.height / 2 + 24, {
      steps: 5,
    });
    await page.mouse.move(to.x + to.width / 2, to.y + 40, { steps: 20 });
    await page.mouse.move(to.x + to.width / 2, to.y + 56, { steps: 5 });
    await page.mouse.up();
  }

  test("a wine dragged between sections stays there after a reload", async ({ page }) => {
    // Desktop: the drag handle is md:+ only.
    await page.setViewportSize({ width: 1280, height: 900 });
    const login = await page.request.get("/api/dev-login");
    expect(login.ok(), await login.text()).toBeTruthy();

    await page.goto("/cellar");
    await expect(
      page.locator(`[data-cellar-section="${SECTION_A}"] [data-cellar-row="${wineId}"]`),
    ).toBeVisible();

    // A → B
    const patchB = page.waitForResponse(
      (res) => res.url().includes(`/api/cellar/${wineId}/section`) && res.request().method() === "PATCH",
    );
    await dragWineInto(page, SECTION_B);
    expect((await patchB).status()).toBe(200);
    await expect.poll(storedSection, { timeout: 10_000 }).toBe(SECTION_B);

    await page.reload();
    await expect(
      page.locator(`[data-cellar-section="${SECTION_B}"] [data-cellar-row="${wineId}"]`),
    ).toBeVisible();

    // B → Uncategorized. This is the drop that used to 400 and snap back.
    const patchUncat = page.waitForResponse(
      (res) => res.url().includes(`/api/cellar/${wineId}/section`) && res.request().method() === "PATCH",
    );
    await dragWineInto(page, "__uncategorized__");
    expect((await patchUncat).status()).toBe(200);
    await expect.poll(storedSection, { timeout: 10_000 }).toBeNull();

    await page.reload();
    await expect(
      page.locator(`[data-cellar-section="__uncategorized__"] [data-cellar-row="${wineId}"]`),
    ).toBeVisible();
    await expect(page.getByText("Failed to move wine")).toHaveCount(0);
  });
});
