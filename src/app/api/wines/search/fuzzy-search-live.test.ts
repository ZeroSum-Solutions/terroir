// MANDATORY live-DB suite. The thing under test is a Postgres function whose
// whole behaviour is trigram scoring, accent folding and RLS — none of which a
// mock can imitate. The only honest assertion is what a real authenticated
// session gets back from a real table.
//
// SCAN-06 regression fixture. Reported from the field: searching for a
// Frédéric Savart champagne as "Fredric savart" returned an empty list. The
// route built ONE ILIKE pattern out of the WHOLE query, which fails twice
// over — a multi-word query cannot span producer + name, and ILIKE has no
// typo or diacritic tolerance. The first test below asserts BOTH halves: that
// the old predicate still finds nothing (so the fixture really does reproduce
// the bug) and that the new RPC finds the wine.
//
// Every wine fixture here has an EMPTY producer with the producer name
// embedded in `name`. That is not a contrivance: 1,277 of the 1,527 wines in
// the local corpus arrived that way from a CSV import, and 0137 deliberately
// left 321 of them unrepaired because their spelling is not in LWIN
// ("Bérêche & Fils" vs the catalogue's "Bereche et Fils"). A matcher that
// assumes a populated producer is blind to the majority of the corpus.
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

// The route passes this explicitly for the reason spelled out in 0144: the
// hardest real case, "fredric" -> "Frédéric", scores 0.545455 — it clears 0.5
// and FAILS pg_trgm's default of 0.6.
const THRESHOLD = 0.5;

const FIXTURES = [
  { name: "Frédéric Savart Haute Couture", producer: "" },
  { name: "Frédéric Savart L'Ouverture", producer: "" },
  { name: "Bérêche & Fils Le Cran", producer: "" },
  { name: "Benjamin Leroux Vosne-Romanée", producer: "" },
  // Control: must never be returned by any of the queries below.
  { name: "Koonunga Hill Shiraz Cabernet", producer: "Penfolds" },
];

