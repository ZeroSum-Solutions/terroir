// P2 — MANDATORY two-tenant fixture test for resolve_wine_variants_bulk.
//
// resolve_wine_variants_bulk is SECURITY INVOKER (0099): RLS on
// wine_variants is the tenant boundary, not a check in the function body
// (see that migration's header comment for why). A mocked Supabase
// client can't prove RLS actually blocks anything; this needs a real
// Postgres with a real authenticated session, following the same
// convention src/domains/import/tenant-isolation.test.ts's header calls
// MANDATORY.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasLiveDb = Boolean(supabaseUrl && publishableKey && serviceRoleKey);

async function signedInClient(email: string, password: string): Promise<SupabaseClient<Database>> {
  const throwaway = createClient<Database>(supabaseUrl!, publishableKey!, { auth: { persistSession: false } });
  const { data, error } = await throwaway.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw error ?? new Error(`sign-in failed for ${email}`);
  return createClient<Database>(supabaseUrl!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

function variantPayload(idx: number, producer: string, cuvee: string, vintage: number | null, sizeMl = 750) {
  return {
    idx,
    producer_raw: producer,
    cuvee_raw: cuvee,
    producer_norm: producer.toLowerCase(),
    cuvee_norm: cuvee.toLowerCase(),
    vintage,
    size_ml: sizeMl,
  };
}

describe.skipIf(!hasLiveDb)("P2 resolve_wine_variants_bulk: cross-tenant containment (MANDATORY)", () => {
  let admin: SupabaseClient<Database>;
  let restaurantA: string;
  let restaurantB: string;
  let userAClient: SupabaseClient<Database>;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });

    const { data: rA, error: rAErr } = await admin.from("restaurants").insert({ name: "P2 RWVB Tenant A" } as never).select("id").single();
    if (rAErr || !rA) throw rAErr ?? new Error("failed to insert restaurant A");
    restaurantA = (rA as { id: string }).id;

    const { data: rB, error: rBErr } = await admin.from("restaurants").insert({ name: "P2 RWVB Tenant B" } as never).select("id").single();
    if (rBErr || !rB) throw rBErr ?? new Error("failed to insert restaurant B");
    restaurantB = (rB as { id: string }).id;

    const run = Date.now();
    const password = "P2-RWVB-Tenant-Test-123!";

    const { data: userA, error: userAErr } = await admin.auth.admin.createUser({
      email: `p2-rwvb-tenant-a-${run}@terroir.test`,
      password,
      email_confirm: true,
    });
    if (userAErr || !userA) throw userAErr ?? new Error("failed to create user A");
    userAId = userA.user.id;

    const { data: userB, error: userBErr } = await admin.auth.admin.createUser({
      email: `p2-rwvb-tenant-b-${run}@terroir.test`,
      password,
      email_confirm: true,
    });
    if (userBErr || !userB) throw userBErr ?? new Error("failed to create user B");
    userBId = userB.user.id;

    const { error: memAErr } = await admin.from("memberships").insert({ user_id: userAId, restaurant_id: restaurantA, role: "staff" } as never);
    if (memAErr) throw memAErr;
    const { error: memBErr } = await admin.from("memberships").insert({ user_id: userBId, restaurant_id: restaurantB, role: "staff" } as never);
    if (memBErr) throw memBErr;

    userAClient = await signedInClient(userA.user.email!, password);
  });

  afterAll(async () => {
    // Cascades: memberships, wines, wine_variants (restaurant_id) all FK
    // restaurant_id ON DELETE CASCADE. canonical_wines is global and
    // never touched by restaurant deletion — clean up explicitly.
    const { data: canonRows } = await admin
      .from("canonical_wines")
      .select("id")
      .or("producer_norm.like.p2 rwvb%,producer_norm.like.p2 concurrent%");
    await admin.from("restaurants").delete().in("id", [restaurantA, restaurantB]);
    if (canonRows && canonRows.length > 0) {
      await admin.from("canonical_wines").delete().in("id", (canonRows as { id: string }[]).map((r) => r.id));
    }
    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
  });

  it("tenant A's resolve_wine_variants_bulk targeting tenant B's restaurant_id fails via RLS, not a manual check", async () => {
    const { error } = await userAClient.rpc("resolve_wine_variants_bulk", {
      p_restaurant_id: restaurantB,
      p_variants: [variantPayload(0, "P2 RWVB Cross Tenant Producer", "Cross Tenant Cuvee", 2019)],
    } as never);

    // RLS blocks the INSERT into wine_variants (restaurant_id = B, caller
    // is only a member of A) — a real policy violation, not an empty
    // success. The wine_variants insert policy failing surfaces as a
    // row-level security error from PostgREST.
    expect(error).not.toBeNull();

    // Confirm nothing was written under B regardless of the error shape.
    const { data: variantsUnderB } = await admin.from("wine_variants").select("id").eq("restaurant_id", restaurantB);
    expect(variantsUnderB ?? []).toHaveLength(0);
  });

  it("tenant A can resolve its own variants normally (sanity: the RLS block above is tenancy-specific, not a general failure)", async () => {
    const { data, error } = await userAClient.rpc("resolve_wine_variants_bulk", {
      p_restaurant_id: restaurantA,
      p_variants: [variantPayload(0, "P2 RWVB Own Producer", "Own Cuvee", 2019)],
    } as never);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((data as { canonical_created: boolean }[])[0].canonical_created).toBe(true);
  });

  it("concurrent overlapping resolve_wine_variants_bulk calls for the same new wine produce exactly one canonical row and one variant row (no duplicates under real concurrency)", async () => {
    const producer = "P2 Concurrent Producer";
    const cuvee = "Concurrent Cuvee";

    const calls = Array.from({ length: 5 }, () =>
      userAClient.rpc("resolve_wine_variants_bulk", {
        p_restaurant_id: restaurantA,
        p_variants: [variantPayload(0, producer, cuvee, 2022)],
      } as never),
    );
    const results = await Promise.all(calls);
    for (const r of results) {
      expect(r.error).toBeNull();
    }

    const canonicalIds = new Set((results as { data: { canonical_wine_id: string }[] }[]).map((r) => r.data[0].canonical_wine_id));
    const variantIds = new Set((results as { data: { wine_variant_id: string }[] }[]).map((r) => r.data[0].wine_variant_id));
    expect(canonicalIds.size).toBe(1);
    expect(variantIds.size).toBe(1);

    const { data: canonicalRows } = await admin
      .from("canonical_wines")
      .select("id")
      .eq("producer_norm", producer.toLowerCase())
      .eq("cuvee_norm", cuvee.toLowerCase());
    expect(canonicalRows).toHaveLength(1);

    const { data: variantRows } = await admin
      .from("wine_variants")
      .select("id")
      .eq("restaurant_id", restaurantA)
      .eq("canonical_wine_id", [...canonicalIds][0]);
    expect(variantRows).toHaveLength(1);
  });
});
