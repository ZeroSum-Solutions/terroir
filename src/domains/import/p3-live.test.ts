// P3 (2026-08-23-p3-chunked-import.md) — MANDATORY live-Postgres regression
// tests for the three critical inherited findings this piece rewrites the
// code around (C03, C09, C16), plus C24, C-new-1, and the new session-level
// duplicate-prevention/revert behavior. Same convention as
// tenant-isolation.test.ts: skipped when NEXT_PUBLIC_SUPABASE_URL /
// NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY aren't
// set, real Postgres required (these are DB-function-level bugs; a mocked
// client can't prove a real transaction/constraint/RPC behaves correctly).
//
// Where a test needs many "auto-eligible" rows at once and the local dev
// stack's lwin_catalog is unseeded (no real LWIN dataset ships with this
// repo), it flips resolution 'pending' (unmatched-LWIN) -> 'auto' directly
// via the ADMIN (service_role) client as a TEST-SETUP shortcut standing in
// for "this row matched the catalog" — this exercises the SAME apply-
// eligibility code path a real LWIN match would use (the eligibility
// filter only ever looks at `resolution`, never at *why* it's auto), it
// just skips having to seed a multi-thousand-row real LWIN catalog. Every
// other step (confirm, apply, count, revert) goes through the real
// batch-service.ts/session-service.ts functions and the real RPCs.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  applyImportBatchChunk,
  confirmImportBatch,
  revertImportBatch,
} from "./batch-service";
import { createImportSession, revertImportSession } from "./session-service";

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


