import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * BND-038 E2E — full oz-native-inventory cycle.
 *
 * Path exercised:
 *   1. Authenticate via /api/dev-login (DEV_BYPASS_EMAIL in .env.local).
 *   2. Call list_open_bottle_items RPC directly (service-role) to find
 *      a by-the-glass wine with sealed inventory or an open bottle.
 *   3. Navigate to /pour, tap the primary pour button, verify the
 *      "~N glasses left" count decrements by exactly 1.
 *   4. Navigate to /reconcile, tap the "½" fraction for the same wine,
 *      click Save, verify the Save button returns to its "No changes
 *      yet" rest state (= success; any error surfaces the error banner).
 *
 * Assertions are RELATIVE (delta = -1 glass) so the test survives
 * concurrent edits to the shared Supabase DB. Skipped in CI until we
 * have a dedicated test project + seeded fixtures — locally it
 * exercises the real RPC + trigger pipeline end-to-end.
 */

test.describe("BND-038 pour → reconcile", () => {
  test.skip(
    !!process.env.CI,
    "Requires DEV_BYPASS_EMAIL; shared DB — run locally only for now.",
  );

  test.describe.configure({ mode: "serial" });

  async function login(page: Page) {
    // Dev-login mints a server-side session via the Supabase admin
    // API and sets auth cookies. No redirect to supabase.co — works
    // even inside the preview sandbox.
    const res = await page.request.get("/api/dev-login");
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  type OpenBottleItem = {
    wine_id: string;
    wine_list_item_id: string;
    name: string;
    producer: string;
    size_ml: number;
    glass_pour_ml: number;
    pour_size_mode: "fixed" | "picker";
    open_remaining_ml: number | null;
    sealed_count: number;
  };

  // Service-role client for the setup/verification reads that used
  // to go through /api/open-bottles. DEBT-018 deleted that route; the
  // RPC (SECURITY DEFINER, restaurant-scoped) is the canonical path
  // now. Local-only — service-role key is never present in CI.
  function adminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "pour-flow E2E requires NEXT_PUBLIC_SUPABASE_URL + " +
          "SUPABASE_SERVICE_ROLE_KEY (same as /api/dev-login).",
      );
    }
    return createClient(url, key, { auth: { persistSession: false } });
  }

  async function resolveRestaurantId(): Promise<string> {
    const email = process.env.DEV_BYPASS_EMAIL;
    if (!email) throw new Error("DEV_BYPASS_EMAIL not set");
    const admin = adminClient();
    const { data: users, error: userErr } =
      await admin.auth.admin.listUsers({ perPage: 200 });
    if (userErr) throw userErr;
    const user = users.users.find((u) => u.email === email);
    if (!user) throw new Error(`Dev user ${email} not found in auth.users`);
    const { data: rows, error: mErr } = await admin
      .from("memberships")
      .select("restaurant_id, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (mErr) throw mErr;
    const row = rows?.[0];
    if (!row) throw new Error(`No restaurant membership for ${email}`);
    return row.restaurant_id as string;
  }

  async function fetchItems(_page: Page): Promise<OpenBottleItem[]> {
    const admin = adminClient();
    const restaurantId = await resolveRestaurantId();
    const { data, error } = await admin.rpc("list_open_bottle_items", {
      p_restaurant_id: restaurantId,
    });
    expect(error, error?.message).toBeNull();
    return (data ?? []) as OpenBottleItem[];
  }

  /**
   * Bootstrap any DB state into "a pour-tracked wine has an open bottle
   * with at least 2× glass_pour_ml remaining." Avoids the E2E failing
   * because someone drained Savart in a previous session.
   *
   * Strategy:
   *  1. If a pour-tracked wine already has open ≥ 2×pour → use it.
   *  2. Otherwise find one with enough total inventory (open + sealed)
   *     to support the test (≥ 3×pour so we can both pour and reconcile
   *     to ½ without cascading unexpectedly).
   *  3. If its open bottle is null, tap it once to open. This fires a
   *     Case-1 cascade (banner suppressed — that's fine during setup).
   *  4. Reconcile the open bottle to size_ml (full). Now the real test
   *     pour is guaranteed cascade-safe.
   */
  async function ensureCascadeSafeWine(page: Page): Promise<OpenBottleItem> {
    const items = await fetchItems(page);
    const tracked = items.filter((i) => i.glass_pour_ml > 0);

    // Best case: already safe with headroom for a reconcile to ½.
    const alreadySafe = tracked
      .filter(
        (i) =>
          i.open_remaining_ml !== null &&
          i.open_remaining_ml >= 2 * i.glass_pour_ml,
      )
      .sort((a, b) => (b.open_remaining_ml ?? 0) - (a.open_remaining_ml ?? 0))[0];
    if (alreadySafe) return alreadySafe;

    // Find a bootstrappable candidate: needs total inventory ≥ 3×pour so
    // we can open a bottle AND still pour AND still reconcile.
    const total = (i: OpenBottleItem) =>
      (i.open_remaining_ml ?? 0) + i.sealed_count * i.size_ml;
    const bootstrappable = [...tracked]
      .filter((i) => total(i) >= 3 * i.glass_pour_ml)
      .sort((a, b) => total(b) - total(a))[0];
    expect(
      bootstrappable,
      "no pour-tracked wine in the DB has enough inventory to run the E2E " +
        "(need ≥ 3× glass_pour_ml between sealed + open) — seed one or run " +
        "/api/pour + /api/reconcile manually first",
    ).toBeTruthy();

    // If no bottle is open, tap once to open — this is a Case-1 cascade
    // in setup, so the banner suppression is fine here.
    if (bootstrappable.open_remaining_ml === null) {
      const pourRes = await page.request.post("/api/pour", {
        data: {
          wine_id: bootstrappable.wine_id,
          ml: bootstrappable.glass_pour_ml,
        },
      });
      expect(pourRes.ok(), await pourRes.text()).toBeTruthy();
    }

    // Reconcile the open bottle up to full so the next pour is cascade-safe.
    const reconcileRes = await page.request.post("/api/reconcile", {
      data: {
        entries: [
          {
            wine_id: bootstrappable.wine_id,
            new_remaining_ml: bootstrappable.size_ml,
            note: "e2e bootstrap",
          },
        ],
      },
    });
    expect(reconcileRes.ok(), await reconcileRes.text()).toBeTruthy();

    // Re-fetch — the row now reflects the reconciled state.
    const after = await fetchItems(page);
    const fresh = after.find((i) => i.wine_id === bootstrappable.wine_id);
    expect(fresh).toBeTruthy();
    expect(fresh!.open_remaining_ml).toBeGreaterThanOrEqual(
      2 * fresh!.glass_pour_ml,
    );
    return fresh!;
  }

  test("configure → pour → reconcile cycle", async ({ page }) => {
    await login(page);
    const wine = await ensureCascadeSafeWine(page);
    const cardLabel = new RegExp(wine.producer.slice(0, 10), "i");

    // --- Step 1: land on /pour and read the starting glass count ----
    await page.goto("/pour");
    // Pick the first <li> that mentions the chosen wine's producer.
    const card = page.locator("li").filter({ hasText: cardLabel }).first();
    await expect(card).toBeVisible();
    const startText = (await card.textContent()) ?? "";
    const startMatch = startText.match(/~(\d+) glass/);
    expect(startMatch, `no glass count in card text: ${startText}`).toBeTruthy();
    const startGlasses = Number(startMatch![1]);
    expect(startGlasses).toBeGreaterThan(0);

    // --- Step 2: tap the primary pour button --------------------------
    const pourBtn = card.getByRole("button", { name: /^Pour \d/i });
    await expect(pourBtn).toBeVisible();
    await pourBtn.click();

    // Undo banner appears (aria-live status region) → proof the
    // optimistic update + fetch-success branch ran.
    const banner = page.getByRole("status").filter({ hasText: /Poured/i });
    await expect(banner).toBeVisible({ timeout: 5_000 });

    // Server component refresh should land the committed state back
    // into the card. Poll until the glass count drops by exactly one.
    await expect(async () => {
      const currentText = (await card.textContent()) ?? "";
      const m = currentText.match(/~(\d+) glass/);
      expect(m).toBeTruthy();
      expect(Number(m![1])).toBe(startGlasses - 1);
    }).toPass({ timeout: 10_000 });

    // --- Step 3: reconcile to half ------------------------------------
    await page.goto("/reconcile");
    const row = page.locator("li").filter({ hasText: cardLabel }).first();
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "½" }).click();

    const saveBtn = page.getByRole("button", { name: /Save \d+ change/i });
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // After success the button reverts to "No changes yet" (pending map
    // cleared). Scope the alert check to <main> — Next.js dev tools
    // render their own role="alert" outside it.
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /No changes yet/i }),
    ).toBeVisible({ timeout: 10_000 });

    // --- Step 4: verify via RPC that an open_bottle exists for the
    //     wine and its remaining_ml is ~half of the bottle size ------
    const afterItems = await fetchItems(page);
    const sameWine = afterItems.find((i) => i.wine_id === wine.wine_id);
    expect(sameWine).toBeTruthy();
    // Bottle size is 750 for every wine in the current fixture, but pull
    // from the existing item's state if we need to be general later.
    // "~half" = within ±10ml of 375 to allow for fraction rounding.
    expect(sameWine!.open_remaining_ml).not.toBeNull();
    expect(sameWine!.open_remaining_ml!).toBeGreaterThanOrEqual(365);
    expect(sameWine!.open_remaining_ml!).toBeLessThanOrEqual(385);
  });
});
