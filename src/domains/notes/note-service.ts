/**
 * The write path for a house tasting note.
 *
 * One place creates a note. The composer calls it, the API route calls it, and
 * nothing else writes `wine_notes` — two capture paths is how a corpus ends up
 * inconsistent and how a mention count stops meaning anything.
 *
 * Deliberately runs under the CALLER's client, never the service role. There
 * is nothing here a signed-in member is not entitled to do, RLS already
 * enforces tenancy and self-attribution (0148), and a new service-role call
 * site is a review-worthy event rather than a convenience.
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * The boundary schema. `authorUserId` is deliberately absent: attribution
 * comes from the session, and an unknown client field is stripped here rather
 * than being allowed to influence who a note is credited to.
 */
export const CreateNoteSchema = z.object({
  wineId: z.string().uuid(),
  body: z.string().trim().min(1, "A note needs some words."),
  score: z.number().int().min(50).max(100).nullable(),
  tastedOn: z.string().date().nullable(),
  confirmedSlugs: z.array(z.string().min(1)).default([]),
});

export type CreateNoteInput = z.infer<typeof CreateNoteSchema>;

export class NoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteValidationError";
  }
}

export async function createNote(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  authorUserId: string,
  input: CreateNoteInput,
): Promise<{ noteId: string }> {
  const parsed = CreateNoteSchema.safeParse(input);
  if (!parsed.success) {
    throw new NoteValidationError(parsed.error.issues[0]?.message ?? "Invalid note.");
  }
  const { wineId, body, score, tastedOn } = parsed.data;

  // A slug sent twice is a UI slip, not an error worth showing anyone — the
  // composite primary key would otherwise reject the whole write.
  const slugs = [...new Set(parsed.data.confirmedSlugs)];

  // Validate the vocabulary BEFORE writing the note. The foreign key would
  // catch an invented slug, but only after the note row exists, leaving an
  // orphan note whose chips silently vanished.
  if (slugs.length > 0) {
    const { data: known, error: vocabError } = await supabase
      .from("descriptors").select("slug").in("slug", slugs);
    if (vocabError) throw vocabError;
    const unknown = slugs.filter((s) => !known!.some((k) => k.slug === s));
    if (unknown.length > 0) {
      throw new NoteValidationError(`Unknown descriptor: ${unknown.join(", ")}.`);
    }
  }

  const { data: note, error: noteError } = await supabase
    .from("wine_notes")
    .insert({
      restaurant_id: restaurantId,
      wine_id: wineId,
      author_user_id: authorUserId,
      body,
      score,
      tasted_on: tastedOn,
    } as never)
    .select("id")
    .single();
  if (noteError) throw noteError;
  const noteId = (note as { id: string }).id;

  if (slugs.length > 0) {
    const { error: descError } = await supabase
      .from("wine_note_descriptors")
      .insert(slugs.map((slug) => ({
        note_id: noteId,
        descriptor_slug: slug,
        // Always 'confirmed'. The model's suggestions live in the composer and
        // are promoted by a human tap; an untouched inference is a vote, not a
        // mention, and this path is the only way a descriptor is ever counted.
        origin: "confirmed" as const,
      })) as never);
    if (descError) {
      // Roll the note back by hand: Postgres has no transaction across two
      // PostgREST calls, and a note whose chips failed is worse than no note —
      // the author believes they tagged it.
      await supabase.from("wine_notes").delete().eq("id", noteId);
      throw descError;
    }
  }

  return { noteId };
}
