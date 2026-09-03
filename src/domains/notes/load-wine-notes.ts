/**
 * Reads the house's notes on one wine, with their authors resolved.
 *
 * Author names come from resolveRestaurantMemberNames, which holds the single
 * membership gate in front of the service role (AGENTS.md non-negotiable #3).
 * A note whose author has since left the restaurant resolves to the honest
 * fallback rather than reaching outside that roster.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { resolveRestaurantMemberNames } from "@/lib/team/restaurant-member-names";
import type { HouseNote } from "./note-list";

export async function loadWineNotes(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  wineId: string,
): Promise<HouseNote[]> {
  const { data: notes, error } = await supabase
    .from("wine_notes")
    .select("id, body, score, tasted_on, created_at, author_user_id, wine_note_descriptors(descriptor_slug, origin, descriptors(label, family))")
    .eq("wine_id", wineId)
    .eq("restaurant_id", restaurantId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (!notes || notes.length === 0) return [];

  const names = await resolveRestaurantMemberNames(
    supabase,
    restaurantId,
    notes.map((note) => note.author_user_id).filter((id): id is string => id !== null),
  );

  return notes.map((note) => ({
    id: note.id,
    body: note.body,
    score: note.score,
    tastedOn: note.tasted_on,
    createdAt: note.created_at,
    // A null author is a legacy note seeded from wines.tasting_notes, which
    // recorded none. That is different from a colleague we cannot name.
    attributed: note.author_user_id !== null,
    authorName: note.author_user_id === null ? null : (names.get(note.author_user_id) ?? null),
    // Only confirmed descriptors are ever shown or counted. An untouched
    // model inference is a vote, not a mention.
    descriptors: (note.wine_note_descriptors ?? [])
      .filter((d) => d.origin === "confirmed")
      .map((d) => ({
        slug: d.descriptor_slug,
        label: d.descriptors?.label ?? d.descriptor_slug,
        // Carried for the aggregate, which groups chips by family. The note
        // list ignores it: a family labels a group, it never tints a chip
        // (D10).
        family: d.descriptors?.family ?? "",
      })),
  }));
}
