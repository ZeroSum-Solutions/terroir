import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAuthContext } from "@/lib/auth-context";
import {
  fetchVintageRatings,
  resolveXWinesProfile,
} from "@/lib/wine-intelligence/xwines-profile";
import { WineDetailView } from "./wine-detail-view";

export const metadata: Metadata = { title: "Wine" };

type Params = Promise<{ wineId: string }>;

// A detail page asks a narrow question, so it runs its own narrow query rather
// than reusing /cellar's fan-out, which pages the WHOLE restaurant's wines and
// inventory to build one list. Reusing that here would fetch thousands of rows
// to render one.
// One string literal, deliberately: supabase-js infers the row type from the
// literal, and a concatenated const degrades it to GenericStringError.
const WINE_COLUMNS =
  "id, name, producer, vintage, varietal, region, country, size_ml, colour, hero_image_url, tasting_notes, is_eightysixed, eightysixed_at, drink_window_start, drink_window_end, peak_year, serving_temp_min, serving_temp_max, serving_temp_label, decant_minutes, retail_min, retail_max, retail_median, retail_retailer_count, rating, rating_source, review_excerpt, canonical_wine_id" as const;

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
  const { data: wine } = await supabase
    .from("wines")
    .select(WINE_COLUMNS)
    .eq("id", wineId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (!wine) notFound();

  const [{ data: inventory }, profile] = await Promise.all([
    supabase
      .from("inventory_items")
      .select("quantity, bin_location, section")
      .eq("wine_id", wineId)
      .eq("restaurant_id", restaurantId),
    resolveXWinesProfile({
      supabase,
      canonicalWineId: wine.canonical_wine_id,
      producer: wine.producer,
      name: wine.name,
    }),
  ]);

  // Only reached when a profile exists, so an unmatched wine costs one query,
  // not two.
  const vintageRatings = profile
    ? await fetchVintageRatings(supabase, profile.wineId)
    : [];

  const bottleCount = (inventory ?? []).reduce(
    (total, item) => total + (item.quantity ?? 0),
    0,
  );
  const locations = [
    ...new Set(
      (inventory ?? [])
        .map((item) => item.bin_location ?? item.section)
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  return (
    <WineDetailView
      wine={wine}
      bottleCount={bottleCount}
      locations={locations}
      profile={profile}
      vintageRatings={vintageRatings}
    />
  );
}
