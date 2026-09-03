// The note write path — Task 5 of the wine page plan.
//
// Live-DB, because the claims worth testing here are about what lands in the
// database: that only CONFIRMED descriptors are written, and that the
// boundary rejects what the page must never store. A mocked client would let
// every one of these pass while writing nothing at all.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assertLiveDbTargetIsLocal } from "@/test/live-db-target";
import { createNote, CreateNoteSchema } from "./note-service";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasLiveDb = Boolean(supabaseUrl && publishableKey && serviceRoleKey);

if (hasLiveDb) assertLiveDbTargetIsLocal(supabaseUrl!);
if (!hasLiveDb && process.env.CI) {
  throw new Error("MANDATORY live-DB suite: refusing to skip silently in CI.");
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

describe.skipIf(!hasLiveDb)("createNote", { timeout: 60_000 }, () => {
  let admin: SupabaseClient<Database>;
  let client: SupabaseClient<Database>;
  let restaurantId: string;
  let userId: string;
  let wineId: string;

  beforeAll(async () => {
    admin = createClient<Database>(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false } });

    const { data: r, error: rErr } = await admin.from("restaurants")
      .insert({ name: "Note Service" } as never).select("id").single();
    if (rErr || !r) throw rErr ?? new Error("restaurant insert failed");
    restaurantId = (r as { id: string }).id;

    const password = "Note-Service-Test-123!";
    const email = `note-service-${Date.now()}@terroir.test`;
    const { data: user, error: uErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (uErr || !user) throw uErr ?? new Error("user insert failed");
    userId = user.user.id;

    const { error: mErr } = await admin.from("memberships")
      .insert({ user_id: userId, restaurant_id: restaurantId, role: "staff" } as never);
    if (mErr) throw mErr;

    const { data: w, error: wErr } = await admin.from("wines")
      .insert({ restaurant_id: restaurantId, name: "Service Cuvee", producer: "Service Estate", size_ml: 750 } as never)
      .select("id").single();
    if (wErr || !w) throw wErr ?? new Error("wine insert failed");
    wineId = (w as { id: string }).id;

    client = await signedInClient(email, password);
  });

  afterAll(async () => {
    await admin.from("restaurants").delete().eq("id", restaurantId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it("writes the note and returns its id", async () => {
    const { noteId } = await createNote(client, restaurantId, userId, {
      wineId, body: "Tight now, should open up.", score: 90, tastedOn: "2026-09-01", confirmedSlugs: [],
    });
    const { data } = await admin.from("wine_notes").select("body, score, tasted_on").eq("id", noteId).single();
    expect(data).toMatchObject({ body: "Tight now, should open up.", score: 90, tasted_on: "2026-09-01" });
  });

  it("writes confirmed descriptors, and marks them confirmed", async () => {
    const { noteId } = await createNote(client, restaurantId, userId, {
      wineId, body: "Toasty and tight", score: null, tastedOn: null, confirmedSlugs: ["oaky", "toasty"],
    });
    const { data } = await admin.from("wine_note_descriptors")
      .select("descriptor_slug, origin").eq("note_id", noteId).order("descriptor_slug");
    expect(data).toEqual([
      { descriptor_slug: "oaky", origin: "confirmed" },
      { descriptor_slug: "toasty", origin: "confirmed" },
    ]);
  });

  it("never writes an inferred row", async () => {
    // The model's suggestions live in the composer only. An untouched
    // inference is a vote, not a mention, and must never reach a tally.
    const { noteId } = await createNote(client, restaurantId, userId, {
      wineId, body: "Smoke and cassis", score: null, tastedOn: null, confirmedSlugs: ["smoky"],
    });
    const { data } = await admin.from("wine_note_descriptors")
      .select("origin").eq("note_id", noteId).eq("origin", "inferred");
    expect(data).toEqual([]);
  });

  it("deduplicates a slug sent twice rather than failing on the primary key", async () => {
    const { noteId } = await createNote(client, relaxed(restaurantId), userId, {
      wineId, body: "Oak, and more oak", score: null, tastedOn: null, confirmedSlugs: ["oaky", "oaky"],
    });
    const { data } = await admin.from("wine_note_descriptors").select("descriptor_slug").eq("note_id", noteId);
    expect(data).toHaveLength(1);
  });

  it("rejects a blank body", async () => {
    await expect(createNote(client, restaurantId, userId, {
      wineId, body: "   ", score: null, tastedOn: null, confirmedSlugs: [],
    })).rejects.toThrow();
  });

  it("rejects a score outside the 50-100 band", async () => {
    await expect(createNote(client, restaurantId, userId, {
      wineId, body: "fine", score: 12, tastedOn: null, confirmedSlugs: [],
    })).rejects.toThrow();
  });

  it("rejects an unknown descriptor slug", async () => {
    // A model that invents a slug would otherwise violate the foreign key at
    // write time, after the note row already exists.
    await expect(createNote(client, restaurantId, userId, {
      wineId, body: "fine", score: null, tastedOn: null, confirmedSlugs: ["not-a-real-slug"],
    })).rejects.toThrow();
  });

  it("does not leave an orphan note when its descriptors fail", async () => {
    const before = await admin.from("wine_notes").select("id").eq("wine_id", wineId);
    await expect(createNote(client, restaurantId, userId, {
      wineId, body: "will fail on its chips", score: null, tastedOn: null, confirmedSlugs: ["not-a-real-slug"],
    })).rejects.toThrow();
    const after = await admin.from("wine_notes").select("id").eq("wine_id", wineId);
    expect(after.data!.length).toBe(before.data!.length);
  });
});

/** Identity helper, kept so the dedup case reads the same as its neighbours. */
function relaxed(id: string) { return id; }

describe("CreateNoteSchema", () => {
  it("strips a client-supplied author rather than trusting it", () => {
    const parsed = CreateNoteSchema.parse({
      wineId: "00000000-0000-0000-0000-000000000000",
      body: "ok", score: null, tastedOn: null, confirmedSlugs: [],
      authorUserId: "someone-else",
    } as never);
    expect(parsed).not.toHaveProperty("authorUserId");
  });
});
