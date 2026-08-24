// P2 — live-database merge tests for merge_wines (extended, C23 fix) and
// merge_canonical_wines (operator/service-role only).
//
// Requires a live local Supabase (same convention as
// src/domains/import/tenant-isolation.test.ts and
// src/lib/jobs/tenant-isolation.test.ts) — skipped when
// NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY /
// SUPABASE_SERVICE_ROLE_KEY aren't set. Fixture setup uses the
// service-role ("admin") client throughout (bypasses RLS entirely) so
// every one of the 10 confirmed live FKs to wines(id) can be populated
// directly, mirroring scratchpad db-audit/verify/V4-bottles.md's own C23
// reproduction methodology; the actual merge_wines/merge_canonical_wines
// CALLS run through real signed-in sessions so RLS/role checks are
// genuinely exercised, not bypassed.
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

describe.skipIf(!hasLiveDb)("P2 merge_wines / merge_canonical_wines (MANDATORY live-database tests)", () => {
  let admin: SupabaseClient<Database>;
  let restaurantA: string;
  let restaurantB: string;
  let ownerAClient: SupabaseClient<Database>;
  let ownerAId: string;
  const cleanupUserIds: string[] = [];
  const cleanupRestaurantIds: string[] = [];
  // canonical_wines is a global table with no restaurant_id — deleting
  // restaurantA/B cascades away every wine_variants row (and thus the
  // wines_canonical_wine_id_fkey ON DELETE RESTRICT that would otherwise
  // block it), but never touches canonical_wines itself. Track every id
  // created here and delete explicitly, AFTER restaurant cleanup, so
  // re-running this file never collides with a prior run's producer_norm/
  // cuvee_norm text.
  const cleanupCanonicalWineIds: string[] = [];

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });

    const { data: rA, error: rAErr } = await admin.from("restaurants").insert({ name: "P2 Merge Tenant A" } as never).select("id").single();
    if (rAErr || !rA) throw rAErr ?? new Error("failed to insert restaurant A");
    restaurantA = (rA as { id: string }).id;
    cleanupRestaurantIds.push(restaurantA);

    const { data: rB, error: rBErr } = await admin.from("restaurants").insert({ name: "P2 Merge Tenant B" } as never).select("id").single();
    if (rBErr || !rB) throw rBErr ?? new Error("failed to insert restaurant B");
    restaurantB = (rB as { id: string }).id;
    cleanupRestaurantIds.push(restaurantB);

    const run = Date.now();
    const password = "P2-Merge-Test-123!";
    const { data: userA, error: userAErr } = await admin.auth.admin.createUser({
      email: `p2-merge-owner-a-${run}@terroir.test`,
      password,
      email_confirm: true,
    });
    if (userAErr || !userA) throw userAErr ?? new Error("failed to create owner A");
    ownerAId = userA.user.id;
    cleanupUserIds.push(ownerAId);

    const { error: memAErr } = await admin.from("memberships").insert({
      user_id: ownerAId,
      restaurant_id: restaurantA,
      role: "owner",
    } as never);
    if (memAErr) throw memAErr;

    ownerAClient = await signedInClient(userA.user.email!, password);
  });

  afterAll(async () => {
    // wine_list_items/inventory_items/pour_events all reference wines(id)
    // ON DELETE RESTRICT (pre-existing, unrelated to P2). A plain
    // `DELETE FROM restaurants` relies on Postgres cascading wines'
    // OWN restaurant_id first — not guaranteed relative to the sibling
    // cascades that would otherwise clear those RESTRICT-constrained
    // children, and supabase-js does not throw on a failed delete unless
    // the caller checks `error`, so an ordering loss here previously
    // failed SILENTLY, leaving every fixture behind for the next run to
    // collide with. Delete explicitly, in FK-safe order, matching
    // scratchpad db-audit/verify/V4-bottles.md's own cleanup discipline.
    if (cleanupRestaurantIds.length > 0) {
      const { data: lists } = await admin.from("wine_lists").select("id").in("restaurant_id", cleanupRestaurantIds);
      const listIds = (lists ?? []).map((l) => (l as { id: string }).id);
      if (listIds.length > 0) {
        const { data: sections } = await admin.from("wine_list_sections").select("id").in("wine_list_id", listIds);
        const sectionIds = (sections ?? []).map((s) => (s as { id: string }).id);
        if (sectionIds.length > 0) {
          await admin.from("wine_list_items").delete().in("section_id", sectionIds);
        }
        await admin.from("wine_list_sections").delete().in("wine_list_id", listIds);
        await admin.from("wine_lists").delete().in("id", listIds);
      }
      await admin.from("inventory_items").delete().in("restaurant_id", cleanupRestaurantIds);
      await admin.from("pour_events").delete().in("restaurant_id", cleanupRestaurantIds);
      await admin.from("open_bottles").delete().in("restaurant_id", cleanupRestaurantIds);
      await admin.from("bottle_closeouts").delete().in("restaurant_id", cleanupRestaurantIds);
      await admin.from("stock_adjustments").delete().in("restaurant_id", cleanupRestaurantIds);
      await admin.from("pricing_recommendations").delete().in("restaurant_id", cleanupRestaurantIds);
      await admin.from("cellar_health").delete().in("restaurant_id", cleanupRestaurantIds);
      await admin.from("import_batch_rows").delete().in("restaurant_id", cleanupRestaurantIds);
      await admin.from("import_batches").delete().in("restaurant_id", cleanupRestaurantIds);
      await admin.from("availability_events").delete().in("restaurant_id", cleanupRestaurantIds);
      await admin.from("stock_adjustments").delete().in("restaurant_id", cleanupRestaurantIds);
      await admin.from("wine_variants").delete().in("restaurant_id", cleanupRestaurantIds);
      await admin.from("wines").delete().in("restaurant_id", cleanupRestaurantIds);
      await admin.from("reason_codes").delete().in("restaurant_id", cleanupRestaurantIds);
      const { error: restaurantDeleteError } = await admin.from("restaurants").delete().in("id", cleanupRestaurantIds);
      if (restaurantDeleteError) {
        // Surface loudly rather than the previous silent swallow — a
        // leftover restaurant here means the NEXT run's fixed producer/
        // cuvee_norm text will collide.
        console.error("P2 merge.test.ts cleanup: restaurant delete failed:", restaurantDeleteError);
      }
    }
    if (cleanupCanonicalWineIds.length > 0) {
      // Deleting an already-merged-away id via .in() is a no-op, not an
      // error — safe to list every id this file ever created, whether or
      // not a test's own merge already deleted it.
      const { error: canonDeleteError } = await admin.from("canonical_wines").delete().in("id", cleanupCanonicalWineIds);
      if (canonDeleteError) {
        console.error("P2 merge.test.ts cleanup: canonical_wines delete failed:", canonDeleteError);
      }
    }
    for (const id of cleanupUserIds) {
      await admin.auth.admin.deleteUser(id);
    }
  });

  it("merge_wines repoints all 10 live FK-to-wines child tables — zero rows lost (the C23 regression test)", async () => {
    // Two wines sharing one lineage/vintage/format so merge_wines' own
    // guards (lineage_mismatch_merge/cross_vintage_merge/format_mismatch_merge)
    // pass — insert directly via admin so both land under restaurantA with
    // an identical lwin_id (unifies lineage_id via the existing
    // derive_wine_lineage trigger).
    const sharedLwin = String(1000000 + (Date.now() % 9000000));
    const { data: sourceWine, error: sourceErr } = await admin
      .from("wines")
      .insert({ restaurant_id: restaurantA, name: "P2 Merge Source", producer: "P2 Merge Cellars", vintage: 2020, size_ml: 750, lwin_id: sharedLwin } as never)
      .select("id")
      .single();
    if (sourceErr || !sourceWine) throw sourceErr ?? new Error("failed to insert source wine");
    const sourceId = (sourceWine as { id: string }).id;

    const { data: targetWine, error: targetErr } = await admin
      .from("wines")
      .insert({ restaurant_id: restaurantA, name: "P2 Merge Target", producer: "P2 Merge Cellars", vintage: 2020, size_ml: 750, lwin_id: sharedLwin } as never)
      .select("id")
      .single();
    if (targetErr || !targetWine) throw targetErr ?? new Error("failed to insert target wine");
    const targetId = (targetWine as { id: string }).id;

    // Verify the trigger actually unified their lineage (a precondition
    // for merge_wines to even attempt the merge) before planting fixtures.
    const { data: lineageCheck } = await admin.from("wines").select("id, lineage_id").in("id", [sourceId, targetId]);
    const lineageIds = new Set((lineageCheck as { lineage_id: string }[]).map((w) => w.lineage_id));
    expect(lineageIds.size).toBe(1);

    // Plant exactly one row per confirmed live FK-to-wines child table,
    // pointing at the SOURCE wine.
    const { data: inv } = await admin.from("inventory_items").insert({ wine_id: sourceId, restaurant_id: restaurantA, quantity: 1, unit_cost: 10 } as never).select("id").single();
    const { data: pour } = await admin.from("pour_events").insert({ wine_id: sourceId, restaurant_id: restaurantA, ml_delta: -50, kind: "pour" } as never).select("id").single();
    const { data: bottle } = await admin.from("open_bottles").insert({ wine_id: sourceId, restaurant_id: restaurantA, remaining_ml: 700 } as never).select("id").single();

    const { data: list } = await admin.from("wine_lists").insert({ restaurant_id: restaurantA, name: "P2 Merge List" } as never).select("id").single();
    const { data: section } = await admin.from("wine_list_sections").insert({ wine_list_id: (list as { id: string }).id, name: "Reds" } as never).select("id").single();
    const { data: listItem } = await admin.from("wine_list_items").insert({ section_id: (section as { id: string }).id, wine_id: sourceId, position: 1 } as never).select("id").single();

    const { data: avail } = await admin.from("availability_events").insert({ wine_id: sourceId, restaurant_id: restaurantA, direction: "eightysixed" } as never).select("id").single();

    const { data: closeout } = await admin
      .from("bottle_closeouts")
      .insert({ restaurant_id: restaurantA, wine_id: sourceId, preservation_method: "none", theoretical_remaining_ml: 0, actual_remaining_ml: 0 } as never)
      .select("id")
      .single();

    const { data: reasonCode } = await admin
      .from("reason_codes")
      .insert({ restaurant_id: restaurantA, code: "P2_COMP", label: "P2 test comp", category: "comp" } as never)
      .select("id")
      .single();
    const { data: adjustment } = await admin
      .from("stock_adjustments")
      .insert({ restaurant_id: restaurantA, wine_id: sourceId, kind: "comp", bottles: 1, reason_code_id: (reasonCode as { id: string }).id, acting_user_id: ownerAId } as never)
      .select("id")
      .single();

    const { data: pricingRec } = await admin
      .from("pricing_recommendations")
      .insert({ restaurant_id: restaurantA, wine_id: sourceId, class: "hold", rationale: "P2 test" } as never)
      .select("id")
      .single();

    const { data: health } = await admin
      .from("cellar_health")
      .insert({ restaurant_id: restaurantA, wine_id: sourceId, segment: "healthy", reason: "P2 test" } as never)
      .select("id")
      .single();

    const { data: batch } = await admin
      .from("import_batches")
      .insert({ restaurant_id: restaurantA, filename: "p2-merge-test.csv", total_rows: 1 } as never)
      .select("id")
      .single();
    const { data: batchRow } = await admin
      .from("import_batch_rows")
      .insert({
        batch_id: (batch as { id: string }).id,
        restaurant_id: restaurantA,
        row_number: 1,
        raw: {},
        row_state: "valid",
        applied_wine_id: sourceId,
      } as never)
      .select("id")
      .single();

    // Also give the source wine a wine_variant_id, and leave the target's
    // null, to prove the "adopt" branch of the new conflict guard.
    const { data: canon } = await admin
      .from("canonical_wines")
      .insert({ producer: "P2 Merge Cellars", cuvee: "P2 Merge" } as never)
      .select("id")
      .single();
    cleanupCanonicalWineIds.push((canon as { id: string }).id);
    const { data: variant } = await admin
      .from("wine_variants")
      .insert({ restaurant_id: restaurantA, canonical_wine_id: (canon as { id: string }).id, vintage: 2020, size_ml: 750 } as never)
      .select("id")
      .single();
    await admin.from("wines").update({ wine_variant_id: (variant as { id: string }).id } as never).eq("id", sourceId);

    // BEFORE snapshot — every planted row present.
    const before = {
      inv: await admin.from("inventory_items").select("id").eq("id", (inv as { id: string }).id).maybeSingle(),
      pour: await admin.from("pour_events").select("id").eq("id", (pour as { id: string }).id).maybeSingle(),
      bottle: await admin.from("open_bottles").select("id").eq("id", (bottle as { id: string }).id).maybeSingle(),
      listItem: await admin.from("wine_list_items").select("id").eq("id", (listItem as { id: string }).id).maybeSingle(),
      avail: await admin.from("availability_events").select("id").eq("id", (avail as { id: string }).id).maybeSingle(),
      closeout: await admin.from("bottle_closeouts").select("id").eq("id", (closeout as { id: string }).id).maybeSingle(),
      adjustment: await admin.from("stock_adjustments").select("id").eq("id", (adjustment as { id: string }).id).maybeSingle(),
      pricingRec: await admin.from("pricing_recommendations").select("id").eq("id", (pricingRec as { id: string }).id).maybeSingle(),
      health: await admin.from("cellar_health").select("id").eq("id", (health as { id: string }).id).maybeSingle(),
      batchRow: await admin.from("import_batch_rows").select("id").eq("id", (batchRow as { id: string }).id).maybeSingle(),
    };
    for (const [key, res] of Object.entries(before)) {
      expect(res.data, `precondition: ${key} should exist before merge`).not.toBeNull();
    }

    // Run the real RPC as a real signed-in manager (owner qualifies).
    const { data: mergeResult, error: mergeError } = await ownerAClient.rpc("merge_wines", {
      p_source_wine_id: sourceId,
      p_target_wine_id: targetId,
    } as never);
    expect(mergeError).toBeNull();

    // Source wine is gone.
    const { data: sourceAfter } = await admin.from("wines").select("id").eq("id", sourceId).maybeSingle();
    expect(sourceAfter).toBeNull();

    // Every one of the 10 planted rows still exists, repointed to target
    // (or, for cellar_health, would have been dropped only if the target
    // already had one — it didn't here, so it must be repointed too).
    const after = {
      inv: await admin.from("inventory_items").select("wine_id").eq("id", (inv as { id: string }).id).maybeSingle(),
      pour: await admin.from("pour_events").select("wine_id").eq("id", (pour as { id: string }).id).maybeSingle(),
      bottle: await admin.from("open_bottles").select("wine_id").eq("id", (bottle as { id: string }).id).maybeSingle(),
      listItem: await admin.from("wine_list_items").select("wine_id").eq("id", (listItem as { id: string }).id).maybeSingle(),
      avail: await admin.from("availability_events").select("wine_id").eq("id", (avail as { id: string }).id).maybeSingle(),
      closeout: await admin.from("bottle_closeouts").select("wine_id").eq("id", (closeout as { id: string }).id).maybeSingle(),
      adjustment: await admin.from("stock_adjustments").select("wine_id").eq("id", (adjustment as { id: string }).id).maybeSingle(),
      pricingRec: await admin.from("pricing_recommendations").select("wine_id").eq("id", (pricingRec as { id: string }).id).maybeSingle(),
      health: await admin.from("cellar_health").select("wine_id").eq("id", (health as { id: string }).id).maybeSingle(),
      batchRow: await admin.from("import_batch_rows").select("applied_wine_id").eq("id", (batchRow as { id: string }).id).maybeSingle(),
    };
    expect((after.inv.data as { wine_id: string }).wine_id).toBe(targetId);
    expect((after.pour.data as { wine_id: string }).wine_id).toBe(targetId);
    expect((after.bottle.data as { wine_id: string }).wine_id).toBe(targetId);
    expect((after.listItem.data as { wine_id: string }).wine_id).toBe(targetId);
    expect((after.avail.data as { wine_id: string }).wine_id).toBe(targetId);
    expect((after.closeout.data as { wine_id: string }).wine_id).toBe(targetId);
    expect((after.adjustment.data as { wine_id: string }).wine_id).toBe(targetId);
    expect((after.pricingRec.data as { wine_id: string }).wine_id).toBe(targetId);
    expect((after.health.data as { wine_id: string }).wine_id).toBe(targetId);
    expect((after.batchRow.data as { applied_wine_id: string }).applied_wine_id).toBe(targetId);

    // The target adopted the source's wine_variant_id (it had none of its
    // own — the "adopt" branch, not the conflict branch).
    const { data: targetAfter } = await admin.from("wines").select("wine_variant_id").eq("id", targetId).single();
    expect((targetAfter as { wine_variant_id: string }).wine_variant_id).toBe((variant as { id: string }).id);

    expect(mergeResult).toMatchObject({
      moved_inventory_items: 1,
      moved_pour_events: 1,
      moved_open_bottles: 1,
      moved_wine_list_items: 1,
      moved_availability_events: 1,
      moved_bottle_closeouts: 1,
      moved_stock_adjustments: 1,
      moved_pricing_recommendations: 1,
      moved_cellar_health: 1,
      dropped_cellar_health: 0,
      moved_import_batch_rows: 1,
    });

    // identity_merge_log has exactly one forensic row for this merge.
    const { data: logRow } = await admin
      .from("identity_merge_log")
      .select("merge_type, source_id, target_id, restaurant_id")
      .eq("source_id", sourceId)
      .eq("target_id", targetId)
      .maybeSingle();
    expect(logRow).toMatchObject({ merge_type: "wine", source_id: sourceId, target_id: targetId, restaurant_id: restaurantA });
  });

  it("merge_wines raises variant_identity_conflict when source and target disagree on wine_variant_id", async () => {
    const sharedLwin = String(2000000 + (Date.now() % 7000000));
    const { data: w1 } = await admin.from("wines").insert({ restaurant_id: restaurantA, name: "P2 Conflict A", producer: "P2 Conflict Cellars", vintage: 2021, size_ml: 750, lwin_id: sharedLwin } as never).select("id").single();
    const { data: w2 } = await admin.from("wines").insert({ restaurant_id: restaurantA, name: "P2 Conflict B", producer: "P2 Conflict Cellars", vintage: 2021, size_ml: 750, lwin_id: sharedLwin } as never).select("id").single();
    const w1Id = (w1 as { id: string }).id;
    const w2Id = (w2 as { id: string }).id;

    const { data: canon1 } = await admin.from("canonical_wines").insert({ producer: "P2 Conflict One", cuvee: "One" } as never).select("id").single();
    const { data: canon2 } = await admin.from("canonical_wines").insert({ producer: "P2 Conflict Two", cuvee: "Two" } as never).select("id").single();
    cleanupCanonicalWineIds.push((canon1 as { id: string }).id, (canon2 as { id: string }).id);
    const { data: v1 } = await admin.from("wine_variants").insert({ restaurant_id: restaurantA, canonical_wine_id: (canon1 as { id: string }).id, vintage: 2021, size_ml: 750 } as never).select("id").single();
    const { data: v2 } = await admin.from("wine_variants").insert({ restaurant_id: restaurantA, canonical_wine_id: (canon2 as { id: string }).id, vintage: 2021, size_ml: 750 } as never).select("id").single();

    await admin.from("wines").update({ wine_variant_id: (v1 as { id: string }).id } as never).eq("id", w1Id);
    await admin.from("wines").update({ wine_variant_id: (v2 as { id: string }).id } as never).eq("id", w2Id);

    const { error } = await ownerAClient.rpc("merge_wines", { p_source_wine_id: w1Id, p_target_wine_id: w2Id } as never);
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toContain("variant_identity_conflict");
  });

  it("merge_canonical_wines is unreachable by an authenticated session, and succeeds via service_role", async () => {
    const { data: source } = await admin.from("canonical_wines").insert({ producer: "P2 MCW Source", cuvee: "Cuvee" } as never).select("id").single();
    const { data: target } = await admin.from("canonical_wines").insert({ producer: "P2 MCW Target", cuvee: "Cuvee" } as never).select("id").single();
    const sourceId = (source as { id: string }).id;
    const targetId = (target as { id: string }).id;
    cleanupCanonicalWineIds.push(sourceId, targetId);

    // A real, ordinary tenant manager cannot call it at all — narrowed
    // per the orchestrating session's decision (P2 does not expose
    // merge_canonical_wines to tenants).
    const { error: authError } = await ownerAClient.rpc("merge_canonical_wines", { p_source_id: sourceId, p_target_id: targetId } as never);
    expect(authError).not.toBeNull();
    expect(authError?.message ?? "").toMatch(/permission denied|function .* does not exist/i);

    // service_role can, and it works.
    const { data: result, error: adminError } = await admin.rpc("merge_canonical_wines", { p_source_id: sourceId, p_target_id: targetId } as never);
    expect(adminError).toBeNull();
    expect(result).toMatchObject({ target_id: targetId });

    const { data: sourceAfter } = await admin.from("canonical_wines").select("id").eq("id", sourceId).maybeSingle();
    expect(sourceAfter).toBeNull();
  });

  // P2 round-3 (D1-residual — scratchpad db-audit/verify/P2-critic-r2.md):
  // round 1 shipped ON DELETE CASCADE (destroyed the wines row + its
  // audit children on a single wine_variants delete — CRITICAL). Round 2
  // switched to ON DELETE SET NULL, which stopped the destruction but
  // still let a variant delete silently sever a wine's resolved identity
  // with no error and no identity_merge_log entry — a milder recurrence
  // of the same "silent, unguarded, unlogged" failure class. The round-2
  // critic proved (via a forced, diagnostically-confirmed reversal of the
  // cascade firing order) that round 2's stated reason for rejecting
  // plain RESTRICT does not hold: RESTRICT is safe in both orderings,
  // because Postgres defers a NOT DEFERRABLE FK's RESTRICT check to true
  // end-of-statement, after every cascade in the whole affected object
  // graph has already run. Fixed to plain RESTRICT — the loudest option:
  // a delete that would sever a wine's identity now simply cannot happen.
  it("D1 fix: deleting a wine_variants row is blocked outright (RESTRICT) — the wines row, its identity, and its full audit trail are never touched", async () => {
    const { data: canon } = await admin
      .from("canonical_wines")
      .insert({ producer: "P2 FK Safety Cellars", cuvee: "Safety Cuvee" } as never)
      .select("id")
      .single();
    const canonId = (canon as { id: string }).id;
    cleanupCanonicalWineIds.push(canonId);

    const { data: variant } = await admin
      .from("wine_variants")
      .insert({ restaurant_id: restaurantA, canonical_wine_id: canonId, vintage: 2021, size_ml: 750 } as never)
      .select("id")
      .single();
    const variantId = (variant as { id: string }).id;

    const { data: wine } = await admin
      .from("wines")
      .insert({ restaurant_id: restaurantA, name: "P2 FK Safety Wine", producer: "P2 FK Safety Cellars", vintage: 2021, size_ml: 750 } as never)
      .select("id")
      .single();
    const wineId = (wine as { id: string }).id;
    await admin.from("wines").update({ wine_variant_id: variantId } as never).eq("id", wineId);

    // Plant every confirmed live FK-to-wines(id) child in one row each —
    // both the RESTRICT-tied ones (inventory_items, wine_list_items,
    // pour_events) and the CASCADE-tied ones the round-1 bug actually
    // destroyed — to prove the fix no longer depends on which kind of
    // child the wine happens to have.
    const { data: inv } = await admin.from("inventory_items").insert({ wine_id: wineId, restaurant_id: restaurantA, quantity: 1, unit_cost: 10 } as never).select("id").single();
    const { data: pour } = await admin.from("pour_events").insert({ wine_id: wineId, restaurant_id: restaurantA, ml_delta: -50, kind: "pour" } as never).select("id").single();
    const { data: list } = await admin.from("wine_lists").insert({ restaurant_id: restaurantA, name: "P2 FK Safety List" } as never).select("id").single();
    const { data: section } = await admin.from("wine_list_sections").insert({ wine_list_id: (list as { id: string }).id, name: "Reds" } as never).select("id").single();
    const { data: listItem } = await admin.from("wine_list_items").insert({ section_id: (section as { id: string }).id, wine_id: wineId, position: 1 } as never).select("id").single();
    const { data: bottle } = await admin.from("open_bottles").insert({ wine_id: wineId, restaurant_id: restaurantA, remaining_ml: 700 } as never).select("id").single();
    const { data: avail } = await admin.from("availability_events").insert({ wine_id: wineId, restaurant_id: restaurantA, direction: "eightysixed" } as never).select("id").single();
    const { data: closeout } = await admin
      .from("bottle_closeouts")
      .insert({ restaurant_id: restaurantA, wine_id: wineId, preservation_method: "none", theoretical_remaining_ml: 0, actual_remaining_ml: 0 } as never)
      .select("id")
      .single();
    const { data: reasonCode } = await admin
      .from("reason_codes")
      .insert({ restaurant_id: restaurantA, code: "P2_FK_SAFETY", label: "P2 FK safety test", category: "comp" } as never)
      .select("id")
      .single();
    const { data: adjustment } = await admin
      .from("stock_adjustments")
      .insert({ restaurant_id: restaurantA, wine_id: wineId, kind: "comp", bottles: 1, reason_code_id: (reasonCode as { id: string }).id, acting_user_id: ownerAId } as never)
      .select("id")
      .single();
    const { data: pricingRec } = await admin
      .from("pricing_recommendations")
      .insert({ restaurant_id: restaurantA, wine_id: wineId, class: "hold", rationale: "P2 FK safety test" } as never)
      .select("id")
      .single();
    const { data: health } = await admin
      .from("cellar_health")
      .insert({ restaurant_id: restaurantA, wine_id: wineId, segment: "healthy", reason: "P2 FK safety test" } as never)
      .select("id")
      .single();

    // The act that must now be blocked outright: delete the
    // wine_variants row directly (no restaurant teardown, no merge_wines
    // call — a bare, unguarded single-row delete, exactly as the round-1
    // critic reproduced it). Under RESTRICT this must fail with the FK
    // violation, not succeed-and-detach.
    const { error: deleteError } = await admin.from("wine_variants").delete().eq("id", variantId);
    expect(deleteError).not.toBeNull();
    expect(deleteError?.message ?? "").toMatch(/wines_variant_tenant_fk|foreign key/i);

    // The wine_variants row itself survives too — the delete never happened.
    const { data: variantAfter } = await admin.from("wine_variants").select("id").eq("id", variantId).maybeSingle();
    expect(variantAfter).not.toBeNull();

    // The wines row is completely untouched — identity intact, not merely
    // detached.
    const { data: wineAfter } = await admin.from("wines").select("id, wine_variant_id, canonical_wine_id").eq("id", wineId).maybeSingle();
    expect(wineAfter).not.toBeNull();
    expect((wineAfter as { wine_variant_id: string | null }).wine_variant_id).toBe(variantId);
    expect((wineAfter as { canonical_wine_id: string | null }).canonical_wine_id).toBe(canonId);

    // Every one of its audit-trail/inventory children survives untouched.
    const survivors = {
      inv: await admin.from("inventory_items").select("id").eq("id", (inv as { id: string }).id).maybeSingle(),
      pour: await admin.from("pour_events").select("id").eq("id", (pour as { id: string }).id).maybeSingle(),
      listItem: await admin.from("wine_list_items").select("id").eq("id", (listItem as { id: string }).id).maybeSingle(),
      bottle: await admin.from("open_bottles").select("id").eq("id", (bottle as { id: string }).id).maybeSingle(),
      avail: await admin.from("availability_events").select("id").eq("id", (avail as { id: string }).id).maybeSingle(),
      closeout: await admin.from("bottle_closeouts").select("id").eq("id", (closeout as { id: string }).id).maybeSingle(),
      adjustment: await admin.from("stock_adjustments").select("id").eq("id", (adjustment as { id: string }).id).maybeSingle(),
      pricingRec: await admin.from("pricing_recommendations").select("id").eq("id", (pricingRec as { id: string }).id).maybeSingle(),
      health: await admin.from("cellar_health").select("id").eq("id", (health as { id: string }).id).maybeSingle(),
    };
    for (const [key, res] of Object.entries(survivors)) {
      expect(res.data, `${key} must survive a standalone wine_variants delete`).not.toBeNull();
    }
  });

  it("D1 fix: restaurant teardown with a populated wine_variant_id still completes cleanly (the original C17 race this FK exists to close)", async () => {
    // A throwaway, self-contained restaurant — created and destroyed
    // entirely within this test, independent of restaurantA/B's shared
    // afterAll cleanup.
    const { data: restC } = await admin.from("restaurants").insert({ name: "P2 FK Safety Teardown" } as never).select("id").single();
    const restaurantC = (restC as { id: string }).id;

    const { data: canon } = await admin
      .from("canonical_wines")
      .insert({ producer: "P2 Teardown Cellars", cuvee: "Teardown Cuvee" } as never)
      .select("id")
      .single();
    const canonId = (canon as { id: string }).id;
    cleanupCanonicalWineIds.push(canonId);

    const { data: variant } = await admin
      .from("wine_variants")
      .insert({ restaurant_id: restaurantC, canonical_wine_id: canonId, vintage: 2022, size_ml: 750 } as never)
      .select("id")
      .single();
    const variantId = (variant as { id: string }).id;

    const { data: wine } = await admin
      .from("wines")
      .insert({ restaurant_id: restaurantC, name: "P2 Teardown Wine", producer: "P2 Teardown Cellars", vintage: 2022, size_ml: 750 } as never)
      .select("id")
      .single();
    const wineId = (wine as { id: string }).id;
    await admin.from("wines").update({ wine_variant_id: variantId } as never).eq("id", wineId);

    // The full-teardown path: deleting the restaurant fires
    // wine_variants.restaurant_id's own ON DELETE CASCADE and
    // wines.restaurant_id's own ON DELETE CASCADE as two independent
    // actions on the same statement, in an order Postgres does not
    // guarantee from the client's side. Round 2 rejected plain RESTRICT
    // here on the theory that this could raise a spurious violation if
    // the wine_variants side won that race. The round-2 critic disproved
    // that live with a forced, diagnostically-confirmed reversal of the
    // actual firing order (independently reproduced by hand against this
    // stack: AFTER DELETE diagnostic triggers with clock_timestamp()
    // showed wine_variants deleted before wines, and RESTRICT still never
    // fired) — Postgres defers a NOT DEFERRABLE FK's RESTRICT check to
    // true end-of-statement, by which point every cascade across the
    // whole affected graph has already completed regardless of firing
    // order. This test exercises the ordinary (unforced) case; the forced-
    // reversal proof itself lives in
    // supabase/tests/0098_wine_variants_restrict_safety.sql, which
    // manipulates trigger OIDs directly (something only raw SQL, not this
    // supabase-js client, can do).
    const { error: teardownError } = await admin.from("restaurants").delete().eq("id", restaurantC);
    expect(teardownError).toBeNull();

    const { data: wineRows } = await admin.from("wines").select("id").eq("restaurant_id", restaurantC);
    const { data: variantRows } = await admin.from("wine_variants").select("id").eq("restaurant_id", restaurantC);
    expect(wineRows ?? []).toHaveLength(0);
    expect(variantRows ?? []).toHaveLength(0);
  });
});
