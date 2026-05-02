import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { renderWineListSections } from "@/lib/wine-list/render";
import type { WineListSectionEmbed } from "@/lib/wine-list/shapes";

/** Anon client for public pages — respects RLS, no auth session needed. */
function createAnonClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
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

  const { data: list, error } = await supabase
    .from("wine_lists")
    .select(
      "name, template, restaurant_id, restaurants(name), wine_list_sections(id, name, position, wine_list_items(id, position, glass_price, bottle_price, tasting_note, wines(name, producer, vintage, varietal, region, serving_temp_min, serving_temp_max, serving_temp_label, is_eightysixed)))",
    )
    .eq("slug", slug)
    .eq("is_published", true)
    .single();

  if (error || !list) notFound();

  const restaurantName =
    (list.restaurants as { name: string } | null)?.name ?? "";

  // Sort sections and items by position
  type PublicWineItem = {
    id: string;
    position: number;
    glass_price: number | null;
    bottle_price: number | null;
    tasting_note: string | null;
    wines: {
      name: string;
      producer: string;
      vintage: number | null;
      varietal: string | null;
      region: string | null;
      serving_temp_min: number | null;
      serving_temp_max: number | null;
      serving_temp_label: string | null;
      is_eightysixed: boolean;
    } | null;
  };
  // DEBT-013: shared WineListSectionEmbed<TItem> generic.
  // ARCH-020: shared renderWineListSections() filter + sort pipeline
  // (same rules the PDF route applies). Sections come back already
  // sorted, 86'd wines already filtered out, empty sections dropped.
  const sections = renderWineListSections(
    (list.wine_list_sections ?? []) as unknown as WineListSectionEmbed<PublicWineItem>[],
  );

  return (
    <main className="mx-auto min-h-screen max-w-[720px] bg-surface px-lg py-3xl print:min-h-0 print:max-w-none print:bg-white print:px-0 print:py-0">
      {/* Header */}
      <header className="mb-2xl border-b border-border pb-xl print:mb-lg print:border-black/30 print:pb-md">
        <p className="text-[11px] uppercase tracking-[0.08em] text-ink-subtle print:text-black">
          {restaurantName}
        </p>
        <h1 className="mt-sm font-serif text-[28px] text-ink print:text-[24px] print:text-black">
          {list.name}
        </h1>
      </header>

      {/* Empty state — published list with zero visible items (e.g. every
          wine 86'd, or list was published before items were added). Without
          this, the page renders header + footer around a blank middle, which
          reads as broken to a guest. Hidden in print so a paper copy doesn't
          carry a stray "Nothing to pour" line. */}
      {sections.length === 0 && (
        <div className="my-3xl rounded-md border border-dashed border-border-strong bg-surface-muted px-lg py-2xl text-center print:hidden">
          <p className="font-serif text-[18px] text-ink">
            Nothing to pour right now.
          </p>
          <p className="mt-xs text-[13px] text-ink-muted">
            Check back soon — this list is being updated.
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
                is without scrolling. renderWineListSections filters out 86'd
                wines, so this is the actually-pourable count. Kept visible
                in print — a paper menu benefits from the same signal. */}
            <span className="font-mono text-[13px] font-normal text-ink-muted print:text-black">
              {section.items.length}
            </span>
          </h2>
          <div className="flex flex-col">
            {section.items.map((item) => {
                const wine = item.wines;
                return (
                  <div
                    key={item.id}
                    className="border-b border-border/50 py-sm last:border-b-0 print:break-inside-avoid print:border-black/20 print:py-2xs"
                  >
                    <div className="flex items-baseline justify-between gap-md">
                      <div className="min-w-0">
                        <span className="font-serif text-[15px] text-ink print:text-black">
                          {wine.producer} {wine.name}
                        </span>
                        {wine.vintage && (
                          <span className="ml-xs font-mono text-[12px] text-ink-muted print:text-black">
                            {wine.vintage}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-baseline gap-md font-mono text-[14px]">
                        {item.glass_price != null && (
                          <span className="text-ink-muted print:text-black">
                            ${item.glass_price}
                          </span>
                        )}
                        {item.bottle_price != null && (
                          <span className="text-ink print:text-black">
                            ${item.bottle_price}
                          </span>
                        )}
                      </div>
                    </div>
                    {(wine.region || wine.serving_temp_label) && (
                      <p className="mt-2xs text-[12px] text-ink-muted print:text-black">
                        {wine.region}
                        {wine.varietal && ` · ${wine.varietal}`}
                        {wine.serving_temp_label && wine.serving_temp_min != null && wine.serving_temp_max != null && (
                          <span className="text-ink-subtle print:text-black">
                            {wine.region ? " · " : ""}{wine.serving_temp_min}–{wine.serving_temp_max}°F
                          </span>
                        )}
                      </p>
                    )}
                    {item.tasting_note && (
                      <p className="mt-xs font-serif text-[13px] italic text-ink-muted print:text-black">
                        {item.tasting_note}
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
      <footer className="mt-3xl border-t border-border pt-lg text-center print:hidden">
        <p className="text-[12px] text-ink-subtle">
          Powered by{" "}
          <span className="font-serif font-medium text-accent">Terroir</span>
        </p>
      </footer>
    </main>
  );
}
