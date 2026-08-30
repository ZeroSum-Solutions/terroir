// MANDATORY live-DB suite. The thing under test is a Postgres RLS boundary, so
// it cannot be exercised against a mock: the only honest assertion is what a
// real authenticated session gets back from a real table.
//
// 0137 repaired 956 production wines' `producer` and recorded each prior value
// in producer_backfill_audit so the repair is reversible. That table is
// operator-facing: it names wines and restaurants across every tenant, and it
// exists to be read by a down migration under service_role, never by an
// application session. It carries RLS ON with NO POLICY, which is the deny-all
// shape — easy to get right, and just as easy to undo by adding a well-meaning
// policy later. This suite is what notices if someone does.
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

describe.skipIf(!hasLiveDb)("producer_backfill_audit is operator-only (MANDATORY)", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let userClient: SupabaseClient<Database>;
  let restaurantId: string;
  let wineId: string;
  let userId: string;
  const email = `producer-audit-${Date.now()}@example.test`;
  const password = "test-password-1234";

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });

    const { data: r, error: rErr } = await admin
      .from("restaurants").insert({ name: "Producer Audit Co" } as never).select("id").single();
    if (rErr || !r) throw rErr ?? new Error("failed to insert restaurant");
    restaurantId = (r as { id: string }).id;

    const { data: u, error: uErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (uErr || !u.user) throw uErr ?? new Error("failed to create user");
    userId = u.user.id;

    const { error: mErr } = await admin
      .from("memberships").insert({ restaurant_id: restaurantId, user_id: userId, role: "owner" } as never);
    if (mErr) throw mErr;

    const { data: w, error: wErr } = await admin
      .from("wines")
      .insert({ restaurant_id: restaurantId, name: "Audit Estate Grand Vin", producer: "Audit Estate", size_ml: 750 } as never)
      .select("id").single();
    if (wErr || !w) throw wErr ?? new Error("failed to insert wine");
    wineId = (w as { id: string }).id;

    // A row this tenant's own member would most plausibly be allowed to see —
    // it is about their own wine, in their own restaurant. If anything leaks,
    // this is the row that leaks.
    const { error: aErr } = await admin.from("producer_backfill_audit").insert({
      wine_id: wineId,
      restaurant_id: restaurantId,
      old_producer: "",
      new_producer: "Audit Estate",
      matched_words: 2,
    } as never);
    if (aErr) throw aErr;

    const throwaway = createClient<Database>(supabaseUrl!, publishableKey!, { auth: { persistSession: false } });
    const { data: s, error: sErr } = await throwaway.auth.signInWithPassword({ email, password });
    if (sErr || !s.session) throw sErr ?? new Error("sign-in failed");
    userClient = createClient<Database>(supabaseUrl!, publishableKey!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${s.session.access_token}` } },
    });
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("producer_backfill_audit").delete().eq("restaurant_id", restaurantId);
    await admin.from("wines").delete().eq("restaurant_id", restaurantId);
    await admin.from("restaurants").delete().eq("id", restaurantId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it("an owner cannot read the audit row for their own wine", async () => {
    const { data, error } = await userClient
      .from("producer_backfill_audit").select("*").eq("wine_id", wineId);

    // RLS with no policy filters rather than raises: the honest assertion is
    // that nothing comes back, not that an error did.
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("an owner cannot write to it either", async () => {
    const { error } = await userClient.from("producer_backfill_audit").insert({
      wine_id: wineId,
      restaurant_id: restaurantId,
      old_producer: "forged",
      new_producer: "forged",
      matched_words: 1,
    } as never);

    expect(error).not.toBeNull();
  });

  it("service_role still reaches it, or the down migration cannot revert", async () => {
    // The deny-all is only correct if it stays asymmetric. 0137's down reads
    // this table to restore prior producers; a change that locked out
    // service_role too would make the repair irreversible.
    const { data, error } = await admin
      .from("producer_backfill_audit").select("old_producer,new_producer").eq("wine_id", wineId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ old_producer: "", new_producer: "Audit Estate" });
  });
});
