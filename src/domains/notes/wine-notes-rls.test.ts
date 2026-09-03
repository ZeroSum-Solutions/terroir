// Cross-tenant containment for wine_notes — migration 0148.
//
// THE DEFECT THIS SUITE EXISTS TO PREVENT
// wine_notes.wine_id is `references public.wines(id) on delete cascade`, and
// Postgres FK cascades run as the table owner and BYPASS RLS entirely. A
// policy that gated only on membership of the row's own restaurant — which is
// the obvious way to write it, and the way stock_adjustments and
// bottle_closeouts were written before 0136 — would let a member of tenant B
// insert a perfectly compliant row (restaurant_id = B, author = themselves)
// naming tenant A's wine_id. When tenant A later deleted that wine for their
// own reasons, the cascade would silently destroy tenant B's note. Tenant A
// cannot see what they destroyed; tenant B is never told.
//
// A tasting note is not recoverable. It is prose somebody typed once.
//
// MANDATORY live-DB suite. The boundary being tested IS row-level security, so
// a mocked client proves nothing whatsoever here — only a real Postgres
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

describe.skipIf(!hasLiveDb)("wine_notes cross-tenant containment (MANDATORY)", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let restaurantA: string;
  let restaurantB: string;
  let userBClient: SupabaseClient<Database>;
  let userBId: string;
  let userAId: string;
  let wineA: string;
  let wineB: string;
  let canonicalId: string;
  let noteA: string;

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });

    const { data: rA, error: rAErr } = await admin.from("restaurants").insert({ name: "Notes Policy A" } as never).select("id").single();
    if (rAErr || !rA) throw rAErr ?? new Error("failed to insert restaurant A");
    restaurantA = (rA as { id: string }).id;

    const { data: rB, error: rBErr } = await admin.from("restaurants").insert({ name: "Notes Policy B" } as never).select("id").single();
    if (rBErr || !rB) throw rBErr ?? new Error("failed to insert restaurant B");
    restaurantB = (rB as { id: string }).id;

    const run = Date.now();
    const password = "Notes-Policy-Test-123!";

    const { data: userA, error: userAErr } = await admin.auth.admin.createUser({
      email: `notes-policy-a-${run}@terroir.test`, password, email_confirm: true,
    });
    if (userAErr || !userA) throw userAErr ?? new Error("failed to create user A");
    userAId = userA.user.id;

    const { data: userB, error: userBErr } = await admin.auth.admin.createUser({
      email: `notes-policy-b-${run}@terroir.test`, password, email_confirm: true,
    });
    if (userBErr || !userB) throw userBErr ?? new Error("failed to create user B");
    userBId = userB.user.id;

    const { error: memAErr } = await admin.from("memberships").insert({ user_id: userAId, restaurant_id: restaurantA, role: "staff" } as never);
    if (memAErr) throw memAErr;
    const { error: memBErr } = await admin.from("memberships").insert({ user_id: userBId, restaurant_id: restaurantB, role: "staff" } as never);
    if (memBErr) throw memBErr;

    const { data: wines, error: wineErr } = await admin.from("wines").insert([
      { restaurant_id: restaurantA, name: "Tenant A Cuvee", producer: "Notes Estate", size_ml: 750 },
      { restaurant_id: restaurantB, name: "Tenant B Cuvee", producer: "Notes Estate", size_ml: 750 },
    ] as never).select("id, restaurant_id");
    if (wineErr || !wines) throw wineErr ?? new Error("failed to insert wines");
    const rows = wines as { id: string; restaurant_id: string }[];
    wineA = rows.find((w) => w.restaurant_id === restaurantA)!.id;
    wineB = rows.find((w) => w.restaurant_id === restaurantB)!.id;

    // A note tenant A owns, so the read test has something it must NOT see.
    const { data: nA, error: nAErr } = await admin.from("wine_notes").insert({
      restaurant_id: restaurantA, wine_id: wineA, author_user_id: userAId,
      body: "Tenant A's private note.",
    } as never).select("id").single();
    if (nAErr || !nA) throw nAErr ?? new Error("failed to insert tenant A note");
    noteA = (nA as { id: string }).id;

    const { data: cw, error: cwErr } = await admin.from("canonical_wines").insert({
      producer: "Notes Estate", cuvee: "Reference Probe",
    } as never).select("id").single();
    if (cwErr || !cw) throw cwErr ?? new Error("failed to insert canonical wine");
    canonicalId = (cw as { id: string }).id;

    userBClient = await signedInClient(userB.user.email!, password);
  });

  afterAll(async () => {
    await admin.from("wine_reference_notes").delete().eq("canonical_wine_id", canonicalId);
    await admin.from("canonical_wines").delete().eq("id", canonicalId);
    await admin.from("restaurants").delete().in("id", [restaurantA, restaurantB]);
    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
  });

  it("refuses a note naming another tenant's wine", async () => {
    const { error } = await userBClient.from("wine_notes").insert({
      restaurant_id: restaurantB,
      wine_id: wineA, // tenant A's wine — the whole point
      author_user_id: userBId,
      body: "Should never land.",
    } as never);

    // Every other clause is satisfied: B is a member of B, and the author is
    // genuinely B. Only the wine-ownership clause can reject this.
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security|violates/i);
  });

  it("allows a note on the tenant's own wine", async () => {
    const { error } = await userBClient.from("wine_notes").insert({
      restaurant_id: restaurantB,
      wine_id: wineB,
      author_user_id: userBId,
      body: "Tight now, should open up.",
    } as never);
    expect(error).toBeNull();
  });

  it("refuses a note attributed to somebody else", async () => {
    const { error } = await userBClient.from("wine_notes").insert({
      restaurant_id: restaurantB,
      wine_id: wineB,
      author_user_id: userAId, // not the signed-in user
      body: "Putting words in another mouth.",
    } as never);
    expect(error).not.toBeNull();
  });

  it("cannot read another tenant's notes", async () => {
    const { data, error } = await userBClient.from("wine_notes").select("id").eq("wine_id", wineA);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("cannot delete another tenant's note", async () => {
    await userBClient.from("wine_notes").delete().eq("id", noteA);
    // RLS filters the row out rather than erroring, so the proof is that it
    // survives — checked with the service role, which sees everything.
    const { data } = await admin.from("wine_notes").select("id").eq("id", noteA);
    expect(data).toHaveLength(1);
  });

  it("cannot author a reference note that every other tenant would read as sourced fact", async () => {
    const { error } = await userBClient.from("wine_reference_notes").insert({
      canonical_wine_id: canonicalId,
      vintage: 2019,
      source_kind: "producer",
      source_name: "Invented Domaine",
      source_url: "https://example.invalid/not-a-real-sheet",
      fetched_at: new Date().toISOString(),
      body: "A tenant should not be able to publish this to everyone.",
    } as never);
    // There is no INSERT policy on this table at all — the service-role
    // ingestion job is the only writer.
    expect(error).not.toBeNull();
  });

  it("can read reference notes, which are global on purpose", async () => {
    await admin.from("wine_reference_notes").insert({
      canonical_wine_id: canonicalId,
      vintage: 2019,
      source_kind: "producer",
      source_name: "Notes Estate",
      source_url: "https://example.invalid/sheet",
      fetched_at: new Date().toISOString(),
      body: "Sourced by the ingestion job.",
    } as never);

    const { data, error } = await userBClient
      .from("wine_reference_notes").select("id").eq("canonical_wine_id", canonicalId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
  });
});
