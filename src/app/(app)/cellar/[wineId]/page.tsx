import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAuthContext } from "@/lib/auth-context";
import {
  fetchVintageRatings,
  type CorpusRead,
  type VintageRating,
} from "@/lib/wine-intelligence/xwines-profile";
import { resolveWineCorpusProfile } from "@/lib/wine-intelligence/wine-corpus-profile";
import {
  fetchLwinReference,
  resolveWineFacts,
} from "@/lib/wine-intelligence/wine-reference-facts";
import { NotesSection } from "@/domains/notes/notes-section";
import { composeBadges, resolveCellarContext } from "@/domains/wine-profile/resolve-cellar-context";
import { resolveHouseProfile } from "@/domains/wine-profile/resolve-house-profile";
import { resolveReferenceProfile } from "@/domains/wine-profile/resolve-reference-profile";
import { WineDetailView } from "./wine-detail-view";

export const metadata: Metadata = { title: "Wine" };

type Params = Promise<{ wineId: string }>;

// A detail page asks a narrow question, so it runs its own narrow query rather
// than reusing /cellar's fan-out, which pages the WHOLE restaurant's wines and
// inventory to build one list. Reusing that here would fetch thousands of rows
// to render one.
// One string literal, deliberately: supabase-js infers the row type from the
// literal, and a concatenated const degrades it to GenericStringError.
//
// rating, rating_source, review_excerpt and tasting_notes are not read. The
// page renders no number without a basis, and those columns have none (spec
// §4.7); the resolvers below are the only way a value reaches a block.
const WINE_COLUMNS =
  "id, name, producer, vintage, varietal, region, country, size_ml, colour, hero_image_url, is_eightysixed, eightysixed_at, drink_window_start, drink_window_end, drink_window_basis, drink_window_set_by, drink_window_set_at, retail_min, retail_max, retail_median, retail_retailer_count, canonical_wine_id, lwin_id" as const;

// This segment catches every /cellar/<x> that is not a static sibling
// (config, open, reconcile), so `wineId` is whatever was typed. Rejecting a
// non-UUID here keeps a stray URL a clean 404 instead of a Postgres 22P02
// "invalid input syntax for type uuid" on every crawl.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function WineDetailPage({ params }: { params: Params }) {
  const { wineId } = await params;
  if (!UUID.test(wineId)) notFound();
  // AppLayout redirects when the session is null, so reaching here means a
  // membership exists.
  const auth = (await getAuthContext())!;
  const { supabase, restaurantId } = auth;

  // restaurant_id is filtered explicitly as well as by RLS: a detail page keyed
  // on a UUID from the URL is exactly where a tenant-scoping slip would leak a
  // neighbouring restaurant's wine.
  const { data: wine, error: wineError } = await supabase
    .from("wines")
    .select(WINE_COLUMNS)
    .eq("id", wineId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  // A failed query and an absent wine are different facts. maybeSingle() hands
  // back null for both, and calling notFound() on a database outage tells the
  // user their bottle has been deleted. Throw instead and let the route's error
  // boundary say the truthful thing.
  if (wineError) throw wineError;
  if (!wine) notFound();

  // The corpus match is started first and shared: the reference resolver
  // needs it for the structure axes, and the facts and hero need it too.
  const profilePromise = resolveWineCorpusProfile({
    supabase,
    canonicalWineId: wine.canonical_wine_id,
    producer: wine.producer,
    name: wine.name,
  });

  // The three resolvers (spec §4.2) start together. House and cellar go the
  // moment the wine row is known; the reference resolver's own queries start
  // the moment the corpus match returns, which is the earliest they can.
  const [house, cellar, reference, profile, lwin, vocabularyResult] = await Promise.all([
    resolveHouseProfile(supabase, restaurantId, wineId),
    resolveCellarContext(supabase, restaurantId, wineId, wine.size_ml),
    profilePromise.then((read) =>
      resolveReferenceProfile(
        supabase,
        restaurantId,
        {
          canonicalWineId: wine.canonical_wine_id,
          vintage: wine.vintage,
          drinkWindowStart: wine.drink_window_start,
          drinkWindowEnd: wine.drink_window_end,
          drinkWindowBasis: wine.drink_window_basis,
          drinkWindowSetBy: wine.drink_window_set_by,
          drinkWindowSetAt: wine.drink_window_set_at,
        },
        read.status === "ok" ? read.value : null,
      ),
    ),
    profilePromise,
    // Depends only on a column the wine query already returned, so it runs
    // alongside rather than adding a round trip to every wine detail page.
    fetchLwinReference(supabase, wine.lwin_id),
    supabase.from("descriptors").select("slug, label, family").order("sort"),
  ]);

  const facts = resolveWineFacts({
    wine,
    lwin,
    profile: profile.status === "ok" ? profile.value : null,
  });

  // Only reached when a profile exists, so an unmatched wine costs one query,
  // not two.
  const vintageRatings =
    profile.status === "ok" && profile.value !== null
      ? await fetchVintageRatings(supabase, profile.value.wineId, wine.vintage)
      : ({ status: "ok", value: [] } satisfies CorpusRead<VintageRating[]>);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <WineDetailView
      wine={wine}
      bottleCount={cellar.bottleCount}
      locations={cellar.locations}
      facts={facts}
      profile={profile}
      vintageRatings={vintageRatings}
      house={house}
      reference={reference}
      badges={composeBadges(cellar, reference.window, today)}
      currentYear={Number(today.slice(0, 4))}
      notesSlot={
        <NotesSection
          wineId={wine.id}
          vocabulary={vocabularyResult.data ?? []}
          notes={house.notes}
        />
      }
    />
  );
}