async function signedInClient(email: string, password: string): Promise<SupabaseClient<Database>> {
  const throwaway = createClient<Database>(supabaseUrl!, publishableKey!, { auth: { persistSession: false } });
  const { data, error } = await throwaway.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw error ?? new Error(`sign-in failed for ${email}`);
  return createClient<Database>(supabaseUrl!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

function csvOf(rows: Array<{ producer: string; name: string; vintage?: number; quantity: number; unitCost: number; bin?: string; section?: string }>) {
  const header = "producer,name,vintage,quantity,unit_cost,bin,section";
  const lines = rows.map(
    (r) => `${r.producer},${r.name},${r.vintage ?? ""},${r.quantity},${r.unitCost},${r.bin ?? ""},${r.section ?? ""}`,
  );
  return Buffer.from([header, ...lines].join("\n") + "\n");
}

// 60s per-test budget: several tests here push 1,500-row batches through
// PostgREST and drain them via repeated RPC calls — comfortably under a
// second alone, but the default 5s flakes when the whole suite runs the
// other live-DB files against the same local stack in parallel.
describe.skipIf(!hasLiveDb)("P3 critical findings (MANDATORY, live Postgres)", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let restaurantId: string;
  let userClient: SupabaseClient<Database>;
  let userId: string;

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });

    const { data: restaurant, error: restaurantError } = await admin
      .from("restaurants")
      .insert({ name: "P3 Critical Findings Test" } as never)
      .select("id")
      .single();
    if (restaurantError || !restaurant) throw restaurantError ?? new Error("failed to insert restaurant");
    restaurantId = (restaurant as { id: string }).id;

    const run = Date.now();
    const password = "P3-Critical-Test-123!";
    const { data: user, error: userError } = await admin.auth.admin.createUser({
      email: `p3-critical-${run}@terroir.test`,
      password,
      email_confirm: true,
    });
    if (userError || !user) throw userError ?? new Error("failed to create user");
    userId = user.user.id;

    const { error: memError } = await admin
      .from("memberships")
      .insert({ user_id: userId, restaurant_id: restaurantId, role: "staff" } as never);
    if (memError) throw memError;

    userClient = await signedInClient(user.user.email!, password);
  }, 30_000);

  afterAll(async () => {
    await admin.from("restaurants").delete().eq("id", restaurantId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  /** Test-setup shortcut (see file header): flips every pending
   * (unmatched-LWIN) row of a batch to 'auto' via the admin client, so it
   * clears applyImportBatchChunk's eligibility filter without needing a
   * seeded lwin_catalog. */
  async function makeAllRowsEligible(batchId: string) {
    const { error } = await admin
      .from("import_batch_rows")
      .update({ resolution: "auto" } as never)
      .eq("batch_id", batchId)
      .eq("resolution", "pending")
      .eq("cost_status", "present");
    if (error) throw error;
  }

  async function applyAll(batchId: string, maxCalls = 200) {
    for (let i = 0; i < maxCalls; i++) {
      const result = await applyImportBatchChunk(userClient, batchId);
      if (result.counts.eligibleNotApplied === 0) return result;
    }
    throw new Error("applyAll: exceeded maxCalls without draining eligible rows");
  }

  // ── C03 ──────────────────────────────────────────────────────────────
  describe("C03: PostgREST's 1,000-row cap no longer produces a false 'completed', and a reverted batch can never be re-applied into", () => {
    it("count_import_batch_rows reports accurate counts past PostgREST's 1,000-row max_rows, where a raw .select() truncates", async () => {
      const rows = Array.from({ length: 1500 }, (_, i) => ({
        producer: `C03 Producer ${i}`,
        name: `C03 Wine ${i}`,
        vintage: 2020,
        quantity: 1,
        unitCost: 10,
      }));
      const confirmed = await confirmImportBatch(userClient, restaurantId, userId, "c03.csv", csvOf(rows));
      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok || confirmed.alreadyExists) return;
      const batchId = confirmed.batchId;
      await makeAllRowsEligible(batchId);

      // Apply exactly 1,000 of the 1,500 rows (two 500-row RPC calls —
      // the DB function's own hard clamp — well past PostgREST's 1,000-
      // row default response cap).
      // Errors checked (integration critic finding): an unchecked failed
      // apply here under concurrent suite load silently shifted the
      // applied/eligible split and failed the count assertions below for
      // the wrong reason.
      const apply1 = await userClient.rpc("apply_import_batch_chunk", { p_batch_id: batchId, p_limit: 500 } as never);
      expect(apply1.error).toBeNull();
      const apply2 = await userClient.rpc("apply_import_batch_chunk", { p_batch_id: batchId, p_limit: 500 } as never);
      expect(apply2.error).toBeNull();

      // THE BUG, demonstrated directly: a raw PostgREST .select() over all
      // 1,500 rows is silently truncated to 1,000 by config's max_rows —
      // this is the exact shape the pre-fix countBatchRows had.
      const { data: rawRows, error: rawError } = await userClient
        .from("import_batch_rows")
        .select("apply_status, resolution")
        .eq("batch_id", batchId);
      if (rawError) throw rawError;
      expect(rawRows).toHaveLength(1000); // truncated — NOT the real 1,500

      // THE FIX: count_import_batch_rows is immune to the cap by
      // construction (always exactly one row).
      const { data: countData, error: countError } = await userClient.rpc("count_import_batch_rows", {
        p_batch_id: batchId,
      } as never);
      if (countError) throw countError;
      const counts = (Array.isArray(countData) ? countData[0] : countData) as {
        total: number;
        applied: number;
        eligible_not_applied: number;
      };
      expect(counts).toMatchObject({ total: 1500, applied: 1000, eligible_not_applied: 500 });
    });

    it("a reverted batch can never be re-applied into (second half of C03: the old function never checked import_batches.status at all)", async () => {
      const rows = Array.from({ length: 5 }, (_, i) => ({
        producer: `C03-revert Producer ${i}`,
        name: `C03-revert Wine ${i}`,
        quantity: 2,
        unitCost: 5,
      }));
      const confirmed = await confirmImportBatch(userClient, restaurantId, userId, "c03-revert.csv", csvOf(rows));
      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok || confirmed.alreadyExists) return;
      const batchId = confirmed.batchId;
      await makeAllRowsEligible(batchId);

      const applied = await applyAll(batchId);
      expect(applied.status).toBe("completed");

      const reverted = await revertImportBatch(userClient, restaurantId, batchId, admin);
      expect(reverted).toMatchObject({ ok: true, revertedCount: 5 });

      // Calling apply again on the now-REVERTED batch must be a hard
      // no-op: zero rows processed, zero new inventory_items created.
      const secondApply = await applyImportBatchChunk(userClient, batchId);
      expect(secondApply.processed).toEqual([]);

      const { data: inventoryAfter } = await admin
        .from("inventory_items")
        .select("id")
        .eq("restaurant_id", restaurantId)
        .in(
          "wine_id",
          (
            await admin
              .from("wines")
              .select("id")
              .eq("restaurant_id", restaurantId)
              .like("producer", "C03-revert Producer%")
          ).data?.map((w: { id: string }) => w.id) ?? [],
        );
      expect(inventoryAfter ?? []).toHaveLength(0);
    });
  });

  // ── C09 ──────────────────────────────────────────────────────────────
  describe("C09: re-confirming byte-identical content is idempotent, and a rows-insert failure never leaves an orphaned batch", () => {
    it("BEFORE (simulated pre-fix path): the OLD two-separate-statement confirm pattern really did create two batches and double quantities — proves the bug was real, not hypothetical", async () => {
      // Reproduces confirmImportBatch's EXACT pre-P3 body: two independent
      // client statements, no content hash, no atomicity between them.
      async function oldConfirm() {
        const { data: batch, error: batchError } = await admin
          .from("import_batches")
          .insert({ restaurant_id: restaurantId, created_by: userId, filename: "c09-old.csv", total_rows: 1 } as never)
          .select("id")
          .single();
        if (batchError || !batch) throw batchError;
        const batchId = (batch as { id: string }).id;
        const { error: rowsError } = await admin.from("import_batch_rows").insert({
          batch_id: batchId,
          restaurant_id: restaurantId,
          row_number: 1,
          raw: { producer: "C09-old Producer", name: "C09-old Wine", quantity: "6", unit_cost: "24.50", vintage: null, size_ml: "750", varietal: null, region: null, country: null, format: null, currency: null, bin: null, section: null },
          row_state: "valid",
          validation_errors: [],
          lwin_status: "unmatched",
          resolution: "auto",
          cost_status: "present",
        } as never);
        if (rowsError) throw rowsError;
        return batchId;
      }

      const batchId1 = await oldConfirm();
      const batchId2 = await oldConfirm();
      expect(batchId1).not.toBe(batchId2); // the bug: two batches for identical content

      await userClient.rpc("apply_import_batch_chunk", { p_batch_id: batchId1, p_limit: 10 } as never);
      await userClient.rpc("apply_import_batch_chunk", { p_batch_id: batchId2, p_limit: 10 } as never);

      const { data: wine } = await admin
        .from("wines")
        .select("id")
        .eq("restaurant_id", restaurantId)
        .eq("producer", "C09-old Producer")
        .single();
      const { data: inv } = await admin
        .from("inventory_items")
        .select("quantity")
        .eq("wine_id", (wine as { id: string }).id);
      const totalQty = (inv ?? []).reduce((s: number, r: { quantity: number }) => s + r.quantity, 0);
      expect(totalQty).toBe(12); // doubled: 6 + 6, the exact C09 bug
    });

    it("AFTER (the real confirmImportBatch, fixed): confirming identical bytes twice returns a resume pointer, creates exactly ONE batch, and never doubles quantity", async () => {
      const buffer = csvOf([{ producer: "C09-new Producer", name: "C09-new Wine", quantity: 6, unitCost: 24.5 }]);

      const first = await confirmImportBatch(userClient, restaurantId, userId, "c09-new.csv", buffer);
      expect(first).toMatchObject({ ok: true, alreadyExists: false });
      if (!first.ok || first.alreadyExists) return;

      const second = await confirmImportBatch(userClient, restaurantId, userId, "c09-new.csv", buffer);
      expect(second).toMatchObject({ ok: true, alreadyExists: true, batchId: first.batchId });

      const { data: allBatches } = await admin
        .from("import_batches")
        .select("id")
        .eq("restaurant_id", restaurantId)
        .eq("filename", "c09-new.csv");
      expect(allBatches).toHaveLength(1);

      await makeAllRowsEligible(first.batchId);
      await applyAll(first.batchId);

      const { data: wine } = await admin
        .from("wines")
        .select("id")
        .eq("restaurant_id", restaurantId)
        .eq("producer", "C09-new Producer")
        .single();
      const { data: inv } = await admin
        .from("inventory_items")
        .select("quantity")
        .eq("wine_id", (wine as { id: string }).id);
      const totalQty = (inv ?? []).reduce((s: number, r: { quantity: number }) => s + r.quantity, 0);
      expect(totalQty).toBe(6); // NOT doubled
    });

    it("a rows-insert failure leaves ZERO import_batches rows behind (atomic rollback, no orphan)", async () => {
      // Force the rows-insert half of create_import_batch to fail: an
      // out-of-band direct RPC call with a row_state that violates
      // import_batch_rows_row_state_check.
      const { error } = await admin.rpc("create_import_batch", {
        p_restaurant_id: restaurantId,
        p_created_by: userId,
        p_filename: "c09-fail.csv",
        p_total_rows: 1,
        p_rows: [
          {
            row_number: 1,
            raw: { producer: "X" },
            row_state: "not-a-real-state", // violates the CHECK constraint
            validation_errors: [],
            lwin_status: "unmatched",
            lwin_id: null,
            lwin_score: null,
            cost_status: "present",
            resolution: "auto",
            duplicate_reason: null,
          },
        ],
      } as never);
      expect(error).toBeTruthy();

      const { data: batches } = await admin
        .from("import_batches")
        .select("id")
        .eq("restaurant_id", restaurantId)
        .eq("filename", "c09-fail.csv");
      expect(batches).toHaveLength(0);
    });
  });

  // ── C16 ──────────────────────────────────────────────────────────────
  describe("C16: a permanently-failing row no longer starves eligible rows behind it", () => {
    it("100 permanently-failing rows exhaust their attempts and stop blocking the 101st (good) row", async () => {
      // 100 rows engineered to blow numeric(10,2)'s range on unit_cost —
      // valid at the app-validation layer (a huge but well-formed number,
      // under MAX_UNIT_COST so C18's new bound doesn't reject it first —
      // wait: MAX_UNIT_COST is 1,000,000, well under numeric(10,2)'s own
      // ~99,999,999.99 ceiling, so use a raw admin-inserted row that
      // bypasses app validation entirely to reproduce the DB-level
      // overflow directly, exactly like V2-import.md's repro.
      const poisonRaw = {
        producer: "C16 Poison",
        name: "C16 Poison Wine",
        quantity: "1",
        unit_cost: "99999999999.99", // overflows numeric(10,2) at apply time
        vintage: null,
        size_ml: "750",
        varietal: null,
        region: null,
        country: null,
        format: null,
        currency: null,
        bin: null,
        section: null,
      };
      const goodRaw = { ...poisonRaw, producer: "C16 Good", name: "C16 Good Wine", unit_cost: "10.00" };

      const { data: batch, error: batchError } = await admin
        .from("import_batches")
        .insert({ restaurant_id: restaurantId, created_by: userId, filename: "c16.csv", total_rows: 101 } as never)
        .select("id")
        .single();
      if (batchError || !batch) throw batchError;
      const batchId = (batch as { id: string }).id;

      const rows = [
        ...Array.from({ length: 100 }, (_, i) => ({
          batch_id: batchId,
          restaurant_id: restaurantId,
          row_number: i + 1,
          raw: poisonRaw,
          row_state: "valid",
          validation_errors: [],
          lwin_status: "unmatched",
          resolution: "auto",
          cost_status: "present",
        })),
        {
          batch_id: batchId,
          restaurant_id: restaurantId,
          row_number: 101,
          raw: goodRaw,
          row_state: "valid",
          validation_errors: [],
          lwin_status: "unmatched",
          resolution: "auto",
          cost_status: "present",
        },
      ];
      const { error: rowsError } = await admin.from("import_batch_rows").insert(rows as never);
      if (rowsError) throw rowsError;

      // Call apply repeatedly. Pre-fix, row 101 would NEVER get a turn —
      // the 100 poison rows occupy every 100-row window forever. Post-fix,
      // each poison row is retried MAX_ROW_APPLY_ATTEMPTS (3) times, then
      // flips to resolution='pending' and falls out of eligibility — so
      // row 101 must apply within a bounded number of calls.
      let row101Applied = false;
      for (let call = 0; call < 6 && !row101Applied; call++) {
        const result = await applyImportBatchChunk(userClient, batchId);
        row101Applied = result.processed.some((p) => p.rowNumber === 101 && p.outcome === "applied");
      }
      expect(row101Applied).toBe(true);

      const { data: poisonRows } = await admin
        .from("import_batch_rows")
        .select("apply_status, resolution, apply_attempts, last_error_message")
        .eq("batch_id", batchId)
        .lte("row_number", 100);
      for (const row of poisonRows as Array<{ apply_status: string; resolution: string; apply_attempts: number; last_error_message: string | null }>) {
        expect(row.apply_status).toBe("not_applied");
        expect(row.resolution).toBe("pending");
        expect(row.apply_attempts).toBe(3);
        expect(row.last_error_message).toContain("numeric field overflow");
      }
    });
  });

  // ── C24 ──────────────────────────────────────────────────────────────
  describe("C24: LWIN coalesce prefers the higher-confidence match regardless of arrival order", () => {
    async function insertAndApplyRow(batchId: string, rowNumber: number, lwinId: string, score: number, producer: string, name: string) {
      const { error } = await admin.from("import_batch_rows").insert({
        batch_id: batchId,
        restaurant_id: restaurantId,
        row_number: rowNumber,
        raw: { producer, name, quantity: "1", unit_cost: "10.00", vintage: null, size_ml: "750", varietal: null, region: null, country: null, format: null, currency: null, bin: null, section: null },
        row_state: "valid",
        validation_errors: [],
        lwin_status: "matched",
        lwin_id: lwinId,
        lwin_score: score,
        resolution: "auto",
        cost_status: "present",
      } as never);
      if (error) throw error;
    }

    it("a later HIGHER-confidence match overwrites an earlier lower-confidence one (0.31 then 0.95)", async () => {
      const { data: batch } = await admin
        .from("import_batches")
        .insert({ restaurant_id: restaurantId, created_by: userId, filename: "c24a.csv", total_rows: 2 } as never)
        .select("id")
        .single();
      const batchId = (batch as { id: string }).id;
      await insertAndApplyRow(batchId, 1, "WRONG", 0.31, "C24a Producer", "C24a Wine");
      await insertAndApplyRow(batchId, 2, "CORRECT", 0.95, "C24a Producer", "C24a Wine");
      await applyImportBatchChunk(userClient, batchId);

      const { data: wine } = await admin
        .from("wines")
        .select("lwin_id, lwin_match_score")
        .eq("restaurant_id", restaurantId)
        .eq("producer", "C24a Producer")
        .single();
      expect(wine).toMatchObject({ lwin_id: "CORRECT", lwin_match_score: 0.95 });
    });

    it("a later LOWER-confidence match never downgrades a higher-confidence one already in place (0.95 then 0.31)", async () => {
      const { data: batch } = await admin
        .from("import_batches")
        .insert({ restaurant_id: restaurantId, created_by: userId, filename: "c24b.csv", total_rows: 2 } as never)
        .select("id")
        .single();
      const batchId = (batch as { id: string }).id;
      await insertAndApplyRow(batchId, 1, "CORRECT", 0.95, "C24b Producer", "C24b Wine");
      await insertAndApplyRow(batchId, 2, "WRONG", 0.31, "C24b Producer", "C24b Wine");
      await applyImportBatchChunk(userClient, batchId);

      const { data: wine } = await admin
        .from("wines")
        .select("lwin_id, lwin_match_score")
        .eq("restaurant_id", restaurantId)
        .eq("producer", "C24b Producer")
        .single();
      expect(wine).toMatchObject({ lwin_id: "CORRECT", lwin_match_score: 0.95 });
    });

    it("a score between the old 0.3 bar and the new 0.6 bar (0.45) never sets wines.lwin_id at all", async () => {
      const { data: batch } = await admin
        .from("import_batches")
        .insert({ restaurant_id: restaurantId, created_by: userId, filename: "c24c.csv", total_rows: 1 } as never)
        .select("id")
        .single();
      const batchId = (batch as { id: string }).id;
      await insertAndApplyRow(batchId, 1, "MIDCONF", 0.45, "C24c Producer", "C24c Wine");
      await applyImportBatchChunk(userClient, batchId);

      const { data: wine } = await admin
        .from("wines")
        .select("lwin_id, lwin_match_score")
        .eq("restaurant_id", restaurantId)
        .eq("producer", "C24c Producer")
        .single();
      expect(wine).toMatchObject({ lwin_id: null, lwin_match_score: null });
    });
  });

  // ── Sol audit 2026-08-27 round 3, finding 2 ─────────────────────────
  describe("clearBatchLwinStamps contract: clears a stamp apply's conflict UPDATE left live, whether it wrote it fresh or re-affirmed an identical pre-existing value", () => {
    it("a wine that already carried the exact (lwin_id, score) pair BEFORE apply ran still has its stamp cleared on revert, once apply's own conflict UPDATE re-affirms that pair in its own transaction", async () => {
      // Pre-existing wine, stamped with the SAME pair the new batch's row
      // will also carry — models a re-imported file, or a coincidental
      // earlier stamp. wines_dedup_idx: (restaurant_id, lower(producer),
      // lower(name), coalesce(vintage,0), size_ml).
      const { data: existingWine, error: wineError } = await admin
        .from("wines")
        .insert({
          restaurant_id: restaurantId,
          producer: "C2Contract Producer",
          name: "C2Contract Wine",
          vintage: 2022,
          size_ml: 750,
          lwin_id: "C2CONTRACT-LWIN",
          lwin_match_score: 0.9,
        } as never)
        .select("id, updated_at")
        .single();
      if (wineError || !existingWine) throw wineError ?? new Error("failed to insert pre-existing wine fixture");
      const wineId = (existingWine as { id: string }).id;
      const preApplyUpdatedAt = (existingWine as { updated_at: string }).updated_at;

      const { data: batch, error: batchError } = await admin
        .from("import_batches")
        .insert({ restaurant_id: restaurantId, created_by: userId, filename: "c2contract.csv", total_rows: 1 } as never)
        .select("id")
        .single();
      if (batchError || !batch) throw batchError ?? new Error("failed to insert batch");
      const batchId = (batch as { id: string }).id;

      // This row's own LWIN match is the IDENTICAL pair the wine already
      // carries — apply's dedup upsert hits the pre-existing wine (same
      // producer/name/vintage/size), and its ON CONFLICT DO UPDATE CASE
      // leaves lwin_id/lwin_match_score unchanged (this row's score does
      // not beat the existing one) — but the UPDATE statement still runs,
      // so wines_set_updated_at still bumps updated_at in THIS row's own
      // apply-chunk transaction.
      const { error: rowError } = await admin.from("import_batch_rows").insert({
        batch_id: batchId,
        restaurant_id: restaurantId,
        row_number: 1,
        raw: {
          producer: "C2Contract Producer", name: "C2Contract Wine", quantity: "1", unit_cost: "10.00",
          vintage: "2022", size_ml: "750", varietal: null, region: null, country: null, format: null,
          currency: null, bin: null, section: null,
        },
        row_state: "valid",
        validation_errors: [],
        lwin_status: "matched",
        lwin_id: "C2CONTRACT-LWIN",
        lwin_score: 0.9,
        resolution: "auto",
        cost_status: "present",
      } as never);
      if (rowError) throw rowError;

      await applyImportBatchChunk(userClient, batchId);

      const { data: wineAfterApply } = await admin
        .from("wines")
        .select("lwin_id, lwin_match_score, updated_at")
        .eq("id", wineId)
        .single();
      const afterApply = wineAfterApply as { lwin_id: string | null; lwin_match_score: number | null; updated_at: string };
      // The pair itself is unchanged (it was already this exact pair) —
      // but apply's own transaction DID touch this wine: updated_at moved.
      expect(afterApply).toMatchObject({ lwin_id: "C2CONTRACT-LWIN", lwin_match_score: 0.9 });
      expect(afterApply.updated_at).not.toBe(preApplyUpdatedAt);

      const reverted = await revertImportBatch(userClient, restaurantId, batchId, admin);
      expect(reverted).toMatchObject({ ok: true, lwinStampsCleared: 1 });

      const { data: wineAfterRevert } = await admin
        .from("wines")
        .select("lwin_id, lwin_match_score")
        .eq("id", wineId)
        .single();
      // Cleared per the documented contract — NOT because this batch
      // "authored" the pair (it was already there), but because apply's
      // own conflict UPDATE genuinely re-asserted exactly these values in
      // its own transaction, and that's what revert undoes.
      expect(wineAfterRevert).toEqual({ lwin_id: null, lwin_match_score: null });
    });
  });

  // ── C-new-1 ──────────────────────────────────────────────────────────
  describe("C-new-1: a partially-applied, abandoned batch can now be reverted", () => {
    it("60% applied, never resolved further, still reverts cleanly", async () => {
      const rows = [
        ...Array.from({ length: 3 }, (_, i) => ({ producer: `Cnew1 Auto ${i}`, name: `Wine ${i}`, quantity: 2, unitCost: 5 })),
        { producer: "Cnew1 Pending", name: "Pending Wine", quantity: 1, unitCost: 5 },
        { producer: "Cnew1 Pending2", name: "Pending Wine 2", quantity: 1, unitCost: 5 },
      ];
      const confirmed = await confirmImportBatch(userClient, restaurantId, userId, "cnew1.csv", csvOf(rows));
      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok || confirmed.alreadyExists) return;
      const batchId = confirmed.batchId;

      // Only make the first 3 (of 5) rows eligible — the other 2 stay
      // 'pending' forever (the abandoned-mid-import scenario).
      const { data: pendingRows } = await admin
        .from("import_batch_rows")
        .select("id")
        .eq("batch_id", batchId)
        .eq("resolution", "pending")
        .order("row_number")
        .limit(3);
      const idsToMakeAuto = (pendingRows ?? []).slice(0, 3).map((r: { id: string }) => r.id);
      await admin.from("import_batch_rows").update({ resolution: "auto" } as never).in("id", idsToMakeAuto);

      const applied = await applyImportBatchChunk(userClient, batchId);
      expect(applied.status).toBe("applying"); // 3 applied, 2 still pending — never reaches 'completed'

      // Pre-fix (0076's original guard), this would fail with P0001.
      const reverted = await revertImportBatch(userClient, restaurantId, batchId, admin);
      expect(reverted).toMatchObject({ ok: true, revertedCount: 3 });

      const { data: batchRow } = await admin.from("import_batches").select("status").eq("id", batchId).single();
      expect((batchRow as { status: string }).status).toBe("reverted");
    });
  });

  // ── Session: tier-2 cross-batch dedup + session revert ────────────────
  describe("P3 §1.5/§3.3/§3.4: session-scoped cross-batch duplicate flagging and session revert", () => {
    it("tier 2(a): a row matching ALREADY-APPLIED inventory from a different, already-confirmed batch is flagged pending, not silently applied", async () => {
      const first = await confirmImportBatch(
        userClient, restaurantId, userId, "tier2a-1.csv",
        csvOf([{ producer: "Tier2a Producer", name: "Tier2a Wine", quantity: 6, unitCost: 20, bin: "A1", section: "Main" }]),
      );
      expect(first.ok).toBe(true);
      if (!first.ok || first.alreadyExists) return;
      await makeAllRowsEligible(first.batchId);
      await applyAll(first.batchId);

      const second = await confirmImportBatch(
        userClient, restaurantId, userId, "tier2a-2.csv",
        csvOf([{ producer: "Tier2a Producer", name: "Tier2a Wine", quantity: 4, unitCost: 20, bin: "a1", section: "main" }]),
      );
      expect(second.ok).toBe(true);
      if (!second.ok || second.alreadyExists) return;

      const { data: secondRows } = await admin
        .from("import_batch_rows")
        .select("resolution, duplicate_reason")
        .eq("batch_id", second.batchId);
      expect(secondRows).toHaveLength(1);
      const row = (secondRows as Array<{ resolution: string; duplicate_reason: unknown }>)[0];
      expect(row.resolution).toBe("pending");
      expect(row.duplicate_reason).toMatchObject({ type: "existing_inventory" });
    });

    it("tier 2(b) TOCTOU: two sibling chunks of the SAME session, both confirmed, neither applied yet — the LATER-confirmed chunk's row is flagged without requiring the earlier one to be applied first", async () => {
      const session = await createImportSession(userClient, restaurantId, userId, { label: "TOCTOU test" });
      if (!session.ok) throw new Error(`session create failed: ${session.error.message}`);

      const chunk1 = await confirmImportBatch(
        userClient, restaurantId, userId, "toctou-1.csv",
        csvOf([{ producer: "TOCTOU Producer", name: "TOCTOU Wine", quantity: 5, unitCost: 15, bin: "B2", section: "Cellar" }]),
        { sessionId: session.sessionId, chunkIndex: 1, chunkTotal: 2 },
      );
      expect(chunk1.ok).toBe(true);
      if (!chunk1.ok || chunk1.alreadyExists) return;
      // Deliberately NOT applied — both chunks are confirmed before either
      // is applied (the "stage everything, then go" workflow §3.3 names).

      const chunk4 = await confirmImportBatch(
        userClient, restaurantId, userId, "toctou-2.csv",
        csvOf([{ producer: "TOCTOU Producer", name: "TOCTOU Wine", quantity: 5, unitCost: 15, bin: "B2", section: "Cellar" }]),
        { sessionId: session.sessionId, chunkIndex: 2, chunkTotal: 2 },
      );
      expect(chunk4.ok).toBe(true);
      if (!chunk4.ok || chunk4.alreadyExists) return;

      const { data: chunk1Rows } = await admin.from("import_batch_rows").select("resolution").eq("batch_id", chunk1.batchId);
      expect((chunk1Rows as Array<{ resolution: string }>)[0].resolution).not.toBe("pending");

      const { data: chunk4Rows } = await admin.from("import_batch_rows").select("resolution, duplicate_reason").eq("batch_id", chunk4.batchId);
      const flagged = (chunk4Rows as Array<{ resolution: string; duplicate_reason: unknown }>)[0];
      expect(flagged.resolution).toBe("pending");
      expect(flagged.duplicate_reason).toMatchObject({ type: "sibling_batch" });
    });

    it("session revert: reverts every batch in reverse chunk order, touches only its own inventory, never wines", async () => {
      const session = await createImportSession(userClient, restaurantId, userId, { label: "Revert-as-unit test" });
      if (!session.ok) throw new Error(`session create failed: ${session.error.message}`);

      const c1 = await confirmImportBatch(
        userClient, restaurantId, userId, "rev-1.csv",
        csvOf([{ producer: "SessRevert P1", name: "Wine 1", quantity: 2, unitCost: 10 }]),
        { sessionId: session.sessionId, chunkIndex: 1, chunkTotal: 2 },
      );
      const c2 = await confirmImportBatch(
        userClient, restaurantId, userId, "rev-2.csv",
        csvOf([{ producer: "SessRevert P2", name: "Wine 2", quantity: 3, unitCost: 10 }]),
        { sessionId: session.sessionId, chunkIndex: 2, chunkTotal: 2 },
      );
      if (!c1.ok || c1.alreadyExists || !c2.ok || c2.alreadyExists) throw new Error("setup failed");

      await makeAllRowsEligible(c1.batchId);
      await makeAllRowsEligible(c2.batchId);
      await applyAll(c1.batchId);
      await applyAll(c2.batchId);

      const { data: wineIdsBefore } = await admin
        .from("wines")
        .select("id")
        .eq("restaurant_id", restaurantId)
        .in("producer", ["SessRevert P1", "SessRevert P2"]);
      expect(wineIdsBefore).toHaveLength(2);

      const reverted = await revertImportSession(userClient, session.sessionId);
      expect(reverted.ok).toBe(true);
      if (!reverted.ok) return;
      expect(reverted.batches.map((b) => b.batchId)).toEqual([c2.batchId, c1.batchId]); // reverse chunk order

      const { data: inventoryAfter } = await admin
        .from("inventory_items")
        .select("id")
        .in("wine_id", (wineIdsBefore as Array<{ id: string }>).map((w) => w.id));
      expect(inventoryAfter ?? []).toHaveLength(0);

      // Wines themselves are untouched (FK-direction reasoning, §3.4).
      const { data: wineIdsAfter } = await admin
        .from("wines")
        .select("id")
        .eq("restaurant_id", restaurantId)
        .in("producer", ["SessRevert P1", "SessRevert P2"]);
      expect(wineIdsAfter).toHaveLength(2);

      const { data: sessionRow } = await admin.from("import_sessions").select("status").eq("id", session.sessionId).single();
      expect((sessionRow as { status: string }).status).toBe("reverted");
    });
  });
});
