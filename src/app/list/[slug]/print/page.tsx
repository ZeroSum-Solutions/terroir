import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { renderWineListSections, type EightysixStrategy } from "@/lib/wine-list/render";
import type { WineListSectionEmbed } from "@/lib/wine-list/shapes";
import {
  getSupabasePublicConfig,
  isProductionRuntime,
  requireSupabasePublicConfig,
} from "@/lib/supabase/config";
import { cn } from "@/lib/utils";

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

export const revalidate = 3600; // ISR: revalidate every hour

type Params = Promise<{ slug: string }>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!slug || slug.length < 3) return { title: "Print · Wine List" };

  const supabase = createAnonClient();
  if (!supabase) return { title: "Print · Wine List" };

  const { data: list } = await supabase
    .from("wine_lists")
    .select("name, restaurants(name)")
    .eq("slug", slug)
    .eq("is_published", true)
    .single();

  if (!list) return { title: "Print · Wine List" };

  const restaurantName =
    (list.restaurants as { name: string } | null)?.name ?? "";
  const title = restaurantName
    ? `${list.name} · ${restaurantName} (Print)`
    : `${list.name} (Print)`;

  return {
    title,
    robots: { index: false, follow: false },
  };
}

export default async function PrintWineListPage({
  params,
}: {
  params: Params;
}) {
  const { slug } = await params;
  if (!slug || slug.length < 3) notFound();

  const supabase = createAnonClient();
  if (!supabase) notFound();

  const { data: list, error } = await supabase
    .from("wine_lists")
    .select(
      "name, template, restaurant_id, restaurants(name, eightysix_strategy), wine_list_sections(id, name, position, wine_list_items(id, position, glass_price, bottle_price, tasting_note, blurb, hidden, name_override, wines(name, producer, vintage, varietal, region, serving_temp_min, serving_temp_max, serving_temp_label, is_eightysixed)))",
    )
    .eq("slug", slug)
    .eq("is_published", true)
    .single();

  if (error || !list) notFound();

  const restaurant =
    list.restaurants as { name: string; eightysix_strategy: string } | null;
  const restaurantName = restaurant?.name ?? "";
  const eightysixStrategy: EightysixStrategy =
    restaurant?.eightysix_strategy === "mark" ? "mark" : "hide";

  type PublicWineItem = {
    id: string;
    position: number;
    glass_price: number | null;
    bottle_price: number | null;
    tasting_note: string | null;
    name_override: string | null;
    blurb: string | null;
    hidden: boolean;
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

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{list.name} · Print</title>
        <style>{`
          /* ── Print Stylesheet ── */
          @media print {
            @page {
              margin: 0.75in;
              size: letter;
            }
            body {
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
            .print\\:no-print {
              display: none !important;
            }
            .print\\:break-after-page {
              break-after: page;
            }
          }
        `}</style>
      </head>
      <body className="bg-white text-black font-sans">
        <main className="mx-auto max-w-[800px] px-lg py-2xl">

          {/* No-print notice — shown on screen, hidden when printing */}
          <div className="mb-xl rounded-card border border-hairline bg-bridge-surface px-md py-sm text-center print:no-print">
            <p className="text-[13px] text-ink-muted">
              Print-optimized view. Press{" "}
              <kbd className="rounded-md border border-hairline bg-white px-1.5 py-0.5 text-[11px] font-mono">
                ⌘P
              </kbd>{" "}
              or{" "}
              <kbd className="rounded-md border border-hairline bg-white px-1.5 py-0.5 text-[11px] font-mono">
                Ctrl+P
              </kbd>{" "}
              to print.
            </p>
          </div>

          {/* Header — clean and spacious */}
          <header className="mb-2xl border-b-2 border-black/80 pb-lg">
            {restaurantName && (
              <p className="text-[12px] uppercase tracking-[0.10em] text-gray-500">
                {restaurantName}
              </p>
            )}
            <h1 className="mt-sm font-serif text-[32px] font-medium text-black leading-tight">
              {list.name}
            </h1>
          </header>

          {/* Empty state (print-only lists can still be empty) */}
          {sections.length === 0 && (
            <div className="py-3xl text-center print:no-print">
              <p className="font-serif text-[18px] text-gray-400">
                Nothing to pour right now.
              </p>
            </div>
          )}

          {/* Sections — more generous spacing than the public view */}
          {sections.map((section) => (
            <section
              key={section.id}
              className="mb-2xl"
            >
              <h2 className="mb-lg flex items-baseline gap-sm font-serif text-[24px] font-medium text-black">
                <span>{section.name}</span>
                <span className="font-mono text-[14px] font-normal text-gray-400">
                  {section.items.length}
                </span>
              </h2>
              <div className="flex flex-col gap-md">
                {section.items.map((item) => {
                  const wine = item.wines;
                  const is86d = item.is_marked_eightysixed;
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "border-b border-black/15 pb-md last:border-b-0",
                        is86d && "opacity-50",
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-lg">
                        <div className="min-w-0">
                          <span
                            className={cn(
                              "font-serif text-[17px] text-black",
                              is86d && "line-through",
                            )}
                          >
                            {item.name_override ?? `${wine.producer} ${wine.name}`}
                          </span>
                          {is86d && (
                            <span className="ml-xs font-mono text-[12px] uppercase text-gray-400 print:no-print">
                              86&rsquo;d
                            </span>
                          )}
                          {wine.vintage && (
                            <span className={cn(
                              "ml-xs font-mono text-[13px] text-gray-500",
                              is86d && "line-through",
                            )}>
                              {wine.vintage}
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-baseline gap-lg font-mono text-[15px]">
                          {item.glass_price != null && (
                            <span className={cn(
                              "text-gray-600",
                              is86d && "line-through",
                            )}>
                              ${item.glass_price}
                            </span>
                          )}
                          {item.bottle_price != null && (
                            <span className={cn(
                              "text-black",
                              is86d && "line-through",
                            )}>
                              ${item.bottle_price}
                            </span>
                          )}
                        </div>
                      </div>
                      {(wine.region || wine.serving_temp_label) && (
                        <p className={cn(
                          "mt-1 text-[13px] text-gray-500 leading-relaxed",
                          is86d && "line-through",
                        )}>
                          {wine.region}
                          {wine.varietal && ` · ${wine.varietal}`}
                          {wine.serving_temp_label && wine.serving_temp_min != null && wine.serving_temp_max != null && (
                            <span className="text-gray-400">
                              {wine.region ? " · " : ""}{wine.serving_temp_min}–{wine.serving_temp_max}°F
                            </span>
                          )}
                        </p>
                      )}
                      {item.tasting_note && (
                        <p className={cn(
                          "mt-1 font-sans text-[14px] italic text-gray-500 leading-relaxed",
                          is86d && "line-through",
                        )}>
                          {item.tasting_note}
                        </p>
                      )}
                      {item.blurb && (
                        <p className={cn(
                          "mt-1 text-[14px] text-gray-600 leading-relaxed",
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
        </main>
      </body>
    </html>
  );
}
