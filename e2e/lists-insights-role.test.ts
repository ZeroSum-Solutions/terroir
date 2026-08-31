import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { enterProdShape, leaveProdShape } from "./prodshape";

type Admin = SupabaseClient<Database>;
type Role = Database["public"]["Enums"]["membership_role"];
type Membership = { id: string; restaurant_id: string; role: Role };

/**
 * SD-12 / SD-24 — the interface offering an action that cannot happen.
 *
 * `/lists`, `/lists/[id]` and `/insights` are all membership-only pages whose
 * mutating routes are `requireRole(["owner", "manager"])`. Staff were handed
 * New wine list, Clone, Archive, Delete, Add section, Add wine, every price
 * stepper, and Snooze — and learned none of them worked from the 403 that came
 * back (or, for the item writes, from nothing at all: SD-18).
 *
 * These run against the production-SHAPED tenant, because the demo tenant is
 * the best case on every axis. Server-side authorization is unchanged and the
 * last assertion in each block proves it: the hidden control is a truthfulness
 * fix, not the access control.
 */
test.describe("@sd-12 staff affordances match the API", () => {
  test.skip(!!process.env.CI, "Requires service-role fixtures and dev login.");
  test.describe.configure({ mode: "serial" });

  let membership: Membership;
  let listId: string;

  test.beforeAll(async () => {
    const admin = adminClient();
    membership = await resolveProdShapeMembership(admin);
    listId = await resolveList(admin, membership.restaurant_id);
  });

  test.afterAll(async () => {
    const admin = adminClient();
    await admin
      .from("memberships")
      .update({ role: membership.role })
      .eq("id", membership.id);
  });

  test("staff see the lists and the alerts, and no control the API refuses", async ({ page }) => {
    const admin = adminClient();
    await login(page);
    await enterProdShape(page);
    await admin.from("memberships").update({ role: "staff" }).eq("id", membership.id);
    try {
      await page.goto("/lists");
      await expect(page.getByRole("heading", { name: "Wine Lists" })).toBeVisible();
      await expect(page.getByRole("button", { name: "New wine list" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^More actions for / })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Clone / })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Archive / })).toHaveCount(0);

      await page.goto(`/lists/${listId}`);
      await expect(page.getByRole("button", { name: /^Increase glass price for / })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Rename / })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Delete / })).toHaveCount(0);
      await expect(page.getByText("Add wine", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Add section", { exact: true })).toHaveCount(0);
      // The read-only half is untouched: GET .../csv is membership-only.
      await expect(page.getByRole("link", { name: "CSV" }).first()).toBeVisible();

      await page.goto("/insights");
      await expect(page.getByRole("button", { name: "Snooze 30 days" })).toHaveCount(0);

      // Server-side authorization is unchanged, and must stay that way.
      const createRefused = await page.request.post("/api/wine-lists", {
        data: { name: "e2e should be refused" },
      });
      expect(createRefused.status()).toBe(403);
      const sectionRefused = await page.request.post("/api/wine-list-sections", {
        data: { wine_list_id: listId, name: "e2e should be refused" },
      });
      expect(sectionRefused.status()).toBe(403);
    } finally {
      await admin
        .from("memberships")
        .update({ role: membership.role })
        .eq("id", membership.id);
      await leaveProdShape(page);
    }
  });

  test("a manager still gets the whole editor", async ({ page }) => {
    const admin = adminClient();
    await admin.from("memberships").update({ role: "manager" }).eq("id", membership.id);
    try {
      await login(page);
      await enterProdShape(page);
      await page.goto("/lists");
      await expect(page.getByRole("button", { name: "New wine list" })).toBeVisible();

      await page.goto(`/lists/${listId}`);
      await expect(
        page.getByRole("button", { name: /^Increase glass price for / }).first(),
      ).toBeVisible();
    } finally {
      await admin
        .from("memberships")
        .update({ role: membership.role })
        .eq("id", membership.id);
      await leaveProdShape(page);
    }
  });
});

function adminClient(): Admin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SD-12 E2E requires Supabase service credentials.");
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}

async function resolveProdShapeMembership(admin: Admin): Promise<Membership> {
  const email = process.env.DEV_BYPASS_EMAIL;
  if (!email) throw new Error("DEV_BYPASS_EMAIL not set");
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;
  const user = data.users.find((candidate) => candidate.email === email);
  if (!user) throw new Error(`Dev user ${email} not found`);
  const { data: rows, error: rowsError } = await admin
    .from("memberships")
    .select("id, restaurant_id, role")
    .eq("user_id", user.id)
    .eq("restaurant_id", "de200000-0000-4000-8000-000000000001");
  if (rowsError) throw rowsError;
  const row = rows?.[0];
  if (!row) {
    throw new Error(
      "No prod-shape membership for the dev user — run scripts/local/prodshape.sh --confirm.",
    );
  }
  return row;
}

async function resolveList(admin: Admin, restaurantId: string): Promise<string> {
  const { data, error } = await admin
    .from("wine_lists")
    .select("id")
    .eq("restaurant_id", restaurantId)
    .eq("archived", false)
    .limit(1);
  if (error) throw error;
  const id = data?.[0]?.id;
  if (!id) throw new Error("Prod-shape tenant has no wine list to edit.");
  return id;
}

async function login(page: Page) {
  const response = await page.request.get("/api/dev-login");
  expect(response.ok(), await response.text()).toBeTruthy();
}
