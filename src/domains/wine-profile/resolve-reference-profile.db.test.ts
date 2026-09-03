// What the reference resolver's QUERIES are allowed to return — spec §4.2, D12.
//
// The selection rules are tested purely in resolve-reference-profile.test.ts.
// This suite tests what a pure test cannot: that the SQL itself is scoped to
// the wine's own canonical identity and vintage, and that an override author is
// named only when that person is on this restaurant's roster.
//
// Both failures are silent and both produce a SOURCED lie — a real url and a
// real fetch date printed beside a number that belongs to a different bottle,
// or a stranger's name on this house's decision.
//
// MANDATORY live-DB suite: a mocked PostgREST would assert my own filter back
// at me.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assertLiveDbTargetIsLocal } from "@/test/live-db-target";
import { resolveReferenceProfile, type ReferenceWine } from "./resolve-reference-profile";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasLiveDb = Boolean(supabaseUrl && serviceRoleKey);

if (hasLiveDb) assertLiveDbTargetIsLocal(supabaseUrl!);
if (!hasLiveDb && process.env.CI) {
  throw new Error(
    "MANDATORY live-DB suite: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in CI - refusing to skip silently.",
  );
}

describe.skipIf(!hasLiveDb)("resolveReferenceProfile against a real database", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let restaurantId: string;
  let outsiderRestaurantId: string;
  let memberId: string;
  let outsiderId: string;
  let canonicalId: string;
  let otherCanonicalId: string;

  const wine = (overrides: Partial<ReferenceWine> = {}): ReferenceWine => ({
    canonicalWineId: canonicalId,
    vintage: 2019,
    drinkWindowStart: null,
    drinkWindowEnd: null,
    drinkWindowBasis: null,
    drinkWindowSetBy: null,
    drinkWindowSetAt: null,
    ...overrides,
  });

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, {
      auth: { persistSession: false },
    });

    const { data: restaurants, error: rErr } = await admin
      .from("restaurants")
      .insert([{ name: "Reference Home" }, { name: "Reference Outsider" }] as never)
      .select("id, name");
    if (rErr || !restaurants) throw rErr ?? new Error("failed to insert restaurants");
    const rRows = restaurants as { id: string; name: string }[];
    restaurantId = rRows.find((r) => r.name === "Reference Home")!.id;
    outsiderRestaurantId = rRows.find((r) => r.name === "Reference Outsider")!.id;

    const run = Date.now();
    const { data: member, error: mErr } = await admin.auth.admin.createUser({
      email: `reference-member-${run}@terroir.test`,
      password: "Reference-Test-123!",
      email_confirm: true,
      user_metadata: { full_name: "Devin" },
    });
    if (mErr || !member) throw mErr ?? new Error("failed to create member");
    memberId = member.user.id;

    const { data: outsider, error: oErr } = await admin.auth.admin.createUser({
      email: `reference-outsider-${run}@terroir.test`,
      password: "Reference-Test-123!",
      email_confirm: true,
      user_metadata: { full_name: "Stranger" },
    });
    if (oErr || !outsider) throw oErr ?? new Error("failed to create outsider");
    outsiderId = outsider.user.id;

    const { error: memErr } = await admin.from("memberships").insert([
      { user_id: memberId, restaurant_id: restaurantId, role: "owner" },
      { user_id: outsiderId, restaurant_id: outsiderRestaurantId, role: "owner" },
    ] as never);
    if (memErr) throw memErr;

    const { data: canonicals, error: cErr } = await admin
      .from("canonical_wines")
      .insert([
        { producer: "Reference Estate", cuvee: "Target Cuvee" },
        { producer: "Reference Estate", cuvee: "Neighbour Cuvee" },
      ] as never)
      .select("id, cuvee");
    if (cErr || !canonicals) throw cErr ?? new Error("failed to insert canonical wines");
    const cRows = canonicals as { id: string; cuvee: string }[];
    canonicalId = cRows.find((c) => c.cuvee === "Target Cuvee")!.id;
    otherCanonicalId = cRows.find((c) => c.cuvee === "Neighbour Cuvee")!.id;

    const { error: refErr } = await admin.from("wine_reference_notes").insert([
      {
        canonical_wine_id: canonicalId,
        vintage: 2019,
        source_kind: "producer",
        source_name: "Reference Estate Sheet",
        source_url: "https://example.test/2019.pdf",
        fetched_at: "2026-08-14T00:00:00.000Z",
        body: "The 2019, tight now.",
        score: 93,
        score_scale: 100,
        drink_window_start: 2023,
        drink_window_end: 2033,
      },
      // Same wine, WRONG vintage. Must never surface against a 2019 bottle.
      {
        canonical_wine_id: canonicalId,
        vintage: 2015,
        source_kind: "retailer",
        source_name: "A Shop",
        source_url: "https://example.test/2015",
        fetched_at: "2026-08-14T00:00:00.000Z",
        body: "The 2015, drinking now.",
        score: 88,
        score_scale: 100,
        drink_window_start: 2017,
        drink_window_end: 2024,
      },
      // Right vintage, WRONG wine.
      {
        canonical_wine_id: otherCanonicalId,
        vintage: 2019,
        source_kind: "retailer",
        source_name: "Another Shop",
        source_url: "https://example.test/neighbour",
        fetched_at: "2026-08-14T00:00:00.000Z",
        body: "A different cuvee entirely.",
        score: 99,
        score_scale: 100,
        drink_window_start: 2020,
        drink_window_end: 2040,
      },
    ] as never);
    if (refErr) throw refErr;
  });

  afterAll(async () => {
    await admin
      .from("wine_reference_notes")
      .delete()
      .in("canonical_wine_id", [canonicalId, otherCanonicalId]);
    await admin.from("canonical_wines").delete().in("id", [canonicalId, otherCanonicalId]);
    await admin.from("restaurants").delete().in("id", [restaurantId, outsiderRestaurantId]);
    if (memberId) await admin.auth.admin.deleteUser(memberId);
    if (outsiderId) await admin.auth.admin.deleteUser(outsiderId);
  });

  it("reads only this wine's own vintage", async () => {
    const result = await resolveReferenceProfile(admin, restaurantId, wine(), null);

    expect(result.notes.map((n) => n.value)).toEqual(["The 2019, tight now."]);
    expect(result.score!.value).toEqual({ n: 93, scale: 100 });
    expect(result.window!.value).toEqual({ start: 2023, end: 2033 });
    expect(result.window!.basis).toMatchObject({
      kind: "sourced",
      url: "https://example.test/2019.pdf",
    });
  });

  it("reads nothing for a vintage nobody published on", async () => {
    const result = await resolveReferenceProfile(admin, restaurantId, wine({ vintage: 2021 }), null);

    expect(result.notes).toEqual([]);
    expect(result.score).toBeNull();
    expect(result.window).toBeNull();
  });

  it("reads nothing at all for a wine with no canonical identity", async () => {
    const result = await resolveReferenceProfile(
      admin,
      restaurantId,
      wine({ canonicalWineId: null }),
      null,
    );

    expect(result.notes).toEqual([]);
    expect(result.score).toBeNull();
  });

  it("names the override's author when they are on this roster", async () => {
    const result = await resolveReferenceProfile(
      admin,
      restaurantId,
      wine({
        drinkWindowStart: 2025,
        drinkWindowEnd: 2035,
        drinkWindowBasis: "override",
        drinkWindowSetBy: memberId,
        drinkWindowSetAt: "2026-08-20T00:00:00.000Z",
      }),
      null,
    );

    expect(result.window!.value).toEqual({ start: 2025, end: 2035 });
    expect(result.window!.basis).toEqual({
      kind: "override",
      by: "Devin",
      at: "2026-08-20T00:00:00.000Z",
    });
  });

  it("refuses to name someone outside this restaurant", async () => {
    // The gate is the roster, not the existence of the user. Printing
    // "Stranger" here would attribute this house's decision to a person who
    // has never worked here, and leak that they exist.
    const result = await resolveReferenceProfile(
      admin,
      restaurantId,
      wine({
        drinkWindowStart: 2025,
        drinkWindowEnd: 2035,
        drinkWindowBasis: "override",
        drinkWindowSetBy: outsiderId,
        drinkWindowSetAt: "2026-08-20T00:00:00.000Z",
      }),
      null,
    );

    expect(result.window!.basis).toMatchObject({ kind: "override", by: "someone here" });
    expect(JSON.stringify(result)).not.toContain("Stranger");
  });

  it("still prefers the house override over the producer's own window", async () => {
    const result = await resolveReferenceProfile(
      admin,
      restaurantId,
      wine({
        drinkWindowStart: 2025,
        drinkWindowEnd: 2035,
        drinkWindowBasis: "override",
        drinkWindowSetBy: memberId,
        drinkWindowSetAt: "2026-08-20T00:00:00.000Z",
      }),
      null,
    );

    // The producer sheet says 2023–2033 and is present in this result's notes.
    expect(result.notes).toHaveLength(1);
    expect(result.window!.value).toEqual({ start: 2025, end: 2035 });
  });
});
