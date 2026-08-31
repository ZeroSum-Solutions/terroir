import { notFound } from "next/navigation";
import { WineThumb } from "@/components/wine-thumb";
import type { Metadata } from "next";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { renderWineListSections, wineListItemLabel, type EightysixStrategy } from "@/lib/wine-list/render";
import type { WineListSectionEmbed } from "@/lib/wine-list/shapes";
import {
  getSupabasePublicConfig,
  isProductionRuntime,
  requireSupabasePublicConfig,
} from "@/lib/supabase/config";
import { cn } from "@/lib/utils";
import { parseRenderableTheme, themeCssVariables } from "@/lib/branding/theme";
import {
  buildBinCodesByWine,
  type PublicBinCodeRow,
} from "./public-bin-codes";
import { formatMenuFreshness, newestValidTimestamp } from "./menu-freshness";
import { PublicMenuShare } from "./public-menu-share";

/** Anon client for public pages — respects RLS, no auth session needed. */
function createAnonClient() {
  const config = isProductionRuntime()
    ? requireSupabasePublicConfig()
    : getSupabasePublicConfig();

  if (!config) return null;

  return createSupabaseClient<Database>(
    config.url,
    config.publishableKey,
  );
}

async function fetchPublicBinCodes(restaurantId: string, wineIds: string[]) {
  const config = getSupabasePublicConfig();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (wineIds.length === 0) return {};
  if (!config || !serviceRoleKey) {
    console.error("public bin-code lookup is not configured");
    return {};
  }

  const admin = createSupabaseClient<Database>(config.url, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await admin
    .from("inventory_items")
    .select("wine_id, bins!inner(code, restaurant_id)")
    .eq("restaurant_id", restaurantId)
    .eq("bins.restaurant_id", restaurantId)
    .in("wine_id", wineIds)
    .not("bin_id", "is", null)
    .is("bins.retired_at", null);

  if (error) {
    console.error("public bin-code lookup failed");
    return {};
  }
  return buildBinCodesByWine((data ?? []) as unknown as PublicBinCodeRow[]);
}

export const revalidate = 3600; // ISR: revalidate every hour

type Params = Promise<{ slug: string }>;

/**
 * Per-list metadata so shared links (QR codes, SMS, social) show the
 * list name in the browser tab and OG previews instead of the root
 * "Terroir" default. Falls back gracefully when the slug is missing
 * or the list is unpublished — generateMetadata must never throw.
 */
export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!slug || slug.length < 3) return { title: "Wine List" };

  const supabase = createAnonClient();
  if (!supabase) return { title: "Wine List" };

  const { data: list } = await supabase
    .from("wine_lists")
    .select("name, restaurants(name)")
    .eq("slug", slug)
    .eq("is_published", true)
    .single();

  if (!list) return { title: "Wine List" };

  const restaurantName =
    (list.restaurants as { name: string } | null)?.name ?? "";
  const title = restaurantName
    ? `${list.name} · ${restaurantName}`
    : list.name;
  const description = restaurantName
    ? `The current wine list at ${restaurantName}.`
    : "A wine list powered by Terroir.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      siteName: restaurantName || "Terroir",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

