import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseParams } from "@/lib/api/validation";
import { resolveWineCorpusProfile } from "@/lib/wine-intelligence/wine-corpus-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;
const ParamsSchema = z.object({ id: z.string().uuid() });

/**
 * GLOBAL-04 — GET /api/wines/[id]/profile
 *
 * The corpus read for ONE wine: its picture, and the reference attributes the
 * detail surfaces show beside it.
 *
 * The cellar list already carries a corpus image for every wine whose identity
 * LINK reaches one, embedded in the query the page was making anyway
 * (corpusImageFromEmbed). This route exists for the wines that link cannot
 * reach — the ones whose producer was never imported, whose picture is only
 * findable by resolving the producer out of their own name and matching. That
 * work is a query or three per wine, which is affordable exactly once, for the
 * wine somebody opened, and not at all for a list of a thousand rows. So the
 * drawer asks here only when it has nothing else to show.
 *
 * `available: false` means the corpus could not be read at all, which is a
 * different sentence for a caller to write than "there is no entry for this
 * wine". Enrichment is decorative, so neither is an error status.
 *
 * Auth: any member of the wine's own restaurant. Tenant scope is asserted with
 * an explicit restaurant_id filter as well as RLS, because a route keyed on a
 * UUID from the URL is exactly where a scoping slip leaks a neighbour's cellar.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseParams(params, ParamsSchema);
    if (!parsed.ok) return parsed.response;
    const { id } = parsed.data;

    const { data: wine, error } = await supabase
      .from("wines")
      .select("id, name, producer, canonical_wine_id")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    // A failed query and an absent wine are different facts, and maybeSingle()
    // returns null for both. Throwing lets withApiHandler answer 500 rather
    // than telling the caller their bottle does not exist.
    if (error) throw error;
    if (!wine) return Errors.notFound("Wine");

    const profile = await resolveWineCorpusProfile({
      supabase,
      canonicalWineId: wine.canonical_wine_id,
      producer: wine.producer,
      name: wine.name,
    });

    if (profile.status === "unavailable") {
      return NextResponse.json({ wineId: id, available: false, profile: null });
    }

    const value = profile.value;
    return NextResponse.json({
      wineId: id,
      available: true,
      profile:
        value === null
          ? null
          : {
              // What was matched, and how sure we are — sent so a caller can
              // show the reader what we read rather than only its conclusions.
              corpusWineId: value.wineId,
              matchedName: value.matchedName,
              matchedWinery: value.matchedWinery,
              provenance: value.provenance,
              matchScore: value.matchScore,
              // The picture. `kind` is load-bearing, not decoration: it is what
              // decides the caption and the alt text (CORPUS_IMAGE_NOTE), and a
              // caller that renders `url` without reading `kind` will present a
              // stranger's bottle as this wine's label.
              image: value.image,
              // Reference attributes. All empty on a producer-only match, which
              // is not confident enough to claim any of them.
              type: value.type,
              grapes: value.grapes,
              pairings: value.pairings,
              abv: value.abv,
              body: value.body,
              acidity: value.acidity,
              regionName: value.regionName,
              country: value.country,
              ratingAvg: value.ratingAvg,
              ratingCount: value.ratingCount,
            },
    });
  });
}
