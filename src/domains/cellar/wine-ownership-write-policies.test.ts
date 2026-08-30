// Cross-tenant cascade-delete containment — migration 0136.
//
// THE DEFECT THIS SUITE EXISTS TO CLOSE
// The INSERT policies on stock_adjustments and bottle_closeouts gated on
// membership of the row's OWN restaurant_id and nothing else. Neither
// verified that the row's wine_id belonged to that same tenant. Both
// columns are `references public.wines(id) on delete cascade`, and Postgres
// FK cascades run as the table owner and BYPASS RLS.
//
// So a member of tenant B could insert a fully policy-compliant row —
// restaurant_id = B, acting_user_id = themselves — naming tenant A's
// wine_id. When tenant A later deleted that wine, the cascade silently
// destroyed tenant B's immutable financial record. Both tables revoke
// update and delete from authenticated precisely because these rows are
// meant to be permanent, which is what makes a silent cascade delete of
// them worse than an ordinary bug.
//
// MANDATORY live-DB suite. The boundary being tested IS row-level security,
// so a mocked client proves nothing whatsoever here — only a real Postgres
// enforcing a real policy against a real signed-in JWT can.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assertLiveDbTargetIsLocal } from "@/test/live-db-target";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasLiveDb = Boolean(supabaseUrl && publishableKey && serviceRoleKey);

if (hasLiveDb) assertLiveDbTargetIsLocal(supabaseUrl!);
if (!hasLiveDb && process.env.CI) {
  throw new Error(
    "MANDATORY live-DB suite: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY missing in CI - refusing to skip silently.",
  );
}

async function signedInClient(email: string, password: string): Promise<SupabaseClient<Database>> {
  const throwaway = createClient<Database>(supabaseUrl!, publishableKey!, { auth: { persistSession: false } });
  const { data, error } = await throwaway.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw error ?? new Error(`sign-in failed for ${email}`);
  return createClient<Database>(supabaseUrl!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

describe.skipIf(!hasLiveDb)("wine ownership on write policies (MANDATORY)", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let restaurantA: string;
  let restaurantB: string;
  let userBClient: SupabaseClient<Database>;
  let userBId: string;
  let wineA: string;
  let wineB: string;
  let reasonCodeB: string;

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });

    const { data: rA, error: rAErr } = await admin.from("restaurants").insert({ name: "Ownership Policy A" } as never).select("id").single();
    if (rAErr || !rA) throw rAErr ?? new Error("failed to insert restaurant A");
    restaurantA = (rA as { id: string }).id;

    const { data: rB, error: rBErr } = await admin.from("restaurants").insert({ name: "Ownership Policy B" } as never).select("id").single();
    if (rBErr || !rB) throw rBErr ?? new Error("failed to insert restaurant B");
    restaurantB = (rB as { id: string }).id;

    const run = Date.now();
    const password = "Ownership-Policy-Test-123!";
    const { data: userB, error: userBErr } = await admin.auth.admin.createUser({
      email: `ownership-policy-b-${run}@terroir.test`,
      password,
      email_confirm: true,
    });
    if (userBErr || !userB) throw userBErr ?? new Error("failed to create user B");
    userBId = userB.user.id;

    const { error: memErr } = await admin.from("memberships").insert({ user_id: userBId, restaurant_id: restaurantB, role: "staff" } as never);
    if (memErr) throw memErr;

    // One wine per tenant. Service role, because tenant A has no member here
    // and we only need the rows to exist.
    const { data: wines, error: wineErr } = await admin.from("wines").insert([
      { restaurant_id: restaurantA, name: "Tenant A Cuvee", producer: "Ownership Estate", size_ml: 750 },
      { restaurant_id: restaurantB, name: "Tenant B Cuvee", producer: "Ownership Estate", size_ml: 750 },
    ] as never).select("id, restaurant_id");
    if (wineErr || !wines) throw wineErr ?? new Error("failed to insert wines");
    const rows = wines as { id: string; restaurant_id: string }[];
    wineA = rows.find((w) => w.restaurant_id === restaurantA)!.id;
    wineB = rows.find((w) => w.restaurant_id === restaurantB)!.id;

    const { data: rc, error: rcErr } = await admin.from("reason_codes").insert({
      restaurant_id: restaurantB, code: "ownership-test", label: "Ownership Test", category: "adjustment", active: true,
    } as never).select("id").single();
    if (rcErr || !rc) throw rcErr ?? new Error("failed to insert reason code");
    reasonCodeB = (rc as { id: string }).id;

    userBClient = await signedInClient(userB.user.email!, password);
  });

  afterAll(async () => {
    await admin.from("restaurants").delete().in("id", [restaurantA, restaurantB]);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
  });

  it("refuses a stock_adjustment naming another tenant's wine", async () => {
    const { error } = await userBClient.from("stock_adjustments").insert({
      restaurant_id: restaurantB,
      wine_id: wineA, // tenant A's wine — the whole point
      kind: "adjustment",
      bottles: -1,
      ml: 0,
      reason_code_id: reasonCodeB,
      acting_user_id: userBId,
    } as never);

    // Every other clause of the policy is satisfied: B is a member of B, and
    // acting_user_id is genuinely B. Only wine ownership can reject this.
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security|violates/i);
  });

  it("still allows a stock_adjustment naming the tenant's own wine", async () => {
    const { error } = await userBClient.from("stock_adjustments").insert({
      restaurant_id: restaurantB,
      wine_id: wineB,
      kind: "adjustment",
      bottles: -1,
      ml: 0,
      reason_code_id: reasonCodeB,
      acting_user_id: userBId,
    } as never);
    expect(error).toBeNull();
  });

  it("refuses a bottle_closeout naming another tenant's wine", async () => {
    const { error } = await userBClient.from("bottle_closeouts").insert({
      restaurant_id: restaurantB,
      wine_id: wineA,
      preservation_method: "none",
      theoretical_remaining_ml: 100,
      actual_remaining_ml: 100,
    } as never);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security|violates/i);
  });

  it("still allows a bottle_closeout naming the tenant's own wine", async () => {
    const { error } = await userBClient.from("bottle_closeouts").insert({
      restaurant_id: restaurantB,
      wine_id: wineB,
      preservation_method: "none",
      theoretical_remaining_ml: 100,
      actual_remaining_ml: 100,
    } as never);
    expect(error).toBeNull();
  });

  it("a tenant deleting its own wine cannot reach another tenant's rows", async () => {
    // The end-to-end statement of the defect. With the ownership check in
    // place, tenant B's rows can only ever name tenant B's wines, so a
    // delete of tenant A's wine has nothing of B's to cascade into.
    const { count: before } = await admin
      .from("stock_adjustments")
      .select("id", { count: "exact", head: true })
      .eq("restaurant_id", restaurantB);

    const { error: delErr } = await admin.from("wines").delete().eq("id", wineA);
    expect(delErr).toBeNull();

    const { count: after } = await admin
      .from("stock_adjustments")
      .select("id", { count: "exact", head: true })
      .eq("restaurant_id", restaurantB);

    expect(after).toBe(before);
  });
});
