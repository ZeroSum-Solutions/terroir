// MANDATORY live-DB suite. The thing under test is 0145's grant/RLS boundary
// and its CHECK-constraint shape rules, so it cannot be exercised against a
// mock: the only honest assertion is what a real session gets back from a
// real table.
//
// 0145 creates the WS-IDENT linkage storage (identity policy §5):
//   xwines_link_runs            — run provenance (rule version, params)
//   lwin_xwines_links           — one decision per LWIN row (the P1 dedupe read)
//   lwin_xwines_link_tombstones — pairs a human split; never auto-linked again
//
// The read contract is asymmetric by design: `lwin_xwines_links` is global
// reference data in the shape of lwin_catalog (authenticated select-only —
// P1's palette dedupes on it), while runs and tombstones are operator/batch
// plumbing denied to application sessions at the privilege layer, exactly
// like producer_backfill_audit (0137). The 42501 assertions pin the grant
// was never issued — if a well-meaning grant appeared later, RLS would turn
// the error into a silent `[]`, and that regression must fail here.
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

describe.skipIf(!hasLiveDb)("lwin_xwines_links storage contract (MANDATORY)", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let userClient: SupabaseClient<Database>;
  let userId: string;
  let runId: string;
  let lwinIdA: string;
  let lwinIdB: string;
  let xwinesId: number;
  const email = `lwin-xwines-links-${Date.now()}@example.test`;
  const password = "test-password-1234";

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });

    // Real corpus rows, not fabricated ids: both FK targets are global
    // reference tables that every environment seeds. Descending, so these are
    // the LAST rows a concurrently running scripts/link-lwin-xwines.ts batch
    // (which walks lwin_id ascending and upserts every row) would touch — a
    // local batch mid-run must not clobber this suite's fixtures.
    const { data: lwins, error: lErr } = await admin
      .from("lwin_catalog").select("lwin_id").order("lwin_id", { ascending: false }).limit(2);
    if (lErr || !lwins || lwins.length < 2) throw lErr ?? new Error("lwin_catalog not seeded");
    lwinIdA = lwins[0].lwin_id;
    lwinIdB = lwins[1].lwin_id;

    const { data: xw, error: xErr } = await admin
      .from("xwines_catalog").select("wine_id").order("wine_id").limit(1).single();
    if (xErr || !xw) throw xErr ?? new Error("xwines_catalog not seeded");
    xwinesId = xw.wine_id;

    const { data: run, error: runErr } = await admin
      .from("xwines_link_runs")
      .insert({ rule_version: "test-rule/0", params: { test: true } } as never)
      .select("id").single();
    if (runErr || !run) throw runErr ?? new Error("failed to insert run");
    runId = (run as { id: string }).id;

    const { error: linkErr } = await admin.from("lwin_xwines_links").insert({
      lwin_id: lwinIdA,
      xwines_wine_id: xwinesId,
      status: "accepted",
      method: "trigram",
      score: 0.91,
      producer_score: 0.95,
      name_score: 0.88,
      second_score: null,
      run_id: runId,
    } as never);
    if (linkErr) throw linkErr;

    const { data: u, error: uErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (uErr || !u.user) throw uErr ?? new Error("failed to create user");
    userId = u.user.id;

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
    await admin.from("lwin_xwines_link_tombstones").delete().in("lwin_id", [lwinIdA, lwinIdB]);
    await admin.from("lwin_xwines_links").delete().in("lwin_id", [lwinIdA, lwinIdB]);
    await admin.from("xwines_link_runs").delete().eq("id", runId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it("an authenticated session can read links — P1's palette dedupes on them", async () => {
    const { data, error } = await userClient
      .from("lwin_xwines_links")
      .select("lwin_id, xwines_wine_id, status, score")
      .eq("lwin_id", lwinIdA);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ xwines_wine_id: xwinesId, status: "accepted" });
  });

  it("an authenticated session cannot write links", async () => {
    const { error } = await userClient.from("lwin_xwines_links").insert({
      lwin_id: lwinIdB,
      status: "abstained",
      run_id: runId,
    } as never);

    expect(error?.code).toBe("42501");
  });

  it("an authenticated session cannot read runs", async () => {
    const { data, error } = await userClient.from("xwines_link_runs").select("*");

    expect(error?.code).toBe("42501");
    expect(data).toBeNull();
  });

  it("an authenticated session cannot read tombstones", async () => {
    const { data, error } = await userClient.from("lwin_xwines_link_tombstones").select("*");

    expect(error?.code).toBe("42501");
    expect(data).toBeNull();
  });

  it("rejects an accepted link with no corpus wine attached", async () => {
    const { error } = await admin.from("lwin_xwines_links").insert({
      lwin_id: lwinIdB,
      status: "accepted",
      method: "trigram",
      score: 0.9,
      producer_score: 0.9,
      name_score: 0.9,
      run_id: runId,
    } as never);

    expect(error?.code).toBe("23514");
  });

  it("rejects a trigram acceptance with no score vector — §5 requires it", async () => {
    const { error } = await admin.from("lwin_xwines_links").insert({
      lwin_id: lwinIdB,
      xwines_wine_id: xwinesId,
      status: "accepted",
      method: "trigram",
      run_id: runId,
    } as never);

    expect(error?.code).toBe("23514");
  });

  it("accepts an exact-join link without a score vector — equality was the measurement", async () => {
    const { error } = await admin.from("lwin_xwines_links").insert({
      lwin_id: lwinIdB,
      xwines_wine_id: xwinesId,
      status: "accepted",
      method: "exact",
      run_id: runId,
    } as never);

    expect(error).toBeNull();
    await admin.from("lwin_xwines_links").delete().eq("lwin_id", lwinIdB);
  });

  it("rejects an abstained row that still names a corpus wine", async () => {
    const { error } = await admin.from("lwin_xwines_links").insert({
      lwin_id: lwinIdB,
      xwines_wine_id: xwinesId,
      status: "abstained",
      run_id: runId,
    } as never);

    expect(error?.code).toBe("23514");
  });

  it("requires a reason on review rows and refuses one elsewhere", async () => {
    const { error: missingReason } = await admin.from("lwin_xwines_links").insert({
      lwin_id: lwinIdB,
      xwines_wine_id: xwinesId,
      status: "review",
      method: "trigram",
      score: 0.7, producer_score: 0.85, name_score: 0.65,
      run_id: runId,
    } as never);
    expect(missingReason?.code).toBe("23514");

    const { error: strayReason } = await admin.from("lwin_xwines_links").insert({
      lwin_id: lwinIdB,
      status: "abstained",
      review_reason: "ambiguous",
      run_id: runId,
    } as never);
    expect(strayReason?.code).toBe("23514");
  });

  it("service_role can record and read a tombstone", async () => {
    const { error: insErr } = await admin.from("lwin_xwines_link_tombstones").insert({
      lwin_id: lwinIdA,
      xwines_wine_id: xwinesId,
      reason: "test split: wrong cuvée",
    } as never);
    expect(insErr).toBeNull();

    const { data, error } = await admin
      .from("lwin_xwines_link_tombstones")
      .select("lwin_id, xwines_wine_id, reason")
      .eq("lwin_id", lwinIdA);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});
