import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { createNote, NoteValidationError } from "@/domains/notes/note-service";

export const runtime = "nodejs";

/**
 * The wine is taken from the path, not the body, so a note can only ever be
 * filed against the wine whose page the author is looking at.
 */
const BodySchema = z.object({
  body: z.string().trim().min(1, "A note needs some words."),
  score: z.number().int().min(50).max(100).nullable().default(null),
  tastedOn: z.string().date().nullable().default(null),
  confirmedSlugs: z.array(z.string().min(1)).default([]),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/wines/:id/notes
 *
 * Attribution always comes from the authenticated session. The RLS policy on
 * wine_notes enforces the same thing independently (0148), so a client that
 * tried to author a note as somebody else would be rejected twice.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const { id } = await params;
    if (!UUID.test(id)) return Errors.notFound("Wine");

    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;

    const parsed = await parseJson(request, BodySchema, { message: "Invalid note." });
    if (!parsed.ok) return parsed.response;

    // Confirm the wine belongs to this tenant before writing. RLS would also
    // refuse, but a 404 is the honest answer to "a wine you cannot see" and
    // an RLS rejection would surface as a 500.
    const { data: wine, error: wineError } = await auth.supabase
      .from("wines")
      .select("id")
      .eq("id", id)
      .eq("restaurant_id", auth.restaurantId)
      .maybeSingle();
    if (wineError) throw wineError;
    if (!wine) return Errors.notFound("Wine");

    try {
      const { noteId } = await createNote(auth.supabase, auth.restaurantId, auth.user.id, {
        wineId: id,
        body: parsed.data.body,
        score: parsed.data.score,
        tastedOn: parsed.data.tastedOn,
        confirmedSlugs: parsed.data.confirmedSlugs,
      });
      return NextResponse.json({ noteId }, { status: 201 });
    } catch (error) {
      if (error instanceof NoteValidationError) {
        return Errors.unprocessable("invalid_note", error.message);
      }
      throw error;
    }
  });
}
