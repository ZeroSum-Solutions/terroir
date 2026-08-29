// Live-Postgres regression tests for migrations 0127 and 0128.
//
// 0127 — match_lwin gains `order by score desc, lc.lwin_id asc`. Before it, two
//        catalogue rows tying on score had no defined winner, so preview and
//        confirm (which deliberately re-runs the match from scratch) could
//        select different LWIN ids for the same import row.
// 0128 — apply_import_batch_chunk takes a transaction-scoped advisory lock keyed
//        by (restaurant, underlying file) and re-checks for an applied sibling
//        INSIDE that lock, raising P0004. Before it, the only sibling check was
//        the route's, in a separate transaction, which a direct RPC call skipped
//        entirely (the RPC is granted to `authenticated`).
//
// Same convention as p3-live.test.ts: real Postgres required, because both
// behaviours are properties of database functions and transactions that a mocked
// client cannot demonstrate. Fails loud in CI rather than skipping silently.
//
// These tests build import_batches / import_batch_rows rows directly through the
// admin client. That is deliberate: the point is to exercise the RPC's barrier
// against digest shapes (bare, overrides-v1..v4, malformed, null) that would take
// a great deal of fixture plumbing to produce through the real confirm path, and
// several of which — the historic malformed ones — the confirm path can no
// longer emit at all.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { applyImportBatchChunk, revertImportBatch } from "./batch-service";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasLiveDb = Boolean(supabaseUrl && publishableKey && serviceRoleKey);

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

/** A distinct 64-hex file digest per call, so tests never collide on the barrier. */
let digestCounter = 0;
function fileDigest(): string {
  digestCounter += 1;
  return digestCounter.toString(16).padStart(64, "0");
}

/** The sha256-shaped first component of an overrides-vN digest. Content is
 *  irrelevant to the barrier — only the TRAILING 64 hex identify the file. */
const OVERRIDES_COMPONENT = "a".repeat(64);

