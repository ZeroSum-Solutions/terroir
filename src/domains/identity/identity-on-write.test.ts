// P2→P3 seam closure — identity is populated ON WRITE, not only by the
// one-shot 0101 backfill.
//
// The gap this suite exists to close: 0097-0101 built canonical_wines,
// wine_variants and resolve_wine_variants_bulk, and 0101 backfilled the
// wines rows that existed at that moment. Nothing then called
// resolve_wine_variants_bulk again — grep for `.rpc("resolve_wine_variants
// _bulk"` finds callers only in tenant-isolation.test.ts. So every wine
// created after 0101 ran carried wine_variant_id IS NULL and (via the
// wines_derive_canonical_wine_id trigger, 0098) canonical_wine_id IS NULL
// forever. Measured on a freshly seeded local stack before this suite
// landed: 250 wines, 0 with either column set, and canonical_wines /
// wine_variants / wine_aliases all empty.
//
// That is not a cosmetic gap. src/lib/wine-intelligence/xwines-profile.ts
// prefers the canonical_wine_id link when set (0132) and silently falls
// back when it is not, so the whole spine degraded to dead weight.
//
// MANDATORY live-DB suite, same convention as tenant-isolation.test.ts:
// find_or_create_wines_batch and resolve_wine_variants_bulk are both
// SECURITY INVOKER, so RLS is the tenant boundary and a mocked client
// cannot prove any of this.
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

const PRODUCER = "Identity On Write Estate";

describe.skipIf(!hasLiveDb)("identity is populated on write (MANDATORY)", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let restaurantA: string;
  let restaurantB: string;
  let userAClient: SupabaseClient<Database>;
  let userBClient: SupabaseClient<Database>;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });

    const { data: rA, error: rAErr } = await admin.from("restaurants").insert({ name: "Identity OnWrite A" } as never).select("id").single();
    if (rAErr || !rA) throw rAErr ?? new Error("failed to insert restaurant A");
    restaurantA = (rA as { id: string }).id;

    const { data: rB, error: rBErr } = await admin.from("restaurants").insert({ name: "Identity OnWrite B" } as never).select("id").single();
    if (rBErr || !rB) throw rBErr ?? new Error("failed to insert restaurant B");
    restaurantB = (rB as { id: string }).id;

    const run = Date.now();
    const password = "Identity-OnWrite-Test-123!";

    const { data: userA, error: userAErr } = await admin.auth.admin.createUser({
      email: `identity-onwrite-a-${run}@terroir.test`,
      password,
      email_confirm: true,
    });
    if (userAErr || !userA) throw userAErr ?? new Error("failed to create user A");
    userAId = userA.user.id;

    const { data: userB, error: userBErr } = await admin.auth.admin.createUser({
      email: `identity-onwrite-b-${run}@terroir.test`,
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
    userBClient = await signedInClient(userB.user.email!, password);
  });

  afterAll(async () => {
    // restaurants CASCADE covers memberships/wines/wine_variants.
    // canonical_wines is global — never reached by a restaurant delete.
    const { data: canonRows } = await admin
      .from("canonical_wines")
      .select("id")
      .like("producer", `${PRODUCER}%`);
    await admin.from("restaurants").delete().in("id", [restaurantA, restaurantB]);
    if (canonRows && canonRows.length > 0) {
      await admin.from("canonical_wines").delete().in("id", (canonRows as { id: string }[]).map((r) => r.id));
    }
    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
  });

  async function readIdentity(wineId: string) {
    const { data, error } = await admin
      .from("wines")
      .select("id, wine_variant_id, canonical_wine_id")
      .eq("id", wineId)
      .single();
    if (error || !data) throw error ?? new Error("wine not found");
    return data as { id: string; wine_variant_id: string | null; canonical_wine_id: string | null };
  }

  async function createWine(client: SupabaseClient<Database>, restaurantId: string, cuvee: string, vintage: number | null) {
    const { data, error } = await client.rpc("find_or_create_wines_batch", {
      p_restaurant_id: restaurantId,
      p_wines: [{ name: cuvee, producer: PRODUCER, vintage, size_ml: 750 }],
    } as never);
    if (error) throw error;
    const ids = data as string[];
    expect(ids).toHaveLength(1);
    return ids[0];
  }

  it("find_or_create_wines_batch resolves identity for a newly created wine", async () => {
    const wineId = await createWine(userAClient, restaurantA, "Grand Vin", 2019);
    const wine = await readIdentity(wineId);

    expect(wine.wine_variant_id).not.toBeNull();
    // wines_derive_canonical_wine_id (0098) is a BEFORE trigger on
    // wine_variant_id, so canonical must follow from variant without any
    // second write.
    expect(wine.canonical_wine_id).not.toBeNull();
  });

  it("resolving the same wine twice reuses one variant rather than forking a second", async () => {
    const first = await createWine(userAClient, restaurantA, "Reserve", 2020);
    const second = await createWine(userAClient, restaurantA, "Reserve", 2020);
    expect(second).toBe(first);

    const wine = await readIdentity(first);
    expect(wine.wine_variant_id).not.toBeNull();

    const { data: variants } = await admin
      .from("wine_variants")
      .select("id")
      .eq("restaurant_id", restaurantA)
      .eq("id", wine.wine_variant_id!);
    expect(variants).toHaveLength(1);
  });

  it("two tenants holding the same wine get separate variants under one canonical row", async () => {
    // The entire point of the spine: variants are tenant-scoped,
    // canonical_wines is global. Same producer/cuvee/vintage/size from
    // two restaurants must converge on one canonical identity while
    // keeping the tenant boundary at the variant level.
    const wineA = await createWine(userAClient, restaurantA, "Cross Tenant Cuvee", 2018);
    const wineB = await createWine(userBClient, restaurantB, "Cross Tenant Cuvee", 2018);

    const a = await readIdentity(wineA);
    const b = await readIdentity(wineB);

    expect(a.wine_variant_id).not.toBeNull();
    expect(b.wine_variant_id).not.toBeNull();
    expect(a.canonical_wine_id).not.toBeNull();

    expect(a.wine_variant_id).not.toBe(b.wine_variant_id);
    expect(a.canonical_wine_id).toBe(b.canonical_wine_id);
  });

  it("a wine whose producer and cuvee normalize to nothing is still created, just unresolved", async () => {
    // resolve_wine_variants_bulk (0099) deliberately drops rows whose
    // producer/cuvee collapse under normalization rather than inventing a
    // placeholder identity. Wine creation must not fail because of it —
    // an unresolvable name is a data-quality problem, not a write error.
    const { data, error } = await userAClient.rpc("find_or_create_wines_batch", {
      p_restaurant_id: restaurantA,
      p_wines: [{ name: "...", producer: "---", vintage: 2019, size_ml: 750 }],
    } as never);
    expect(error).toBeNull();

    const wineId = (data as string[])[0];
    expect(wineId).toBeTruthy();
    const wine = await readIdentity(wineId);
    expect(wine.wine_variant_id).toBeNull();
    expect(wine.canonical_wine_id).toBeNull();
  });
});
