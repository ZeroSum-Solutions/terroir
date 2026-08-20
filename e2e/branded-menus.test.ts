import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import type { MenuTheme } from "@/lib/branding/theme";
import type { Json } from "@/types/database";

test.describe("@opp-8 branded menus", () => {
  test.skip(
    !!process.env.CI,
    "Requires DEV_BYPASS_EMAIL; shared DB — run locally only for now.",
  );
  test.describe.configure({ mode: "serial" });

  const RUN = Date.now().toString();
  const LIST_NAME = `E2E Branded Menu ${RUN}`;
  const THEME: MenuTheme = {
    version: 1,
    name: "E2E Cellar Ink",
    palette: {
      background: "#FFFFFF",
      surface: "#F7F5F2",
      text: "#111111",
      mutedText: "#595959",
      accent: "#721D35",
      border: "#D8D2CA",
    },
    typography: { heading: "Cormorant Garamond", body: "Inter" },
    spacing: { scale: "comfortable" },
  };

  function adminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("branded-menu E2E requires Supabase service credentials.");
    return createClient(url, key, { auth: { persistSession: false } });
  }

  async function login(page: Page) {
    const response = await page.request.get("/api/dev-login");
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  async function restaurantId() {
    const email = process.env.DEV_BYPASS_EMAIL;
    if (!email) throw new Error("DEV_BYPASS_EMAIL not set");
    const admin = adminClient();
    const { data: users, error: userError } = await admin.auth.admin.listUsers({ perPage: 200 });
    if (userError) throw userError;
    const user = users.users.find((candidate) => candidate.email === email);
    if (!user) throw new Error(`Dev user ${email} not found`);
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

  let rid: string;
  let listId: string;
  let slug: string;
  let previousKit: {
    logo_url: string | null;
    palette: Json;
    proposals: Json | null;
  } | null;

  test.beforeAll(async () => {
    rid = await restaurantId();
    slug = `e2e-brand-${RUN}`;
    const admin = adminClient();
    const { data: existingKit, error: existingKitError } = await admin
      .from("brand_kits")
      .select("logo_url, palette, proposals")
      .eq("restaurant_id", rid)
      .maybeSingle();
    if (existingKitError) throw existingKitError;
    previousKit = existingKit;
    const { data: list, error } = await admin
      .from("wine_lists")
      .insert({ restaurant_id: rid, name: LIST_NAME, slug, is_published: true })
      .select("id")
      .single();
    if (error) throw error;
    listId = list.id;
    const { error: kitError } = await admin.from("brand_kits").upsert({
      restaurant_id: rid,
      palette: { colors: ["#CC2233", "#2244CC"] },
      proposals: [
        THEME,
        { ...THEME, name: "E2E Paper Reserve" },
        { ...THEME, name: "E2E Night Service" },
      ],
    }, { onConflict: "restaurant_id" });
    if (kitError) throw kitError;
  });

  test.afterAll(async () => {
    const admin = adminClient();
    const errors: Error[] = [];
    if (listId) {
      const { error } = await admin.from("wine_lists").delete().eq("id", listId);
      if (error) errors.push(new Error(`wine list cleanup failed: ${error.message}`));
    }
    if (rid && previousKit) {
      const { error } = await admin
        .from("brand_kits")
        .update(previousKit)
        .eq("restaurant_id", rid);
      if (error) errors.push(new Error(`brand kit restore failed: ${error.message}`));
    } else if (rid) {
      const { error } = await admin.from("brand_kits").delete().eq("restaurant_id", rid);
      if (error) errors.push(new Error(`brand kit cleanup failed: ${error.message}`));
    }
    if (errors.length > 0) throw new AggregateError(errors, "Branded-menu E2E cleanup failed");
  });

  test("EV-8.1/8.3: upload extracts a palette and applying a card themes the public list", async ({ page }) => {
    await login(page);
    await page.goto(`/lists/${listId}`);
    const panel = page.getByRole("region", { name: "Brand kit" });
    await expect(panel).toBeVisible();

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl2kAAAAASUVORK5CYII=",
      "base64",
    );
    await panel.getByLabel("Upload logo").setInputFiles({
      name: "logo.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(panel.locator("[data-palette-swatch]").first()).toBeVisible();
    await panel.getByRole("button", { name: `Apply ${THEME.name}` }).click();
    await expect(panel.getByText("Theme applied")).toBeVisible();

    await page.goto(`/list/${slug}`);
    await expect(page.locator("main")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  });

  test("EV-8.4: low contrast is rejected server-side", async ({ page }) => {
    await login(page);
    const response = await page.request.post(`/api/wine-lists/${listId}/theme`, {
      data: {
        theme: {
          ...THEME,
          palette: { ...THEME.palette, text: "#777777" },
        },
      },
    });
    expect(response.status()).toBe(422);
    expect(JSON.stringify(await response.json())).toContain(
      "palette.text on palette.background",
    );
  });
});