describe.skipIf(!hasLiveDb)("search_wines_fuzzy (SCAN-06, MANDATORY)", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let ownerClient: SupabaseClient<Database>;
  let outsiderClient: SupabaseClient<Database>;
  let restaurantId: string;
  let otherRestaurantId: string;
  const userIds: string[] = [];
  const stamp = Date.now();
  const password = "test-password-1234";

  async function makeMember(restaurant: string, label: string) {
    const email = `fuzzy-${label}-${stamp}@example.test`;
    const { data: u, error: uErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (uErr || !u.user) throw uErr ?? new Error("failed to create user");
    userIds.push(u.user.id);

    const { error: mErr } = await admin
      .from("memberships")
      .insert({ restaurant_id: restaurant, user_id: u.user.id, role: "owner" } as never);
    if (mErr) throw mErr;

    const throwaway = createClient<Database>(supabaseUrl!, publishableKey!, {
      auth: { persistSession: false },
    });
    const { data: s, error: sErr } = await throwaway.auth.signInWithPassword({ email, password });
    if (sErr || !s.session) throw sErr ?? new Error("sign-in failed");
    return createClient<Database>(supabaseUrl!, publishableKey!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${s.session.access_token}` } },
    });
  }

  async function fuzzy(
    client: SupabaseClient<Database>,
    restaurant: string,
    query: string,
    threshold = THRESHOLD,
  ) {
    const { data, error } = await client.rpc("search_wines_fuzzy", {
      p_restaurant_id: restaurant,
      p_query: query,
      p_threshold: threshold,
      p_limit: 20,
    });
    if (error) throw error;
    const ids = (data ?? []).map((row) => row.wine_id);
    if (ids.length === 0) return [] as string[];
    const { data: rows, error: rowsError } = await admin
      .from("wines")
      .select("id, name")
      .in("id", ids);
    if (rowsError) throw rowsError;
    const byId = new Map((rows ?? []).map((row) => [row.id, row.name]));
    // Preserve the RPC's own ranking; the lookup above does not.
    return ids.map((id) => byId.get(id) ?? id);
  }

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, {
      auth: { persistSession: false },
    });

    const { data: rs, error: rErr } = await admin
      .from("restaurants")
      .insert([{ name: `Fuzzy Search Co ${stamp}` }, { name: `Fuzzy Outsider Co ${stamp}` }] as never)
      .select("id");
    if (rErr || !rs || rs.length !== 2) throw rErr ?? new Error("failed to insert restaurants");
    restaurantId = (rs as { id: string }[])[0].id;
    otherRestaurantId = (rs as { id: string }[])[1].id;

    const { error: wErr } = await admin.from("wines").insert(
      FIXTURES.map((wine) => ({ ...wine, restaurant_id: restaurantId, size_ml: 750 })) as never,
    );
    if (wErr) throw wErr;

    // The outsider tenant holds a wine that WOULD match every query below, so
    // a leak shows up as a wrong row rather than as an empty list either way.
    const { error: oErr } = await admin.from("wines").insert({
      restaurant_id: otherRestaurantId,
      name: "Frédéric Savart Bulles de Rosé",
      producer: "",
      size_ml: 750,
    } as never);
    if (oErr) throw oErr;

    ownerClient = await makeMember(restaurantId, "owner");
    outsiderClient = await makeMember(otherRestaurantId, "outsider");
  });

  afterAll(async () => {
    if (!admin) return;
    for (const id of [restaurantId, otherRestaurantId].filter(Boolean)) {
      await admin.from("wines").delete().eq("restaurant_id", id);
      await admin.from("memberships").delete().eq("restaurant_id", id);
      await admin.from("restaurants").delete().eq("id", id);
    }
    for (const id of userIds) await admin.auth.admin.deleteUser(id);
  });

  it("REGRESSION: 'Fredric savart' found nothing before and finds Savart now", async () => {
    // The exact predicate the route used before this change, character for
    // character (route.ts quotePostgrestPattern). This half of the assertion
    // is what makes the test a regression fixture rather than a feature test:
    // if it ever starts returning rows, the bug was never what we said it was.
    const { data: exact, error: exactError } = await ownerClient
      .from("wines")
      .select("id")
      .eq("restaurant_id", restaurantId)
      .or('name.ilike."%Fredric savart%",producer.ilike."%Fredric savart%"');
    expect(exactError).toBeNull();
    expect(exact).toEqual([]);

    const names = await fuzzy(ownerClient, restaurantId, "Fredric savart");
    expect(names).toContain("Frédéric Savart Haute Couture");
    expect(names).toContain("Frédéric Savart L'Ouverture");
    expect(names).not.toContain("Koonunga Hill Shiraz Cabernet");
  });

  it("folds accents away: 'bereche' finds Bérêche & Fils", async () => {
    const names = await fuzzy(ownerClient, restaurantId, "bereche");
    expect(names).toContain("Bérêche & Fils Le Cran");
    expect(names).not.toContain("Koonunga Hill Shiraz Cabernet");
  });

  it("matches a multi-word appellation: 'vosne romanee' finds Vosne-Romanée", async () => {
    const names = await fuzzy(ownerClient, restaurantId, "vosne romanee");
    expect(names).toContain("Benjamin Leroux Vosne-Romanée");
  });

  it("matches on `name` alone, with the producer column empty", async () => {
    // Every fixture above stores "" in producer. Asserted explicitly so a
    // future change that starts matching `producer` only fails here loudly
    // rather than quietly halving the corpus it can see.
    const { data } = await admin
      .from("wines")
      .select("producer")
      .eq("restaurant_id", restaurantId)
      .eq("name", "Frédéric Savart Haute Couture")
      .single();
    expect(data?.producer).toBe("");
    expect(await fuzzy(ownerClient, restaurantId, "savart")).toContain(
      "Frédéric Savart Haute Couture",
    );
  });

  it("THE THRESHOLD IS LOAD-BEARING: 'fredric' matches at 0.5 and not at pg_trgm's 0.6 default", async () => {
    expect(await fuzzy(ownerClient, restaurantId, "fredric", 0.5)).toContain(
      "Frédéric Savart Haute Couture",
    );
    expect(await fuzzy(ownerClient, restaurantId, "fredric", 0.6)).toEqual([]);
  });

  it("scores a row as the MAX over tokens, so one misspelt token cannot exclude it", async () => {
    // "fredric" alone scores 0.545455 against this row while "savart" scores
    // 1.0. Under a whole-string or minimum-over-tokens rule the misspelt token
    // would drag the row under the bar; under MAX it does not.
    const names = await fuzzy(ownerClient, restaurantId, "Fredric savart");
    expect(names).toContain("Frédéric Savart Haute Couture");
  });

  it("TENANCY: a member of another restaurant passing this restaurant's id gets nothing", async () => {
    // The RPC is SECURITY INVOKER, so `wines` RLS applies to the real calling
    // role. p_restaurant_id is caller-supplied over PostgREST, so this is the
    // assertion that matters most in the whole suite: forging it must not
    // return another tenant's cellar.
    expect(await fuzzy(outsiderClient, restaurantId, "savart")).toEqual([]);

    // Control: the same session, the same query, its OWN restaurant — proving
    // the empty result above is containment and not a broken call.
    expect(await fuzzy(outsiderClient, otherRestaurantId, "savart")).toContain(
      "Frédéric Savart Bulles de Rosé",
    );

    // And the reverse direction: this tenant never sees the outsider's wine.
    expect(await fuzzy(ownerClient, restaurantId, "savart")).not.toContain(
      "Frédéric Savart Bulles de Rosé",
    );
  });
});
