import { test, expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertNoSeriousA11yViolations } from "./a11y";

/**
 * BND-038 E2E — full oz-native-inventory cycle.
 *
 * Updated for the v5 IA redesign (.council/specs/2026-04-24-ux-ia-redesign.md):
 * /pour and /reconcile have been absorbed into /cellar. Pour now lives
 * inside the wine-detail drawer; Reconcile opens a modal from the
 * Cellar surface.
 *
 * Path exercised:
 *   1. Authenticate via /api/dev-login (DEV_BYPASS_EMAIL in .env.local).
 *   2. Call list_open_bottle_items RPC directly (as the dev user) to find
 *      a by-the-glass wine with sealed inventory or an open bottle.
 *   3. Navigate to /cellar, tap the wine row → drawer opens → tap the
 *      primary "Pour Xoz" button. Verify the row's "~N glasses left"
 *      count decrements by exactly 1 after refresh.
 *   4. Open reconcile mode via "Reconcile open bottles →" button → tap
 *      "½" for the same wine → click Save → verify the save button
 *      returns to its "No changes yet" rest state.
 *
 * Assertions are RELATIVE (delta = -1 glass) so the test survives
 * concurrent edits to the target Supabase DB.
 *
 * G1-8: previously skipped unconditionally in CI ("no dedicated test
 * project + seeded fixtures"). CI now starts its own ephemeral local
 * Supabase (supabase start, standard local ports), applies every
 * migration, and seeds it via `pnpm run supabase:seed:local:apply`
 * (.github/workflows/ci.yml) before this spec runs — a fresh,
 * disposable-per-run database, not a shared one. That removes the
 * original blocker, so the test now runs in CI too. What stays gated
 * is *which* database this is allowed to touch: the guard below skips
 * unless NEXT_PUBLIC_SUPABASE_URL is a loopback host, so pointing this
 * suite at a real staging/production project (locally or otherwise)
 * skips instead of pouring/reconciling real inventory.
 */

function isLoopbackSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

test.describe("BND-038 pour → reconcile", () => {
  test.skip(
    !isLoopbackSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL),
    "Requires a loopback NEXT_PUBLIC_SUPABASE_URL (local Supabase) + DEV_BYPASS_EMAIL.",
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
  // now. The describe-level skip above already restricts this whole
  // file to a loopback NEXT_PUBLIC_SUPABASE_URL, so the service-role
  // key in scope here — whether from a developer's .env.local or the
  // ephemeral local Supabase CI starts for this job — only ever
  // targets a disposable local database.
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

  // list_open_bottle_items guards on is_member(auth.uid()), so a
  // service-role call always returns []. Mint a real session for the
  // dev user instead (same generate-link + verify flow as /api/dev-login).
  let cachedUserClient: SupabaseClient | null = null;
  async function userClient() {
    if (cachedUserClient) return cachedUserClient;
    const email = process.env.DEV_BYPASS_EMAIL;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!email || !url || !anonKey) {
      throw new Error(
        "pour-flow E2E requires DEV_BYPASS_EMAIL, NEXT_PUBLIC_SUPABASE_URL, " +
          "and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
      );
    }
    const { data, error } = await adminClient().auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (error) throw error;
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: verifyError } = await client.auth.verifyOtp({
      type: "magiclink",
      token_hash: data.properties.hashed_token,
    });
    if (verifyError) throw verifyError;
    cachedUserClient = client;
    return client;
  }

  async function fetchItems(_page: Page): Promise<OpenBottleItem[]> {
    const user = await userClient();
    const restaurantId = await resolveRestaurantId();
    const { data, error } = await user.rpc("list_open_bottle_items", {
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
    // Every demo wine shares one producer, so the wine NAME is the only
    // reliable discriminator. Escape it for use inside a RegExp.
    const nameLabel = new RegExp(
      wine.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );

    // --- Step 1: land on /cellar and find the wine row ----------------
    await page.goto("/cellar");
    await page
      .getByPlaceholder("Search name, producer, region…")
      .fill(wine.name);
    const lineageHeader = page
      .locator('[data-lineage-header][aria-expanded="false"]', {
        hasText: nameLabel,
      })
      .first();
    if (await lineageHeader.count()) await lineageHeader.click();
    // Since the One Accent row-anatomy pass (2d631a8) the row button no
    // longer carries a "~N glass" chip — glass counts live in the
    // wine-detail drawer now. Pick the row by wine name alone.
    const row = page
      .getByRole("button")
      .filter({ hasText: nameLabel })
      .first();
    await expect(row).toBeVisible();
    await assertNoSeriousA11yViolations(page, "/cellar wine list");

    // --- Step 2: open the drawer, read the glass count, pour ---------
    await row.click();
    const drawer = page.getByRole("dialog", { name: /./ }); // any dialog
    await expect(drawer).toBeVisible();
    await assertNoSeriousA11yViolations(page, "/cellar wine-detail drawer");
    const glassCount = drawer.getByText(/~\d+ glasses? left/);
    await expect(glassCount).toBeVisible();
    const startText = (await glassCount.textContent()) ?? "";
    const startMatch = startText.match(/~(\d+) glass/);
    expect(startMatch, `no glass count in drawer text: ${startText}`).toBeTruthy();
    const startGlasses = Number(startMatch![1]);
    expect(startGlasses).toBeGreaterThan(0);

    const pourBtn = drawer.getByRole("button", { name: /^Pour \d/i });
    await expect(pourBtn).toBeVisible();
    await pourBtn.click();

    // The pour handler calls router.refresh(); the drawer re-renders in
    // place with the committed state. Poll until the drawer's glass
    // count drops by exactly one, then close it.
    await expect(async () => {
      const currentText = (await glassCount.textContent()) ?? "";
      const m = currentText.match(/~(\d+) glass/);
      expect(m).toBeTruthy();
      expect(Number(m![1])).toBe(startGlasses - 1);
    }).toPass({ timeout: 10_000 });
    await drawer.getByRole("button", { name: /^close$/i }).click();

    // --- Step 3: reconcile to half via the Cellar reconcile modal -----
    await page.getByRole("button", { name: /Reconcile \d+ open bottle/i }).click();
    const reconcileDialog = page.getByRole("dialog", {
      name: /Reconcile open bottles/i,
    });
    await expect(reconcileDialog).toBeVisible();
    await assertNoSeriousA11yViolations(page, "/cellar reconcile dialog");

    const reconcileRow = reconcileDialog
      .locator("li")
      .filter({ hasText: nameLabel })
      .first();
    await expect(reconcileRow).toBeVisible();
    await reconcileRow.getByRole("button", { name: "Half" }).click();

    const saveBtn = reconcileDialog.getByRole("button", {
      name: /Save \d+ change/i,
    });
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // After success the button reverts to "No changes yet" (pending map
    // cleared). Scope the alert check to the dialog so we don't trip on
    // Next.js dev-tools error overlays outside it.
    await expect(reconcileDialog.getByRole("alert")).toHaveCount(0);
    await expect(
      reconcileDialog.getByRole("button", { name: /No changes yet/i }),
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
