// G1-4 — MANDATORY two-tenant fixture test.
//
// apply_import_batch_chunk and revert_import_batch are SECURITY INVOKER
// (see 0076): they run as whichever member calls them, and table RLS is
// the actual tenant boundary — not application-code filtering, which a
// direct RPC call from a malicious-but-authenticated client bypasses
// entirely. A mocked Supabase client can't prove RLS actually blocks
// anything (a mock just returns whatever the test tells it to); this
// needs a real Postgres with two real authenticated sessions.
//
// Requires a live local Supabase (same convention as
// src/lib/jobs/tenant-isolation.test.ts and e2e/*.test.ts's live-fixture
// suites) — skipped when NEXT_PUBLIC_SUPABASE_URL /
// NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY
// aren't set.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { confirmImportBatch, applyImportBatchChunk, resolveImportBatchRow, revertImportBatch } from "./batch-service";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasLiveDb = Boolean(supabaseUrl && publishableKey && serviceRoleKey);
// Fail LOUD, never skip, when the live stack should be there (integration
// critic finding): a silent describe.skipIf here once let a full run
// report green with every MANDATORY live-DB suite unexecuted. CI always
// brings up the local stack, so a missing env var there is an error, not
// a reason to skip.
if (!hasLiveDb && process.env.CI) {
  throw new Error(
    "MANDATORY live-DB suite: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY missing in CI - refusing to skip silently.",
  );
}


function csvBuffer() {
  return Buffer.from("producer,name,vintage,quantity,unit_cost\nCross Tenant Producer,Cross Tenant Wine,2020,6,24.50\n");
}

/**
 * A client authenticated as a fixed user, built from a raw access token
 * rather than a GoTrueClient-managed session. supabase-js itself warns
 * that multiple GoTrueClient instances signed in concurrently against
 * the same URL/storage key risk "undefined behavior when used
 * concurrently" (this test creates three: admin, user A, user B) —
 * baking the bearer token into a fixed header sidesteps that session/
 * token-refresh machinery entirely, so each client's identity is a
 * plain, immutable HTTP header for its whole lifetime.
 */
