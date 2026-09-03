// What the house aggregate is allowed to see — migration 0148, spec §4.2.
//
// The aggregation arithmetic is tested purely in resolve-house-profile.test.ts.
// This suite tests the two things a pure test CANNOT: that the query behind the
// aggregate never counts a model's unconfirmed suggestion, and never counts a
// row belonging to another restaurant.
//
// Both are silent failures if wrong. An inferred descriptor leaking into the
// tally reintroduces exactly the fabricated signal this whole rebuild exists to
// remove (D7/D11), and it looks identical to a real mention on the page. A
// cross-tenant row inflates a count with a stranger's palate, and the number
// still renders perfectly.
//
// MANDATORY live-DB suite: a mocked client would assert my own filter back at
// me. Only a real PostgREST resolving a real embedded join can show what the
// select actually returns.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assertLiveDbTargetIsLocal } from "@/test/live-db-target";
import { resolveHouseProfile } from "./resolve-house-profile";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasLiveDb = Boolean(supabaseUrl && serviceRoleKey);

if (hasLiveDb) assertLiveDbTargetIsLocal(supabaseUrl!);
if (!hasLiveDb && process.env.CI) {
  throw new Error(
    "MANDATORY live-DB suite: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in CI - refusing to skip silently.",
  );
}

describe.skipIf(!hasLiveDb)("resolveHouseProfile against a real database", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let restaurantA: string;
  let restaurantB: string;
  let userAId: string;
  let wineA: string;
  let unscoredWine: string;

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, {
      auth: { persistSession: false },
    });

    const { data: restaurants, error: rErr } = await admin
      .from("restaurants")
      .insert([{ name: "House Aggregate A" }, { name: "House Aggregate B" }] as never)
      .select("id, name");
    if (rErr || !restaurants) throw rErr ?? new Error("failed to insert restaurants");
    const rRows = restaurants as { id: string; name: string }[];
    restaurantA = rRows.find((r) => r.name === "House Aggregate A")!.id;
    restaurantB = rRows.find((r) => r.name === "House Aggregate B")!.id;

    const { data: user, error: uErr } = await admin.auth.admin.createUser({
      email: `house-aggregate-${Date.now()}@terroir.test`,
      password: "House-Aggregate-Test-123!",
      email_confirm: true,
    });
    if (uErr || !user) throw uErr ?? new Error("failed to create user");
    userAId = user.user.id;

    const { error: memErr } = await admin
      .from("memberships")
      .insert({ user_id: userAId, restaurant_id: restaurantA, role: "staff" } as never);
    if (memErr) throw memErr;

    const { data: wines, error: wErr } = await admin
      .from("wines")
      .insert([
        { restaurant_id: restaurantA, name: "Aggregate Cuvee", producer: "House Estate", size_ml: 750 },
        { restaurant_id: restaurantA, name: "Unscored Cuvee", producer: "House Estate", size_ml: 750 },
      ] as never)
      .select("id, name");
    if (wErr || !wines) throw wErr ?? new Error("failed to insert wines");
    const wRows = wines as { id: string; name: string }[];
    wineA = wRows.find((w) => w.name === "Aggregate Cuvee")!.id;
    unscoredWine = wRows.find((w) => w.name === "Unscored Cuvee")!.id;

    // Three notes on wineA. Two confirm 'oaky'; the third carries 'smoky' as an
    // untouched model suggestion, which must never be counted.
    const { data: notes, error: nErr } = await admin
      .from("wine_notes")
      .insert([
        { restaurant_id: restaurantA, wine_id: wineA, author_user_id: userAId, body: "Oak on the finish.", score: 92 },
        { restaurant_id: restaurantA, wine_id: wineA, author_user_id: userAId, body: "Vanilla and oak.", score: 90 },
        { restaurant_id: restaurantA, wine_id: wineA, author_user_id: userAId, body: "Smoke, maybe.", score: null },
      ] as never)
      .select("id, body");
    if (nErr || !notes) throw nErr ?? new Error("failed to insert notes");
    const nRows = notes as { id: string; body: string }[];

    const { error: dErr } = await admin.from("wine_note_descriptors").insert([
      { note_id: nRows.find((n) => n.body === "Oak on the finish.")!.id, descriptor_slug: "oaky", origin: "confirmed" },
      { note_id: nRows.find((n) => n.body === "Vanilla and oak.")!.id, descriptor_slug: "oaky", origin: "confirmed" },
      { note_id: nRows.find((n) => n.body === "Smoke, maybe.")!.id, descriptor_slug: "smoky", origin: "inferred" },
    ] as never);
    if (dErr) throw dErr;

    // A note from the OTHER restaurant naming this same wine. RLS forbids a
    // tenant from writing this; the service role bypasses RLS, which is exactly
    // how such a row could come to exist — a worker with a scoping slip. The
    // resolver must not count it regardless of how it got there.
    const { error: xErr } = await admin.from("wine_notes").insert({
      restaurant_id: restaurantB,
      wine_id: wineA,
      author_user_id: userAId,
      body: "A stranger's palate.",
      score: 50,
    } as never);
    if (xErr) throw xErr;

    // Two notes carrying no score at all, to prove a mean over nothing is null.
    const { error: uwErr } = await admin.from("wine_notes").insert([
      { restaurant_id: restaurantA, wine_id: unscoredWine, author_user_id: userAId, body: "No number from me." },
      { restaurant_id: restaurantA, wine_id: unscoredWine, author_user_id: userAId, body: "Nor me." },
    ] as never);
    if (uwErr) throw uwErr;
  });

  afterAll(async () => {
    await admin.from("restaurants").delete().in("id", [restaurantA, restaurantB]);
    if (userAId) await admin.auth.admin.deleteUser(userAId);
  });

  it("counts the confirmed descriptor and never the inferred one", async () => {
    const { taste } = await resolveHouseProfile(admin, restaurantA, wineA);

    expect(taste.value.descriptors).toEqual([
      { slug: "oaky", label: "Oaky", family: "oak", notes: 2 },
    ]);
    expect(taste.value.descriptors.some((d) => d.slug === "smoky")).toBe(false);
  });

  it("counts only this restaurant's notes in the corpus and the basis", async () => {
    const { taste } = await resolveHouseProfile(admin, restaurantA, wineA);

    // Four rows name this wine. One belongs to restaurant B.
    expect(taste.value.corpusSize).toBe(3);
    expect(taste.basis).toEqual({ kind: "house", notes: 3 });
  });

  it("keeps the stranger's score out of the house mean", async () => {
    const { score } = await resolveHouseProfile(admin, restaurantA, wineA);

    // 92 and 90 from this house; the 50 from restaurant B would drag it to 77.3.
    expect(score!.value).toEqual({ n: 91, scale: 100 });
    expect(score!.basis).toEqual({ kind: "house", notes: 2 });
  });

  it("returns a null score, and no NaN anywhere, when nobody scored the wine", async () => {
    const result = await resolveHouseProfile(admin, restaurantA, unscoredWine);

    expect(result.score).toBeNull();
    expect(result.taste.value.corpusSize).toBe(2);
    expect(JSON.stringify(result)).not.toContain("NaN");
  });

  it("returns the notes it aggregated, so the page reads wine_notes once", async () => {
    const { notes, taste } = await resolveHouseProfile(admin, restaurantA, wineA);

    expect(notes).toHaveLength(taste.value.corpusSize);
    expect(notes.map((n) => n.body)).not.toContain("A stranger's palate.");
  });
});
