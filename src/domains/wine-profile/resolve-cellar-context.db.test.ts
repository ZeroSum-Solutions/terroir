// What the cellar resolver's QUERIES return against a real database.
//
// The derivations are tested purely in resolve-cellar-context.test.ts. This
// suite covers what a mock cannot: that the list read's embedded join
// (wine_list_items → wine_list_sections → wine_lists) actually resolves in
// PostgREST, that the pour read's kind filter is applied in SQL, and that the
// dead-stock threshold comes from this restaurant's config.
//
// MANDATORY live-DB suite: a mocked PostgREST would assert my own select
// string back at me, and a wrong embed path returns null silently — which
// derives to "not listed" and raises Off list on every wine on the menu.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assertLiveDbTargetIsLocal } from "@/test/live-db-target";
import { resolveCellarContext } from "./resolve-cellar-context";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasLiveDb = Boolean(supabaseUrl && serviceRoleKey);

if (hasLiveDb) assertLiveDbTargetIsLocal(supabaseUrl!);
if (!hasLiveDb && process.env.CI) {
  throw new Error(
    "MANDATORY live-DB suite: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in CI - refusing to skip silently.",
  );
}

describe.skipIf(!hasLiveDb)("resolveCellarContext against a real database", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let restaurantId: string;
  let wineId: string;
  let bareWineId: string;

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, {
      auth: { persistSession: false },
    });

    const { data: restaurant, error: rErr } = await admin
      .from("restaurants")
      .insert({ name: "Cellar Context Home" } as never)
      .select("id")
      .single();
    if (rErr || !restaurant) throw rErr ?? new Error("failed to insert restaurant");
    restaurantId = (restaurant as { id: string }).id;

    const { error: cErr } = await admin
      .from("cellar_config")
      .insert({ restaurant_id: restaurantId, health_dead_stock_days: 45 } as never);
    if (cErr) throw cErr;

    const { data: wines, error: wErr } = await admin
      .from("wines")
      .insert([
        { restaurant_id: restaurantId, producer: "Context Estate", name: "Listed Cuvee", size_ml: 750 },
        { restaurant_id: restaurantId, producer: "Context Estate", name: "Bare Cuvee", size_ml: 750 },
      ] as never)
      .select("id, name");
    if (wErr || !wines) throw wErr ?? new Error("failed to insert wines");
    const wRows = wines as { id: string; name: string }[];
    wineId = wRows.find((w) => w.name === "Listed Cuvee")!.id;
    bareWineId = wRows.find((w) => w.name === "Bare Cuvee")!.id;

    const { error: iErr } = await admin.from("inventory_items").insert([
      { restaurant_id: restaurantId, wine_id: wineId, quantity: 1, unit_cost: 40, format: null, added_at: "2026-03-01T10:00:00.000Z" },
      { restaurant_id: restaurantId, wine_id: wineId, quantity: 4, unit_cost: 80, format: "magnum", added_at: "2026-06-01T10:00:00.000Z" },
    ] as never);
    if (iErr) throw iErr;

    const { error: pErr } = await admin.from("pour_events").insert([
      // A spill AFTER the last real pour must not read as the last depletion.
      { restaurant_id: restaurantId, wine_id: wineId, kind: "pour", ml_delta: -150, occurred_at: "2026-07-10T20:00:00.000Z" },
      { restaurant_id: restaurantId, wine_id: wineId, kind: "spill", ml_delta: -50, occurred_at: "2026-08-25T20:00:00.000Z" },
    ] as never);
    if (pErr) throw pErr;

    const { data: lists, error: lErr } = await admin
      .from("wine_lists")
      .insert([
        { restaurant_id: restaurantId, name: "Published", is_published: true },
        { restaurant_id: restaurantId, name: "Draft", is_published: false },
      ] as never)
      .select("id, name");
    if (lErr || !lists) throw lErr ?? new Error("failed to insert lists");
    const lRows = lists as { id: string; name: string }[];

    const { data: sections, error: sErr } = await admin
      .from("wine_list_sections")
      .insert(lRows.map((l) => ({ wine_list_id: l.id, name: `${l.name} reds` })) as never)
      .select("id, wine_list_id");
    if (sErr || !sections) throw sErr ?? new Error("failed to insert sections");
    const sRows = sections as { id: string; wine_list_id: string }[];
    const sectionOf = (name: string) =>
      sRows.find((s) => s.wine_list_id === lRows.find((l) => l.name === name)!.id)!.id;

    const { error: liErr } = await admin.from("wine_list_items").insert([
      { restaurant_id: restaurantId, wine_id: wineId, section_id: sectionOf("Published"), bottle_price: 95, hidden: false, is_available: true },
      // Cheaper, but on a list nobody can see. Must not become the price.
      { restaurant_id: restaurantId, wine_id: wineId, section_id: sectionOf("Draft"), bottle_price: 20, hidden: false, is_available: true },
    ] as never);
    if (liErr) throw liErr;
  });

  afterAll(async () => {
    // Everything hangs off the restaurant by cascade.
    await admin.from("restaurants").delete().eq("id", restaurantId);
  });

  it("counts the selling format apart from magnums and weights cost across lots", async () => {
    const facts = await resolveCellarContext(admin, restaurantId, wineId, 750);
    expect(facts.sellingFormatUnits).toBe(1);
    expect(facts.otherFormatUnits).toBe(4);
    expect(facts.weightedUnitCost).toBe(72);
    expect(facts.lastPutAwayAt).toBe("2026-06-01");
  });

  it("reads the published price through the section and list join, ignoring the draft list", async () => {
    const facts = await resolveCellarContext(admin, restaurantId, wineId, 750);
    expect(facts.publishedBottlePrice).toBe(95);
    expect(facts.listedAndOrderable).toBe(true);
  });

  it("takes the last real pour as the depletion, not the later spill", async () => {
    const facts = await resolveCellarContext(admin, restaurantId, wineId, 750);
    expect(facts.lastDepletionAt).toBe("2026-07-10");
  });

  it("reads the dead-stock threshold from this restaurant's config", async () => {
    const facts = await resolveCellarContext(admin, restaurantId, wineId, 750);
    expect(facts.deadStockDays).toBe(45);
  });

  it("reports an unstocked, unlisted wine as exactly that", async () => {
    const facts = await resolveCellarContext(admin, restaurantId, bareWineId, 750);
    expect(facts.bottleCount).toBe(0);
    expect(facts.listedAndOrderable).toBe(false);
    expect(facts.publishedBottlePrice).toBeNull();
    expect(facts.lastDepletionAt).toBeNull();
  });
});