export default async function PublicWineListPage({
  params,
}: {
  params: Params;
}) {
  const { slug } = await params;
  if (!slug || slug.length < 3) notFound();

  const supabase = createAnonClient();
  if (!supabase) notFound();

  // wines!wine_list_items_wine_id_fkey: 0080 added a second FK between
  // wine_list_items and wines (the tenant-matching composite FK), so
  // PostgREST needs the relationship named explicitly or embedding fails
  // with PGRST201 ("more than one relationship was found").
  const { data: list, error } = await supabase
    .from("wine_lists")
    .select(
      "name, template, theme, updated_at, restaurant_id, show_bin_codes, restaurants(name, eightysix_strategy, logo_url), wine_list_sections(id, name, position, wine_list_items(id, position, updated_at, glass_price, bottle_price, tasting_note, blurb, hidden, name_override, wines!wine_list_items_wine_id_fkey(id, name, producer, vintage, varietal, region, serving_temp_min, serving_temp_max, serving_temp_label, is_eightysixed, hero_image_url)))",
    )
    .eq("slug", slug)
    .eq("is_published", true)
    .single();

  if (error || !list) notFound();

  const restaurant =
    list.restaurants as { name: string; eightysix_strategy: string; logo_url: string | null } | null;
  const restaurantName = restaurant?.name ?? "";
  const logoUrl = restaurant?.logo_url ?? null;
  const eightysixStrategy: EightysixStrategy =
    restaurant?.eightysix_strategy === "mark" ? "mark" : "hide";

  // Sort sections and items by position
  type PublicWineItem = {
    id: string;
    position: number;
    updated_at: string;
    glass_price: number | null;
    bottle_price: number | null;
    tasting_note: string | null;
    name_override: string | null;
    blurb: string | null;
    hidden: boolean;
    wines: {
      id: string;
      name: string;
      producer: string;
      vintage: number | null;
      varietal: string | null;
      region: string | null;
      serving_temp_min: number | null;
      serving_temp_max: number | null;
      serving_temp_label: string | null;
      is_eightysixed: boolean;
      hero_image_url: string | null;
    } | null;
  };
  // DEBT-013: shared WineListSectionEmbed<TItem> generic.
  // ARCH-020: shared renderWineListSections() filter + sort pipeline
  // (same rules the PDF route applies). Sections come back already
  // sorted, 86'd wines handled per eightysix_strategy, empty sections dropped.
  // BND-171: exclude hidden items from public view
  const visibleSections = (
    (list.wine_list_sections ?? []) as WineListSectionEmbed<PublicWineItem>[]
  ).map(function (section) {
    return {
      ...section,
      wine_list_items: section.wine_list_items.filter(function (item) {
        return !item.hidden;
      }),
    };
  });
  const sections = renderWineListSections(
    visibleSections as unknown as WineListSectionEmbed<PublicWineItem>[],
    { eightysixStrategy },
  );
  const renderedItemIds = new Set(
    sections.flatMap((section) => section.items.map((item) => item.id)),
  );
  const renderedItemTimestamps = visibleSections.flatMap((section) =>
    section.wine_list_items
      .filter((item) => renderedItemIds.has(item.id))
      .map((item) => item.updated_at),
  );
  const freshestIso = newestValidTimestamp([
    list.updated_at,
    ...renderedItemTimestamps,
  ]);
  const freshnessLabel = freshestIso
    ? formatMenuFreshness(freshestIso)
    : "Updated recently";
  const shareTitle = restaurantName
    ? `${list.name} · ${restaurantName}`
    : list.name;
  const shareText = restaurantName
    ? `View the current wine list at ${restaurantName}.`
    : "View the current wine list.";
  const wineIds = visibleSections.flatMap((section) =>
    section.wine_list_items.flatMap((item) => item.wines?.id ?? []),
  );
  // NOTE: this page is ISR (revalidate above) — when a settings UI for
  // show_bin_codes ships, its mutation must revalidatePath(`/list/${slug}`)
  // so toggling the flag off revokes cached bin codes immediately.
  const binCodesByWine = list.show_bin_codes
    ? await fetchPublicBinCodes(list.restaurant_id, wineIds)
    : {};
  const theme = parseRenderableTheme(list.theme);

  return (
    <main
      className={cn(
        "mx-auto min-h-screen max-w-[720px] bg-surface px-lg py-3xl print:min-h-0 print:max-w-none print:bg-white print:px-0 print:py-0",
        theme && "font-sans text-ink",
      )}
      style={themeCssVariables(theme)}
    >
      {/* Header */}
      <header className="mb-2xl border-b border-border pb-xl print:mb-lg print:border-black/30 print:pb-md">
        {logoUrl && (
          <div className="mb-md">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={logoUrl}
              alt={restaurantName || "Restaurant logo"}
              width={200}
              height={40}
              className="h-10 w-[200px] max-w-full object-contain print:h-8"
            />
          </div>
        )}
        <div className="flex flex-wrap items-start justify-between gap-md">
          <div className="min-w-0 flex-1">
            <p className="text-caption uppercase text-grey print:text-black">
              {restaurantName}
            </p>
            <h1 className="mt-sm font-serif text-heading-sm text-ink print:text-[24px] print:text-black">
              {list.name}
            </h1>
            <p className="mt-xs text-[12px] text-grey print:text-black">
              {freshnessLabel}
            </p>
          </div>
          <div className="shrink-0 print:hidden">
            <PublicMenuShare title={shareTitle} text={shareText} />
          </div>
        </div>
      </header>

      {/* Empty state — published list with zero visible items (e.g. every
          wine 86'd, or list was published before items were added). Without
          this, the page renders header + footer around a blank middle, which
          reads as broken to a guest. Hidden in print so a paper copy doesn't
          carry a stray "Nothing to pour" line. */}
      {sections.length === 0 && (
        <div className="my-3xl rounded-card border border-dashed border-rule-strong bg-wash px-lg py-2xl text-center print:hidden">
          <p className="font-serif text-[18px] text-ink">
            Nothing to pour right now.
          </p>
          <p className="mt-xs text-[13px] text-grey">
            Availability changes during service; check back soon for the latest list.
          </p>
        </div>
      )}

      {/* Sections */}
      {sections.map((section) => (
        <section
          key={section.id}
          className="mb-2xl print:mb-lg print:break-inside-avoid"
        >
          <h2 className="mb-md flex items-baseline gap-sm font-serif text-[22px] font-medium text-ink print:mb-sm print:text-[18px] print:text-black">
            <span>{section.name}</span>
            {/* Lightweight count so guests can see how deep each category
                is. When strategy is 'mark', this count includes 86'd wines
                (which appear gray/strikethrough). Kept visible in print —
                a paper menu benefits from the same signal. */}
            <span className="font-mono text-[13px] font-normal text-grey print:text-black">
              {section.items.length}
            </span>
          </h2>
          <div className="flex flex-col">
            {section.items.map((item) => {
                const wine = item.wines;
                const is86d = item.is_marked_eightysixed;
                const binCodes = binCodesByWine[wine.id] ?? [];
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "border-b border-border/50 py-sm last:border-b-0 print:break-inside-avoid print:border-black/20 print:py-2xs",
                      // BND-173: when strategy is 'mark', 86'd wines get muted styling
                      is86d && "opacity-50",
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-md">
                      {/* print:hidden — a guest menu on screen is sold by the
                          bottle; a printed one is set in type, and a page of
                          halftone thumbnails is not what a restaurant prints. */}
                      <WineThumb
                        src={wine.hero_image_url}
                        producer={wine.producer}
                        name={wine.name}
                        colour={null}
                        size={44}
                        className="self-start print:hidden"
                      />
                      <div className="min-w-0 flex-1">
                        <span
                          className={cn(
                            "font-serif text-[17px] font-medium text-ink print:text-black",
                            is86d && "line-through",
                          )}
                        >
                          {wineListItemLabel(item)}
                        </span>
                        {is86d && (
                          <span className="ml-xs font-mono text-[11px] uppercase text-grey print:hidden">
                            Unavailable
                          </span>
                        )}
                        {wine.vintage && (
                          <span className={cn(
                            "ml-xs font-mono text-[12px] text-grey print:text-black",
                            is86d && "line-through",
                          )}>
                            {wine.vintage}
                          </span>
                        )}
                        {binCodes.length > 0 && (
                          <span className="ml-xs font-mono text-[11px] text-grey print:text-black">
                            {binCodes.length === 1 ? "Bin" : "Bins"} {binCodes.join(", ")}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-baseline gap-md font-mono text-[14px]">
                        {item.glass_price != null && (
                          <span className={cn(
                            "text-grey print:text-black",
                            is86d && "line-through",
                          )}>
                            Glass ${item.glass_price}
                          </span>
                        )}
                        {item.bottle_price != null && (
                          <span className={cn(
                            "text-ink print:text-black",
                            is86d && "line-through",
                          )}>
                            Bottle ${item.bottle_price}
                          </span>
                        )}
                      </div>
                    </div>
                    {(wine.region || wine.serving_temp_label) && (
                      <p className={cn(
                        "mt-2xs text-[12px] text-grey print:text-black",
                        is86d && "line-through",
                      )}>
                        {wine.region}
                        {wine.varietal && ` · ${wine.varietal}`}
                        {wine.serving_temp_label && wine.serving_temp_min != null && wine.serving_temp_max != null && (
                          <span className="text-grey print:text-black">
                            {wine.region ? " · " : ""}{wine.serving_temp_min}–{wine.serving_temp_max}°F
                          </span>
                        )}
                      </p>
                    )}
                    {item.tasting_note && (
                      <p className={cn(
                        "mt-xs font-sans text-[13px] italic text-grey print:text-black",
                        is86d && "line-through",
                      )}>
                        {item.tasting_note}
                      </p>
                    )}
                    {/* BND-170: blurb renders under wine on public list */}
                    {item.blurb && (
                      <p className={cn(
                        "mt-xs text-[13px] text-grey leading-relaxed print:text-black",
                        is86d && "line-through",
                      )}>
                        {item.blurb}
                      </p>
                    )}
                  </div>
                );
              })}
          </div>
        </section>
      ))}

      {/* Footer — hidden when printing so the menu doesn't carry a
          "Powered by Terroir" line on a paper copy. */}
      <footer className="mt-3xl border-t border-rule pt-lg text-center print:hidden">
        <p className="text-caption font-medium uppercase text-grey">
          Powered by Terroir
        </p>
      </footer>
    </main>
  );
}
