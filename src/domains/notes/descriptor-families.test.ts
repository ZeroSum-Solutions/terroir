// The seeded vocabulary and the UI's family list must not drift apart: a
// descriptor whose family the composer does not know about renders in no group
// at all, and simply vanishes from the chip picker.
//
// Live-DB, because the claim is about what is actually in the table.
import { describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assertLiveDbTargetIsLocal } from "@/test/live-db-target";
import { DESCRIPTOR_FAMILIES, isDescriptorFamily } from "./descriptor-families";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasLiveDb = Boolean(supabaseUrl && serviceRoleKey);

if (hasLiveDb) assertLiveDbTargetIsLocal(supabaseUrl!);
if (!hasLiveDb && process.env.CI) {
  throw new Error("MANDATORY live-DB suite: refusing to skip silently in CI.");
}

describe.skipIf(!hasLiveDb)("seeded descriptor vocabulary", { timeout: 30_000 }, () => {
  let admin: SupabaseClient<Database>;
  const load = async () => {
    admin ??= createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });
    const { data, error } = await admin.from("descriptors").select("slug, label, family, sort");
    if (error) throw error;
    return data!;
  };

  it("seeds a vocabulary at all", async () => {
    expect((await load()).length).toBeGreaterThan(0);
  });

  it("gives every descriptor a family the UI knows how to group", async () => {
    const unknown = (await load()).filter((d) => !isDescriptorFamily(d.family));
    expect(unknown.map((d) => `${d.slug} -> ${d.family}`)).toEqual([]);
  });

  it("uses every family it declares, so the list carries no dead groups", async () => {
    const used = new Set((await load()).map((d) => d.family));
    expect(DESCRIPTOR_FAMILIES.filter((f) => !used.has(f))).toEqual([]);
  });

  it("has a distinct label for every slug", async () => {
    const rows = await load();
    expect(new Set(rows.map((r) => r.label)).size).toBe(rows.length);
  });

  it("orders every descriptor deterministically", async () => {
    const rows = await load();
    expect(new Set(rows.map((r) => r.sort)).size).toBe(rows.length);
  });
});