async function signedInClient(email: string, password: string): Promise<SupabaseClient<Database>> {
  const throwaway = createClient<Database>(supabaseUrl!, publishableKey!, { auth: { persistSession: false } });
  const { data, error } = await throwaway.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw error ?? new Error(`sign-in failed for ${email}`);
  return createClient<Database>(supabaseUrl!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

describe.skipIf(!hasLiveDb)("G1-4 CSV import: cross-tenant containment (MANDATORY)", () => {
  let admin: SupabaseClient<Database>;
  let restaurantA: string;
  let restaurantB: string;
  let userAClient: SupabaseClient<Database>;
  let userBClient: SupabaseClient<Database>;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });

    const { data: rA, error: rAErr } = await admin.from("restaurants").insert({ name: "G1-4 Tenant A" } as never).select("id").single();
    if (rAErr || !rA) throw rAErr ?? new Error("failed to insert restaurant A");
    restaurantA = (rA as { id: string }).id;

    const { data: rB, error: rBErr } = await admin.from("restaurants").insert({ name: "G1-4 Tenant B" } as never).select("id").single();
    if (rBErr || !rB) throw rBErr ?? new Error("failed to insert restaurant B");
    restaurantB = (rB as { id: string }).id;

    const run = Date.now();
    const password = "G1-4-Tenant-Test-123!";

    const { data: userA, error: userAErr } = await admin.auth.admin.createUser({
      email: `g1-4-tenant-a-${run}@terroir.test`,
      password,
      email_confirm: true,
    });
    if (userAErr || !userA) throw userAErr ?? new Error("failed to create user A");
    userAId = userA.user.id;

    const { data: userB, error: userBErr } = await admin.auth.admin.createUser({
      email: `g1-4-tenant-b-${run}@terroir.test`,
      password,
      email_confirm: true,
    });
    if (userBErr || !userB) throw userBErr ?? new Error("failed to create user B");
    userBId = userB.user.id;

    const { error: memAErr } = await admin.from("memberships").insert({
      user_id: userAId,
      restaurant_id: restaurantA,
      role: "staff",
    } as never);
    if (memAErr) throw memAErr;

    const { error: memBErr } = await admin.from("memberships").insert({
      user_id: userBId,
      restaurant_id: restaurantB,
      role: "staff",
    } as never);
    if (memBErr) throw memBErr;

    userAClient = await signedInClient(userA.user.email!, password);
    userBClient = await signedInClient(userB.user.email!, password);

    // A local dev database's lwin_catalog is typically unseeded — insert
    // an exact-match fixture so the confirmed row resolves to `auto`
    // (matched + cost present) instead of `pending`, exercising the real
    // apply path rather than the separate resolve-then-apply path.
    const { error: lwinError } = await admin.from("lwin_catalog").insert({
      lwin_id: "G14-TENANT-TEST",
      display_name: "Cross Tenant Wine",
      producer: "Cross Tenant Producer",
    } as never);
    if (lwinError) throw lwinError;
  });

  afterAll(async () => {
    await admin.from("lwin_catalog").delete().eq("lwin_id", "G14-TENANT-TEST");
    // Cascades: import_batches, import_batch_rows, memberships, and
    // inventory_items/wines this suite created all FK restaurant_id ON
    // DELETE CASCADE.
    await admin.from("restaurants").delete().in("id", [restaurantA, restaurantB]);
    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
  });

  it("blocks reading, applying, and reverting another tenant's import batch", async () => {
    // User A confirms a real import batch under restaurant A.
    const confirmed = await confirmImportBatch(userAClient, restaurantA, userAId, "tenant-a.csv", csvBuffer());
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    const batchId = confirmed.batchId;

    // User B (a different tenant) cannot see it at all.
    const { data: batchAsB } = await userBClient.from("import_batches").select("id").eq("id", batchId).maybeSingle();
    expect(batchAsB).toBeNull();

    const { data: rowsAsB } = await userBClient.from("import_batch_rows").select("id").eq("batch_id", batchId);
    expect(rowsAsB ?? []).toHaveLength(0);

    // User B calling apply on it now fails loudly instead of silently
    // processing nothing: C17 (0082) added an explicit re-validation
    // inside apply_import_batch_chunk that raises P0002 when the batch
    // itself isn't visible to the caller (RLS on import_batches filters
    // it out for a non-member of restaurant A), turning what used to be
    // a silent "processed zero rows" no-op into an actionable error —
    // the same idiom revert_import_batch already uses (see below).
    await expect(applyImportBatchChunk(userBClient, batchId)).rejects.toMatchObject({ code: "P0002" });

    // Prove that the rejected attempt really did nothing to tenant A's
    // data: as user A, the row is still not_applied.
    const { data: rowsAsA } = await userAClient.from("import_batch_rows").select("apply_status").eq("batch_id", batchId);
    expect(rowsAsA).toEqual([{ apply_status: "not_applied" }]);

    // User A legitimately applies their own batch to completion.
    const applyAsA = await applyImportBatchChunk(userAClient, batchId);
    expect(applyAsA.processed).toEqual([expect.objectContaining({ outcome: "applied" })]);
    expect(applyAsA.status).toBe("completed");
    const appliedInventoryItemId = applyAsA.processed[0].inventoryItemId!;

    // User B cannot revert it either — the batch is invisible to them,
    // so revert_import_batch's own lookup reports "not found", not
    // "not completed" (which would leak that the batch exists).
    const revertAsB = await revertImportBatch(userBClient, restaurantB, batchId);
    expect(revertAsB).toMatchObject({ ok: false, error: { code: "not_found" } });

    // The batch is untouched by user B's attempt — still completed, not reverted.
    const { data: batchAfterAttempt } = await userAClient.from("import_batches").select("status").eq("id", batchId).single();
    expect((batchAfterAttempt as { status: string }).status).toBe("completed");

    // User A can revert their own batch, which actually removes the
    // inventory row it created. This wine was freshly created by this
    // batch's own apply step and has no other references once its
    // inventory is gone, so orphan cleanup removes it too — see "bar 4"
    // below, which relies on that (it inserts its own pre-existing wine
    // fixture rather than reusing this one for exactly that reason).
    const revertAsA = await revertImportBatch(userAClient, restaurantA, batchId);
    expect(revertAsA).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 1 });

    const { data: inventoryAfterRevert } = await admin
      .from("inventory_items")
      .select("id")
      .eq("id", appliedInventoryItemId)
      .maybeSingle();
    expect(inventoryAfterRevert).toBeNull();
  });

  it("bar 4: revert removes only the inventory it created, never pre-existing inventory for the same wine", async () => {
    // The previous test's own wine no longer exists — its revert's
    // orphan-wine cleanup deleted it (nothing referenced it once its
    // inventory was gone). So this test creates its OWN pre-existing wine
    // fixture directly, matching the same dedup key (restaurant/producer/
    // name/vintage/size) the new import below will upsert onto — this is
    // also a truer fixture for what "pre-existing" means here: a wine a
    // manual add or scan created, never a prior batch's leftovers.
    const { data: existingWine, error: wineError } = await admin
      .from("wines")
      .insert({
        restaurant_id: restaurantA,
        producer: "Cross Tenant Producer",
        name: "Cross Tenant Wine",
        vintage: 2020,
        size_ml: 750,
      } as never)
      .select("id")
      .single();
    if (wineError || !existingWine) throw wineError ?? new Error("failed to insert pre-existing wine fixture");

    const { data: preExisting, error: invError } = await admin
      .from("inventory_items")
      .insert({
        wine_id: (existingWine as { id: string }).id,
        restaurant_id: restaurantA,
        quantity: 3,
        unit_cost: 50,
        added_via: "manual",
      } as never)
      .select("id")
      .single();
    if (invError || !preExisting) throw invError ?? new Error("failed to insert pre-existing inventory");
    const preExistingId = (preExisting as { id: string }).id;

    const confirmed = await confirmImportBatch(userAClient, restaurantA, userAId, "second-import.csv", csvBuffer());
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok || confirmed.alreadyExists) return;

    // P3 (2026-08-23-p3-chunked-import.md §1.5 tier 2) added real
    // inventory-level duplicate prevention: this row's wine identity +
    // normalized (bin, section) now matches the pre-existing manual
    // inventory row inserted above (same wine, no bin/section on either
    // side) — create_import_batch correctly flags it resolution='pending'
    // with duplicate_reason.type='existing_inventory' instead of silently
    // auto-applying a second, unrelated inventory_items row for the same
    // wine at the same (empty) location. That's the intended new
    // behavior this test now exercises: the operator explicitly resolves
    // it ('include' — a genuine second lot, same as this test always
    // intended), and only THEN does the row apply.
    const { data: pendingRow, error: pendingErr } = await userAClient
      .from("import_batch_rows")
      .select("id, resolution, duplicate_reason")
      .eq("batch_id", confirmed.batchId)
      .single();
    if (pendingErr || !pendingRow) throw pendingErr ?? new Error("expected exactly one row");
    const row = pendingRow as { id: string; resolution: string; duplicate_reason: unknown };
    expect(row.resolution).toBe("pending");
    expect(row.duplicate_reason).toMatchObject({ type: "existing_inventory" });

    const resolved = await resolveImportBatchRow(userAClient, restaurantA, userAId, row.id, "include");
    expect(resolved).toEqual({ ok: true });

    const applied = await applyImportBatchChunk(userAClient, confirmed.batchId);
    expect(applied.processed).toEqual([expect.objectContaining({ outcome: "applied" })]);
    const importedInventoryId = applied.processed[0].inventoryItemId!;
    expect(importedInventoryId).not.toBe(preExistingId);

    const reverted = await revertImportBatch(userAClient, restaurantA, confirmed.batchId);
    // The wine is spared twice over: the pre-existing inventory row still
    // references it, AND it predates this batch (created_at guard).
    expect(reverted).toEqual({ ok: true, revertedCount: 1, orphanWinesDeleted: 0 });

    const { data: preExistingAfter } = await admin
      .from("inventory_items")
      .select("id, quantity")
      .eq("id", preExistingId)
      .maybeSingle();
    expect(preExistingAfter).toEqual({ id: preExistingId, quantity: 3 });

    const { data: importedAfter } = await admin
      .from("inventory_items")
      .select("id")
      .eq("id", importedInventoryId)
      .maybeSingle();
    expect(importedAfter).toBeNull();
  });
});
