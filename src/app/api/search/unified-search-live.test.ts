// MANDATORY live-DB suite for GET /api/search — the unified tier-1 endpoint,
// driven end to end: a real authenticated PostgREST session, the real `.or()`
// ilike pattern over five columns (a syntax mocks cannot validate), the real
// lwin_search/xwines_search RPCs, the real accepted-links read, and the merge.
//
// Fixtures are hermetic (CI seeds neither corpus): a tenant + one cellar wine
// whose REGION carries the search term (the D4 region-match fix — name and
// producer deliberately do not contain it), plus a synthetic LWIN row,
// X-Wines row and accepted P0 link, all with ids/names no real corpus row
// carries, removed in afterAll.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
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

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { GET } = await import("./route");

const LWIN_ID = "9999997";
const XWINES_ID = 999999921;
const WINERY = "Yggdrasil Contract Estate";

describe.skipIf(!hasLiveDb)("GET /api/search live wiring (MANDATORY)", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let restaurantId: string;
  let userId: string;
  let runId: string;
  const email = `unified-search-${Date.now()}@example.test`;
  const password = "test-password-1234";

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });

    const { data: r, error: rErr } = await admin
      .from("restaurants").insert({ name: "Unified Search Co" } as never).select("id").single();
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

    // The region-fix fixture: the search term appears ONLY in region.
    const { error: wErr } = await admin.from("wines").insert({
      restaurant_id: restaurantId,
      name: "House Red",
      producer: "Local Grower",
      region: "Norselands Yggdrasil Valley",
      size_ml: 750,
    } as never);
    if (wErr) throw wErr;

    // Slice 3b fixtures: the two rows also carry the FACTS a typed query
    // filters on, each spelled the way its own corpus spells it — LWIN says
    // "White" in `colour`, X-Wines says "White" in `type`. That difference is
    // the thing the filtered pass exists to handle, so the fixture has to
    // reproduce it rather than normalise it away.
    const { error: lErr } = await admin.from("lwin_catalog").insert({
      lwin_id: LWIN_ID,
      display_name: `${WINERY}, Cuvee Unified`,
      producer: WINERY,
      country: "Portugal",
      region: "Douro",
      colour: "White",
      type: "Wine",
    } as never);
    if (lErr) throw lErr;
    const { error: xErr } = await admin.from("xwines_catalog").insert({
      wine_id: XWINES_ID,
      name: "Cuvee Unified",
      winery_name: WINERY,
      country: "Portugal",
      region_name: "Douro",
      type: "White",
      body: "Light-bodied",
      vintages: [2016, 2017],
    } as never);
    if (xErr) throw xErr;

    const { data: run, error: runErr } = await admin
      .from("xwines_link_runs")
      .insert({ rule_version: "live-test/0", params: {} } as never)
      .select("id").single();
    if (runErr || !run) throw runErr ?? new Error("failed to insert run");
    runId = (run as { id: string }).id;
    const { error: linkErr } = await admin.from("lwin_xwines_links").insert({
      lwin_id: LWIN_ID,
      xwines_wine_id: XWINES_ID,
      status: "accepted",
      method: "exact",
      run_id: runId,
    } as never);
    if (linkErr) throw linkErr;

    const throwaway = createClient<Database>(supabaseUrl!, publishableKey!, { auth: { persistSession: false } });
    const { data: s, error: sErr } = await throwaway.auth.signInWithPassword({ email, password });
    if (sErr || !s.session) throw sErr ?? new Error("sign-in failed");
    const userClient = createClient<Database>(supabaseUrl!, publishableKey!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${s.session.access_token}` } },
    });
    mockRequireMembership.mockResolvedValue({ supabase: userClient, restaurantId });
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("lwin_catalog").delete().eq("lwin_id", LWIN_ID);
    await admin.from("xwines_catalog").delete().eq("wine_id", XWINES_ID);
    await admin.from("xwines_link_runs").delete().eq("id", runId);
    await admin.from("wines").delete().eq("restaurant_id", restaurantId);
    await admin.from("memberships").delete().eq("restaurant_id", restaurantId);
    await admin.from("restaurants").delete().eq("id", restaurantId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it("finds a cellar wine by its region alone — the D4 fix, through the real .or() syntax", async () => {
    const res = await GET(new NextRequest("http://localhost/api/search?q=norselands&scope=cellar"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ours = body.results.filter((r: { name: string }) => r.name === "House Red");
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ kind: "cellar", provenance: "cellar", region: "Norselands Yggdrasil Valley" });
  });

  it("returns the accepted-link catalogue pair as one deduped row through the real RPCs", async () => {
    const res = await GET(new NextRequest("http://localhost/api/search?q=yggdrasil%20contract"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const catalogue = body.results.filter(
      (r: { lwinId: string | null; xwinesWineId: number | null }) =>
        r.lwinId === LWIN_ID || r.xwinesWineId === XWINES_ID,
    );
    expect(catalogue).toHaveLength(1);
    expect(catalogue[0]).toMatchObject({
      kind: "catalogue",
      provenance: "lwin+xwines",
      deduped: true,
      lwinId: LWIN_ID,
      xwinesWineId: XWINES_ID,
    });
  });

  // P1 slice 3b — the filtered catalogue pass, through real PostgREST. What
  // only a live database can check: that the region `.or()` string, the
  // `overlaps` on an int[] and the colour predicate landing on a DIFFERENT
  // column per corpus are all valid syntax that matches the rows we think
  // they match. A mock accepts any string here.
  const ourRows = (body: { results: Array<{ lwinId: string | null; xwinesWineId: number | null }> }) =>
    body.results.filter((r) => r.lwinId === LWIN_ID || r.xwinesWineId === XWINES_ID);

  it("filters both corpora on facts each one spells its own way", async () => {
    const res = await GET(
      new NextRequest(`http://localhost/api/search?q=${encodeURIComponent("yggdrasil douro white")}`),
    );
    expect(res.status).toBe(200);
    const ours = ourRows(await res.json());
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ lwinId: LWIN_ID, xwinesWineId: XWINES_ID, deduped: true });
  });

  it("keeps LWIN in a vintage search, which it models at the wine's grain", async () => {
    // X-Wines matches 2016 through `vintages @> ...`; lwin_catalog has no
    // vintage column at all and must NOT be dropped for it — an LWIN row is
    // the wine, not the bottling.
    const res = await GET(
      new NextRequest(`http://localhost/api/search?q=${encodeURIComponent("yggdrasil douro 2016")}`),
    );
    const ours = ourRows(await res.json());
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ lwinId: LWIN_ID, xwinesWineId: XWINES_ID });
  });

  it("drops LWIN from a sparkling search rather than offering it a still wine", async () => {
    // Same row the previous tests find, same needle, same region — only the
    // colour word changes, and lwin_catalog.colour has no value that means
    // sparkling. Returning it anyway would answer the question wrongly.
    const res = await GET(
      new NextRequest(`http://localhost/api/search?q=${encodeURIComponent("yggdrasil douro sparkling")}`),
    );
    const body = await res.json();
    expect(body.results.some((r: { lwinId: string | null }) => r.lwinId === LWIN_ID)).toBe(false);
  });
});
