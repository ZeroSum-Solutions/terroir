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
    <main className="mx-auto min-h-screen max-w-[720px] bg-surface px-lg py-3xl">
      {/* Header */}
      <header className="mb-2xl border-b border-border pb-xl">
        <p className="text-[11px] uppercase tracking-[0.08em] text-ink-subtle">
          {restaurantName}
        </p>
        <h1 className="mt-sm font-serif text-[28px] text-ink">{list.name}</h1>
      </header>

      {/* Sections */}
      {sections.map((section) => (
        <section key={section.id} className="mb-2xl">
          <h2 className="mb-md font-serif text-[22px] font-medium text-ink">
            {section.name}
          </h2>
          <div className="flex flex-col">
            {section.items.map((item) => {
                const wine = item.wines;
                return (
                  <div
                    key={item.id}
                    className="border-b border-border/50 py-sm last:border-b-0"
                  >
                    <div className="flex items-baseline justify-between gap-md">
                      <div className="min-w-0">
                        <span className="font-serif text-[15px] text-ink">
                          {wine.producer} {wine.name}
                        </span>
                        {wine.vintage && (
                          <span className="ml-xs font-mono text-[12px] text-ink-muted">
                            {wine.vintage}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-baseline gap-md font-mono text-[14px]">
                        {item.glass_price != null && (
                          <span className="text-ink-muted">
                            ${item.glass_price}
                          </span>
                        )}
                        {item.bottle_price != null && (
                          <span className="text-ink">
                            ${item.bottle_price}
                          </span>
                        )}
                      </div>
                    </div>
                    {(wine.region || wine.serving_temp_label) && (
                      <p className="mt-2xs text-[12px] text-ink-muted">
                        {wine.region}
                        {wine.varietal && ` · ${wine.varietal}`}
                        {wine.serving_temp_label && wine.serving_temp_min != null && wine.serving_temp_max != null && (
                          <span className="text-ink-subtle">
                            {wine.region ? " · " : ""}{wine.serving_temp_min}–{wine.serving_temp_max}°F
                          </span>
                        )}
                      </p>
                    )}
                    {item.tasting_note && (
                      <p className="mt-xs font-serif text-[13px] italic text-ink-muted">
                        {item.tasting_note}
                      </p>
                    )}
                  </div>
                );
              })}
          </div>
        </section>
      ))}

      {/* Footer */}
      <footer className="mt-3xl border-t border-border pt-lg text-center">
        <p className="text-[12px] text-ink-subtle">
          Powered by{" "}
          <span className="font-serif font-medium text-accent">Terroir</span>
        </p>
      </footer>
    </main>
  );
}
