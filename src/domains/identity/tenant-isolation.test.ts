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

// P2 ROUND-6 (D9-residual #2): payloads carry RAW text only. The RPC
// derives producer_norm/cuvee_norm itself and canonical_wines GENERATES
// them from producer/cuvee, so there is no longer any caller-supplied
// identity key to send — which is the point of the fix. jsonb_to_recordset
// in 0099 no longer names those keys either, so a payload that still sent
// them would be silently ignored rather than silently trusted.
function variantPayload(idx: number, producer: string, cuvee: string, vintage: number | null, sizeMl = 750) {
  return {
    idx,
    producer_raw: producer,
    cuvee_raw: cuvee,
    vintage,
    size_ml: sizeMl,
  };
}

describe.skipIf(!hasLiveDb)("P2 resolve_wine_variants_bulk: cross-tenant containment (MANDATORY)", () => {
  let admin: SupabaseClient<Database>;
  let restaurantA: string;
  let restaurantB: string;
  let userAClient: SupabaseClient<Database>;
  let userBClient: SupabaseClient<Database>;
  let userAId: string;
  let userBId: string;
  const d9LwinId = String(1000000 + (Date.now() % 8999999)).padStart(7, "0").slice(0, 7);

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
    userBClient = await signedInClient(userB.user.email!, password);
  });

  afterAll(async () => {
    // Cascades: memberships, wines, wine_variants (restaurant_id) all FK
    // restaurant_id ON DELETE CASCADE. canonical_wines is global and
    // never touched by restaurant deletion — clean up explicitly.
    const { data: canonRows } = await admin
      .from("canonical_wines")
      .select("id")
      .or("producer.like.P2 RWVB%,producer.like.P2 Concurrent%,producer.like.P2 D9%,producer.like.Chateau Pichon Longueville%");
    await admin.from("restaurants").delete().in("id", [restaurantA, restaurantB]);
    if (canonRows && canonRows.length > 0) {
      await admin.from("canonical_wines").delete().in("id", (canonRows as { id: string }[]).map((r) => r.id));
    }
    await admin.from("lwin_catalog").delete().eq("lwin_id", d9LwinId);
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
      .eq("producer", producer)
      .eq("cuvee", cuvee);
    expect(canonicalRows).toHaveLength(1);

    const { data: variantRows } = await admin
      .from("wine_variants")
      .select("id")
      .eq("restaurant_id", restaurantA)
      .eq("canonical_wine_id", [...canonicalIds][0]);
    expect(variantRows).toHaveLength(1);
  });

  // P2 round-4 (D9 — scratchpad db-audit/verify/P2-critic-r3.md): the
  // full cross-tenant LWIN-hijack chain, reproduced end to end through
  // the real RPC as two real signed-in tenants, then shown to no longer
  // happen. Before the fix (verified live in a rolled-back transaction,
  // not asserted here since it requires temporarily swapping in the old
  // function/policy — see the round-4 report): an attacker at tenant A
  // submits garbage producer/cuvee text with a REAL wine's lwin7; that
  // squats canonical_wines_lwin7_idx (UNIQUE) as identity_status=
  // 'lwin_verified'. A victim at tenant B later imports the SAME real
  // wine with correct producer/cuvee text and the same lwin7; because
  // LWIN-exact deterministically wins over producer/cuvée text (by
  // design, for the legitimate data-entry-error case), the victim's
  // resolve_wine_variants_bulk call binds their inventory to the
  // attacker-controlled garbage-labeled canonical row — with no
  // UPDATE/DELETE policy on canonical_wines, the victim cannot repair
  // this themselves.
  it("D9 fix: a tenant cannot squat a real LWIN with garbage text to hijack another tenant's later correct import", async () => {
    const { error: catalogErr } = await admin.from("lwin_catalog").insert({
      lwin_id: d9LwinId,
      display_name: "P2 D9 Real Producer Real Wine",
      producer: "P2 D9 Real Producer",
    } as never);
    expect(catalogErr).toBeNull();

    // ATTACKER (tenant A): garbage producer/cuvee, but the REAL lwin7.
    const { data: attackerData, error: attackerError } = await userAClient.rpc("resolve_wine_variants_bulk", {
      p_restaurant_id: restaurantA,
      p_variants: [
        {
          idx: 0,
          producer_raw: "P2 D9 Garbage Import Co",
          cuvee_raw: "Junk Label",
          vintage: 2020,
          size_ml: 750,
          lwin7: d9LwinId,
        },
      ],
    } as never);
    expect(attackerError).toBeNull();
    const attackerCanonicalId = (attackerData as { canonical_wine_id: string }[])[0].canonical_wine_id;

    // The attacker's canonical row must NOT have squatted the LWIN — it
    // should be downgraded to unverified with lwin7 stripped, per the
    // fix's own documented "downgrade, don't abort the batch" behavior.
    const { data: attackerCanonRow } = await admin
      .from("canonical_wines")
      .select("identity_status, lwin7")
      .eq("id", attackerCanonicalId)
      .single();
    expect(attackerCanonRow).toMatchObject({ identity_status: "unverified", lwin7: null });

    // VICTIM (tenant B): correct producer/cuvee, the same real lwin7.
    const { data: victimData, error: victimError } = await userBClient.rpc("resolve_wine_variants_bulk", {
      p_restaurant_id: restaurantB,
      p_variants: [
        {
          idx: 0,
          producer_raw: "P2 D9 Real Producer",
          cuvee_raw: "Real Wine",
          vintage: 2020,
          size_ml: 750,
          lwin7: d9LwinId,
        },
      ],
    } as never);
    expect(victimError).toBeNull();
    const victimCanonicalId = (victimData as { canonical_wine_id: string }[])[0].canonical_wine_id;

    // THE HIJACK CHECK: the victim's canonical identity must be a
    // DIFFERENT row from the attacker's — no binding to attacker-
    // controlled state.
    expect(victimCanonicalId).not.toBe(attackerCanonicalId);

    // The victim's row is the legitimately LWIN-verified one, with the
    // correct producer text and the real lwin7 actually recorded.
    const { data: victimCanonRow } = await admin
      .from("canonical_wines")
      .select("producer, identity_status, lwin7")
      .eq("id", victimCanonicalId)
      .single();
    expect(victimCanonRow).toMatchObject({
      producer: "P2 D9 Real Producer",
      identity_status: "lwin_verified",
      lwin7: d9LwinId,
    });
  });

  // P2 round-5 (D9-residual — scratchpad db-audit/verify/P2-critic-r4.md):
  // the DECISIVE pair. Round 4's fix used pg_trgm similarity() at
  // match_lwin's own ranking thresholds (0.3 producer / 0.21 name) — the
  // wrong tool for a permanent, cross-tenant, unrepairable decision.
  // Pichon Baron vs Pichon Longueville Comtesse de Lalande — two REAL,
  // DISTINCT Bordeaux estates that share a long common name prefix —
  // scored 0.55/0.55 under that check, comfortably above both
  // thresholds. NO ATTACKER IS INVOLVED in this test: both tenants
  // submit their OWN correct, legitimately-typed producer/cuvee text.
  // Tenant A happens to submit Lalande's real wine with (by a plausible
  // C24-style LWIN-matcher mix-up) Baron's real lwin7; tenant B later
  // submits Baron's real wine with the same real lwin7. Under the round-4
  // fuzzy gate this hijacked exactly like the attacker scenario above,
  // proving the vulnerability needed no adversary at all — just two real
  // wines whose names overlap.
  it("D9-residual fix: Pichon Baron and Pichon Longueville Comtesse de Lalande never cross-bind, even with no attacker involved", async () => {
    const baronLwinId = String(2000000 + (Date.now() % 7999999))
      .padStart(7, "0")
      .slice(0, 7);
    const { error: catalogErr } = await admin.from("lwin_catalog").insert({
      lwin_id: baronLwinId,
      display_name: "Chateau Pichon Longueville Baron Grand Vin",
      producer: "Chateau Pichon Longueville Baron",
    } as never);
    expect(catalogErr).toBeNull();

    // Tenant A: Lalande's OWN correct text, with Baron's real lwin7.
    const { data: lalandeData, error: lalandeError } = await userAClient.rpc("resolve_wine_variants_bulk", {
      p_restaurant_id: restaurantA,
      p_variants: [
        {
          idx: 0,
          producer_raw: "Chateau Pichon Longueville Comtesse de Lalande",
          cuvee_raw: "Grand Vin",
          vintage: 2018,
          size_ml: 750,
          lwin7: baronLwinId,
        },
      ],
    } as never);
    expect(lalandeError).toBeNull();
    const lalandeCanonicalId = (lalandeData as { canonical_wine_id: string }[])[0].canonical_wine_id;

    // Must be downgraded — genuinely different producer text than the
    // catalog row for this lwin7, not "similar enough."
    const { data: lalandeCanonRow } = await admin
      .from("canonical_wines")
      .select("identity_status, lwin7")
      .eq("id", lalandeCanonicalId)
      .single();
    expect(lalandeCanonRow).toMatchObject({ identity_status: "unverified", lwin7: null });

    // Tenant B: Baron's OWN correct text, the SAME real lwin7.
    const { data: baronData, error: baronError } = await userBClient.rpc("resolve_wine_variants_bulk", {
      p_restaurant_id: restaurantB,
      p_variants: [
        {
          idx: 0,
          producer_raw: "Chateau Pichon Longueville Baron",
          cuvee_raw: "Grand Vin",
          vintage: 2018,
          size_ml: 750,
          lwin7: baronLwinId,
        },
      ],
    } as never);
    expect(baronError).toBeNull();
    const baronCanonicalId = (baronData as { canonical_wine_id: string }[])[0].canonical_wine_id;

    // THE DECISIVE CHECK: Baron and Lalande must never share a canonical
    // identity.
    expect(baronCanonicalId).not.toBe(lalandeCanonicalId);

    const { data: baronCanonRow } = await admin
      .from("canonical_wines")
      .select("producer, identity_status, lwin7")
      .eq("id", baronCanonicalId)
      .single();
    expect(baronCanonRow).toMatchObject({
      producer: "Chateau Pichon Longueville Baron",
      identity_status: "lwin_verified",
      lwin7: baronLwinId,
    });
  });

  // P2 round-5 (D9-residual): the unverified-squat path closed
  // universally. Round 4's corroboration check only ever gated the
  // 'lwin_verified' insert branch — an 'unverified' row could carry a
  // real lwin7 with NO corroboration check running at all, and
  // resolve_wine_variants_bulk's LWIN-exact match had no identity_status
  // filter, so that squatted lwin7 would still capture every later
  // legitimate import carrying the same number. The fix
  // (canonical_wines_lwin7_requires_verified) is a table-level CHECK
  // CONSTRAINT, not an RLS policy clause — this test proves it is
  // universal by attempting the squat as service_role, which bypasses
  // RLS entirely (the same role 0101's backfill runs under).
  it("D9-residual fix: an unverified row can never carry a claimed lwin7, even via service_role (RLS bypass)", async () => {
    const { error } = await admin.from("canonical_wines").insert({
      producer: "P2 D9r5 Squatter",
      cuvee: "Junk Label",
      identity_status: "unverified",
      lwin7: d9LwinId,
    } as never);
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/canonical_wines_lwin7_requires_verified|check constraint/i);
  });

  // P2 round-6 (D9-residual #2) — THE SECOND, DISTINCT HIJACK INSTANCE,
  // and the one this round exists to close. Rounds 4 and 5 both attacked
  // the CORROBORATION GATE (first its fuzzy threshold, then the
  // unverified-squat bypass). This vulnerability needed neither: the gate
  // corroborated producer/cuvee while the row was KEYED on producer_norm/
  // cuvee_norm — a different pair of caller-supplied fields that nothing
  // bound to the first.
  //
  // So the attacker never has to beat the gate. They submit raws for a
  // wine they legitimately own, whose lwin7 genuinely corroborates, plus
  // norms naming the victim's wine. The gate passes on the raws; the row
  // lands on the victim's identity key. Live-reproduced end to end before
  // the fix: a row reading producer='Attacker Real Estate' was stored with
  // producer_norm='estate real victim', and the victim's own correct
  // import then bound to it (canonical_match_method='exact',
  // canonical_created=false) — permanently, since the identity index is
  // UNIQUE and this table grants authenticated no UPDATE or DELETE.
  //
  // Both columns are now GENERATED ALWAYS from producer/cuvee, so the
  // attack is not blocked, it is unrepresentable — at the database, for
  // every role including service_role. (The generated Insert type still
  // lists both as optional fields — `supabase gen types` emits generated
  // columns that way — so the defense is the column definition alone,
  // never the types.) `as never` below keeps this test independent of
  // whatever the generated types happen to say.
  it("D9-residual #2 fix: a caller cannot key a canonical row on anything but its own producer/cuvee, even with honest corroborating raws", async () => {
    const victimProducer = "P2 D9r6 Victim Estate";
    const victimCuvee = "Victim Grand Vin";

    // The victim's legitimate row, created the normal way.
    const { data: victimData, error: victimError } = await userBClient.rpc("resolve_wine_variants_bulk", {
      p_restaurant_id: restaurantB,
      p_variants: [variantPayload(0, victimProducer, victimCuvee, 2019)],
    } as never);
    expect(victimError).toBeNull();
    const victimCanonicalId = (victimData as { canonical_wine_id: string }[])[0].canonical_wine_id;

    const { data: victimRow } = await admin
      .from("canonical_wines")
      .select("producer_norm, cuvee_norm")
      .eq("id", victimCanonicalId)
      .single();
    const victimKey = victimRow as { producer_norm: string; cuvee_norm: string };

    // THE ATTACK: attacker's own honest raws, victim's identity key.
    const { error: attackError } = await admin.from("canonical_wines").insert({
      producer: "P2 D9r6 Attacker Estate",
      cuvee: "Attacker Grand Vin",
      producer_norm: victimKey.producer_norm,
      cuvee_norm: victimKey.cuvee_norm,
      identity_status: "unverified",
    } as never);
    expect(attackError).not.toBeNull();
    // 428C9 = "cannot insert a non-DEFAULT value into a generated column".
    // Asserted by code, not message text, so a Postgres wording change
    // cannot quietly turn this into a pass.
    expect((attackError as { code?: string } | null)?.code).toBe("428C9");

    // The victim's row is untouched and still theirs.
    const { data: afterRow } = await admin
      .from("canonical_wines")
      .select("id, producer")
      .eq("producer_norm", victimKey.producer_norm)
      .eq("cuvee_norm", victimKey.cuvee_norm);
    expect(afterRow).toHaveLength(1);
    expect((afterRow as { id: string; producer: string }[])[0]).toMatchObject({
      id: victimCanonicalId,
      producer: victimProducer,
    });

    // POSITIVE CONTROL: the attacker's own wine still resolves normally
    // under its OWN key. A fix that simply refused these inserts would
    // pass every assertion above and still be broken.
    const { data: attackerData, error: attackerOk } = await userAClient.rpc("resolve_wine_variants_bulk", {
      p_restaurant_id: restaurantA,
      p_variants: [variantPayload(0, "P2 D9r6 Attacker Estate", "Attacker Grand Vin", 2019)],
    } as never);
    expect(attackerOk).toBeNull();
    const attackerCanonicalId = (attackerData as { canonical_wine_id: string }[])[0].canonical_wine_id;
    expect(attackerCanonicalId).not.toBe(victimCanonicalId);

    await admin.from("canonical_wines").delete().in("id", [victimCanonicalId, attackerCanonicalId]);
  });
});