describe.skipIf(!hasLiveDb)("import hardening 0127/0128 (MANDATORY, live Postgres)", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let userClient: SupabaseClient<Database>;
  let restaurantId: string;
  let userId: string;

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });

    const { data: restaurant, error: restaurantError } = await admin
      .from("restaurants")
      .insert({ name: "Import Hardening 0127/0128" } as never)
      .select("id")
      .single();
    if (restaurantError || !restaurant) throw restaurantError ?? new Error("failed to insert restaurant");
    restaurantId = (restaurant as { id: string }).id;

    const password = "Import-Hardening-Test-123!";
    const email = `import-hardening-${Date.now()}@terroir.test`;
    const { data: user, error: userError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (userError || !user) throw userError ?? new Error("failed to create user");
    userId = user.user.id;

    const { error: memError } = await admin
      .from("memberships")
      .insert({ user_id: userId, restaurant_id: restaurantId, role: "staff" } as never);
    if (memError) throw memError;

    userClient = await signedInClient(email, password);
  }, 30_000);

  afterAll(async () => {
    if (restaurantId) await admin.from("restaurants").delete().eq("id", restaurantId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  /**
   * Creates a batch with `rowCount` apply-eligible rows and the given digest.
   * `contentSha256: null` reproduces a historic pre-0103 batch.
   */
  async function makeBatch(contentSha256: string | null, rowCount = 1): Promise<string> {
    const { data: batch, error: batchError } = await admin
      .from("import_batches")
      .insert({
        restaurant_id: restaurantId,
        created_by: userId,
        filename: "hardening.csv",
        total_rows: rowCount,
        content_sha256: contentSha256,
      } as never)
      .select("id")
      .single();
    if (batchError || !batch) throw batchError ?? new Error("failed to insert batch");
    const batchId = (batch as { id: string }).id;

    const rows = Array.from({ length: rowCount }, (_, i) => ({
      batch_id: batchId,
      restaurant_id: restaurantId,
      row_number: i + 1,
      raw: {
        producer: `Hardening Producer ${batchId.slice(0, 8)}`,
        name: `Hardening Wine ${i + 1}`,
        vintage: "2019",
        quantity: "2",
        unit_cost: "25.00",
      },
      row_state: "valid",
      resolution: "auto",
      cost_status: "present",
    }));
    const { error: rowsError } = await admin.from("import_batch_rows").insert(rows as never);
    if (rowsError) throw rowsError;

    return batchId;
  }

  async function appliedRowCount(batchId: string): Promise<number> {
    const { count, error } = await admin
      .from("import_batch_rows")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", batchId)
      .eq("apply_status", "applied");
    if (error) throw error;
    return count ?? 0;
  }

  /** Calls the RPC the way a caller bypassing the route would — directly. */
  async function directApply(client: SupabaseClient<Database>, batchId: string) {
    return client.rpc("apply_import_batch_chunk", { p_batch_id: batchId, p_limit: 50 } as never);
  }

  // ── 0128: the barrier ────────────────────────────────────────────────
  describe("0128: a sibling batch for the same underlying file cannot apply", () => {
    it("refuses a DIRECT RPC call — the path the route guard never covered", async () => {
      const digest = fileDigest();
      const batchA = await makeBatch(digest);
      const batchB = await makeBatch(`overrides-v4:${OVERRIDES_COMPONENT}:${digest}`);

      await applyImportBatchChunk(userClient, batchA);
      expect(await appliedRowCount(batchA)).toBe(1);

      // Straight at the RPC: no route, no pre-flight guard. Before 0128 this
      // applied happily and produced a second set of inventory for one file.
      const { error } = await directApply(userClient, batchB);

      expect(error?.code).toBe("P0004");
      expect(error?.message).toMatch(/already has applied rows/i);
      expect(await appliedRowCount(batchB)).toBe(0);
    });

    it("normalises every digest namespace to the same underlying file", async () => {
      // Each of these is a DIFFERENT content_sha256 but the SAME file. The
      // barrier must see through all of them, including a version number no
      // code has written yet — the readers generalise over [0-9]+, so a future
      // overrides-v9 must not silently escape enforcement.
      const namespaces = ["overrides-v1", "overrides-v2", "overrides-v3", "overrides-v4", "overrides-v9"];

      for (const namespace of namespaces) {
        const digest = fileDigest();
        const applied = await makeBatch(digest);
        await applyImportBatchChunk(userClient, applied);

        const sibling = await makeBatch(`${namespace}:${OVERRIDES_COMPONENT}:${digest}`);
        const { error } = await directApply(userClient, sibling);

        expect(error?.code, `${namespace} escaped the barrier`).toBe("P0004");
      }
    });

    it("does not block a DIFFERENT file in the same tenant", async () => {
      // Named for exactly what it exercises. The cross-tenant case is covered
      // by the lock key and the barrier predicate both including restaurant_id,
      // but this suite has one tenant fixture and does not demonstrate it —
      // claiming otherwise in the title was the whole of Sol's WARN 3.
      const applied = await makeBatch(fileDigest());
      await applyImportBatchChunk(userClient, applied);

      // Different file entirely — must apply normally.
      const unrelated = await makeBatch(fileDigest());
      const { error } = await directApply(userClient, unrelated);
      expect(error).toBeNull();
      expect(await appliedRowCount(unrelated)).toBe(1);
    });

    it("REFUSES to create a new batch with a null or malformed digest", async () => {
      // 0128 skips rows whose digest cannot be normalised to a file identity,
      // on the understanding that such rows are historic pre-0103 leftovers.
      // Sol's audit showed that was false: create_import_batch takes an
      // unvalidated `p_content_sha256 default null` and is granted to
      // `authenticated`, which also holds direct insert/update on the table —
      // so a caller could MANUFACTURE two unlockable batches for one file and
      // walk straight past the barrier. 0129 makes that state uncreatable.
      //
      // This test previously asserted the OPPOSITE — that two fresh malformed
      // batches both apply — and passing was the bug.
      const rejected: Array<string | null> = [
        null,
        "not-a-digest",
        "overrides-v1:tooshort:alsoshort",
        "ABCDEF0123456789".repeat(4), // uppercase: outside the ^[0-9a-f]{64}$ grammar
      ];

      for (const digest of rejected) {
        const { error } = await admin
          .from("import_batches")
          .insert({
            restaurant_id: restaurantId,
            created_by: userId,
            filename: "hardening.csv",
            total_rows: 1,
            content_sha256: digest,
          } as never)
          .select("id")
          .single();

        // 23514 = check_violation. Service role is not exempt: a CHECK is a
        // table constraint, not an RLS policy.
        expect(error?.code, `digest ${String(digest)} was accepted`).toBe("23514");
      }
    });

    it("REFUSES to repoint an existing batch at another file's digest", async () => {
      // The constraint alone still permits rewriting one VALID digest into a
      // DIFFERENT valid one, which defeats the lock just as effectively: point
      // batch A at file B's identity and the two stop contending.
      const batchId = await makeBatch(fileDigest());

      const { error } = await admin
        .from("import_batches")
        .update({ content_sha256: fileDigest() } as never)
        .eq("id", batchId);

      expect(error?.code).toBe("P0005");
    });

    it("lets repeated chunk calls drain ONE batch without self-conflict", async () => {
      // Each chunk call is its own RPC and therefore its own TRANSACTION, so
      // this is not one transaction re-acquiring a lock it already holds (the
      // previous comment said that, and it was wrong): each call takes the lock,
      // does its work, and releases it at commit. What must hold is that the
      // sibling check excludes the batch itself, so draining never refuses
      // itself partway through and never deadlocks against its own predecessor.
      const batchId = await makeBatch(fileDigest(), 5);

      let drained = 0;
      for (let i = 0; i < 10; i++) {
        const result = await applyImportBatchChunk(userClient, batchId);
        drained = result.counts.eligibleNotApplied;
        if (drained === 0) break;
      }

      expect(drained).toBe(0);
      expect(await appliedRowCount(batchId)).toBe(5);
    });

    it("lets a sibling apply once the first batch is reverted", async () => {
      const digest = fileDigest();
      const batchA = await makeBatch(digest);
      const batchB = await makeBatch(`overrides-v2:${OVERRIDES_COMPONENT}:${digest}`);

      await applyImportBatchChunk(userClient, batchA);
      expect((await directApply(userClient, batchB)).error?.code).toBe("P0004");

      // Reverting A releases the file: revert marks A's rows non-applied, so
      // the barrier's `apply_status = 'applied'` predicate no longer matches.
      const reverted = await revertImportBatch(userClient, restaurantId, batchA, admin);
      expect(reverted.ok).toBe(true);

      const { error } = await directApply(userClient, batchB);
      expect(error).toBeNull();
      expect(await appliedRowCount(batchB)).toBe(1);
    });

    it("produces exactly one winner when two siblings apply concurrently", async () => {
      // Both calls go out together in independent transactions, so they CAN
      // contend for the advisory lock. The loser either waits and then sees the
      // winner's committed rows, or finds them already there — either way it
      // must refuse. What must NEVER happen is both succeeding, which is
      // precisely what the separate-transaction route guard permitted.
      //
      // HONEST LIMIT (Sol WARN 3): this proves the barrier as a WHOLE, not the
      // advisory lock in isolation. Nothing here forces both transactions to sit
      // inside the check simultaneously, so a build with the lock removed but
      // the under-lock `exists` retained can still pass whenever one call
      // commits before the other reaches the check. Reverting the full 0128 down
      // removes lock AND check together, so the red-after-down result does not
      // isolate the lock either. Isolating it needs two transactions held open
      // across the check, which this REST-client harness cannot express.
      const digest = fileDigest();
      const batchA = await makeBatch(digest);
      const batchB = await makeBatch(`overrides-v3:${OVERRIDES_COMPONENT}:${digest}`);

      const [resultA, resultB] = await Promise.all([
        directApply(userClient, batchA),
        directApply(userClient, batchB),
      ]);

      const errors = [resultA.error, resultB.error].filter(Boolean);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("P0004");

      const totalApplied = (await appliedRowCount(batchA)) + (await appliedRowCount(batchB));
      expect(totalApplied).toBe(1);
    });
  });

  // ── 0127: deterministic tie-break ────────────────────────────────────
  describe("0127: match_lwin breaks exact score ties deterministically", () => {
    const producer = "Chateau Determinism";
    const displayName = "Chateau Determinism Grand Vin";
    // Inserted high-then-low so insertion order is the OPPOSITE of the required
    // answer: a test that passed merely because Postgres happened to return
    // insertion order would still fail here.
    const higherId = "TIEBREAK99";
    const lowerId = "TIEBREAK01";

    beforeAll(async () => {
      const { error } = await admin.from("lwin_catalog").insert([
        { lwin_id: higherId, display_name: displayName, producer },
        { lwin_id: lowerId, display_name: displayName, producer },
      ] as never);
      if (error) throw error;
    });

    afterAll(async () => {
      await admin.from("lwin_catalog").delete().in("lwin_id", [higherId, lowerId]);
    });

    it("always returns the lowest lwin_id among equally-scoring rows", async () => {
      // Identical producer AND display_name means identical similarity on both
      // terms, so the two rows score EXACTLY equal — the tie 0078 left open.
      for (let i = 0; i < 8; i++) {
        const { data, error } = await userClient.rpc("match_lwin", {
          p_producer: producer,
          p_name: displayName,
        } as never);
        expect(error).toBeNull();
        const rows = (data ?? []) as Array<{ lwin_id: string }>;
        expect(rows[0]?.lwin_id).toBe(lowerId);
      }
    });

    it("gives match_lwin_bulk the same winner, since it delegates to match_lwin", async () => {
      // The import path reaches the catalogue through _bulk, never match_lwin
      // directly, so the fix is only worth anything if it is inherited here.
      const { data, error } = await userClient.rpc("match_lwin_bulk", {
        p_queries: [{ idx: 0, producer, name: displayName }],
      } as never);
      expect(error).toBeNull();
      const rows = (data ?? []) as Array<{ lwin_id: string | null }>;
      expect(rows[0]?.lwin_id).toBe(lowerId);
    });
  });
});
