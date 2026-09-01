// MANDATORY live-DB suite for 0146's xwines_search RPC — the X-Wines half of
// the unified palette's catalogue pass (P1 slice 1). The thing under test is
// trigram matching + grants on a real table, so it cannot be mocked.
//
// Fixtures are synthetic and hermetic (CI seeds neither corpus — the
// lwin_xwines_links suite learned that the hard way): rows are inserted with
// ids past the real corpus range and a winery name no real corpus row
// carries, and removed in afterAll.
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

describe.skipIf(!hasLiveDb)("xwines_search RPC (MANDATORY)", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let userClient: SupabaseClient<Database>;
  let userId: string;
  const wineIdA = 999999911;
  const wineIdB = 999999912;
  const winery = "Zambezi Contract Cellars";
  const email = `xwines-search-${Date.now()}@example.test`;
  const password = "test-password-1234";

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });

    const { error: xErr } = await admin.from("xwines_catalog").insert([
      { wine_id: wineIdA, name: "Contract Cuvee Search", winery_name: winery, country: "Testland" },
      { wine_id: wineIdB, name: "Contract Cuvee Search", winery_name: winery, country: "Testland" },
    ] as never);
    if (xErr) throw xErr;

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
    await admin.from("xwines_catalog").delete().in("wine_id", [wineIdA, wineIdB]);
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it("an authenticated session finds a corpus row by fuzzy winery name", async () => {
    const { data, error } = await userClient.rpc("xwines_search", {
      p_query: "zambezi contract",
      p_limit: 5,
    });

    expect(error).toBeNull();
    const ours = (data ?? []).filter((r) => r.winery_name === winery);
    expect(ours.length).toBeGreaterThan(0);
    expect(ours[0]).toMatchObject({ name: "Contract Cuvee Search", country: "Testland" });
    expect(typeof ours[0].score).toBe("number");
  });

  it("tolerates a dropped accent/letter in the wine name", async () => {
    const { data, error } = await userClient.rpc("xwines_search", {
      p_query: "contrct cuvee search",
      p_limit: 5,
    });

    expect(error).toBeNull();
    expect((data ?? []).some((r) => r.winery_name === winery)).toBe(true);
  });

  it("orders equal-scoring rows deterministically by wine_id — 0127's rule", async () => {
    const { data, error } = await userClient.rpc("xwines_search", {
      p_query: "Contract Cuvee Search",
      p_limit: 10,
    });

    expect(error).toBeNull();
    const ours = (data ?? []).filter((r) => r.winery_name === winery).map((r) => r.wine_id);
    expect(ours).toEqual([wineIdA, wineIdB]);
  });
});
