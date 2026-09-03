import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { suggestDescriptors } from "@/domains/notes/descriptor-extraction";

export const runtime = "nodejs";

const BodySchema = z.object({ body: z.string().trim().min(1).max(4000) });

/**
 * POST /api/wines/:id/notes/suggest
 *
 * Returns slugs for the composer to pre-tick. Writes nothing: a suggestion
 * becomes a stored descriptor only when the author taps to confirm it and the
 * note itself is saved.
 *
 * Never fails the caller. An empty list is the correct answer whenever the
 * model is unavailable, because the composer must still be able to save.
 */
export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;

    const parsed = await parseJson(request, BodySchema, { message: "Invalid body." });
    if (!parsed.ok) return parsed.response;

    const { data: vocabulary } = await auth.supabase
      .from("descriptors")
      .select("slug, label");

    const slugs = await suggestDescriptors(parsed.data.body, vocabulary ?? []);
    return NextResponse.json({ slugs });
  });
}
