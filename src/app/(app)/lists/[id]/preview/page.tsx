import type { Metadata } from "next";
import { WineThumb } from "@/components/wine-thumb";
import { NextResponse } from "next/server";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, EyeOff } from "lucide-react";
import { requireMembership } from "@/lib/api/auth";
import {
  renderWineListSections,
  wineListItemLabel,
  type EightysixStrategy,
} from "@/lib/wine-list/render";
import type { WineListSectionEmbed } from "@/lib/wine-list/shapes";

export const metadata: Metadata = { title: "Preview list" };

type Params = Promise<{ id: string }>;

type PublicWineItem = {
  id: string;
  position: number;
  glass_price: number | null;
  bottle_price: number | null;
  tasting_note: string | null;
  blurb: string | null;
  name_override: string | null;
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
    hero_image_url: string | null;
  } | null;
};

/**
 * BND-172: Preview renders the wine list with the same public styling
 * regardless of publish status. Hidden items are shown with a visual
 * warning so the editor can see what guests won't. Only authenticated
 * members of the owning restaurant can access the preview.
 *
 * BND-173: the preview must honour the restaurant's `eightysix_strategy`,
 * the same way /list/[slug] and /list/[slug]/print do. It did not — it
 * called renderWineListSections() with no options, so the default 'hide'
 * applied unconditionally and a restaurant set to 'mark' saw a preview
 * missing every 86'd wine its live menu still shows. "This is how guests
 * will see the list" was then false for exactly the restaurants that had
 * changed the setting.
 *
 * BUG-01: the line label goes through wineListItemLabel() — the same helper
 * the published menu, the print menu and the PDF use. Composing
 * `${producer} ${name}` here printed the winery twice on the 98% of rows
 * whose `name` still carries its producer, and ignored `name_override`
 * entirely, so an operator's own words for a bottle showed on the live menu
 * and not in the preview of it. A preview of the guest menu is a fourth
 * consumer of the guest menu's rendering rules, not a fourth copy of them.
 */
export default async function WineListPreviewPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;

  const auth = await requireMembership();
  if (auth instanceof NextResponse) {
    redirect(`/login?next=/lists/${id}/preview`);
  }
  const { supabase, restaurantId } = auth;

  // Fetch the list with full data — no is_published requirement
  // wines!wine_list_items_wine_id_fkey: 0080 added a second FK between
  // wine_list_items and wines (the tenant-matching composite FK), so
  // PostgREST needs the relationship named explicitly or embedding fails
  // with PGRST201 ("more than one relationship was found").
  const { data: list, error } = await supabase
    .from("wine_lists")
    .select(
      "name, is_published, slug, template, restaurant_id, restaurants(name, eightysix_strategy), wine_list_sections(id, name, position, wine_list_items(id, position, glass_price, bottle_price, tasting_note, blurb, name_override, hidden, wines!wine_list_items_wine_id_fkey(name, producer, vintage, varietal, region, serving_temp_min, serving_temp_max, serving_temp_label, is_eightysixed, hero_image_url)))",
    )
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (error || !list) notFound();

  const restaurant =
    list.restaurants as { name: string; eightysix_strategy: string } | null;
  const restaurantName = restaurant?.name ?? "";
  const eightysixStrategy: EightysixStrategy =
    restaurant?.eightysix_strategy === "mark" ? "mark" : "hide";

  // Unlike the public list, preview INCLUDES hidden items so the
  // editor can see what the public will miss. 86'd wines, by contrast,
  // follow the restaurant's own strategy — that IS what guests see.
  const sections = renderWineListSections(
    (list.wine_list_sections ?? []) as unknown as WineListSectionEmbed<PublicWineItem>[],
    { eightysixStrategy },
  );

  return (
    <main className="mx-auto min-h-screen max-w-[720px] bg-surface px-lg py-3xl">
      {/* Back link */}
      <Link
        href={`/lists/${id}`}
        className="mb-md inline-flex items-center gap-xs text-[13px] text-grey hover:text-ink no-underline print:hidden"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
        Back to editor
      </Link>

      {/* Preview badge */}
      <div className="mb-lg rounded-md border border-risk-wash bg-risk-wash/30 px-md py-sm print:hidden">
        <p className="text-[13px] font-medium text-risk-ink">
          Preview mode
          {!list.is_published && " — this list is not yet published"}
        </p>
        <p className="mt-2xs text-[12px] text-grey">
          This is how guests will see the list.
          {" "}
          {list.is_published && (
            <a href={`/list/${list.slug}`} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              Open live version
            </a>
          )}
        </p>
      </div>

      {/* Header */}
      <header className="mb-2xl border-b border-rule pb-xl">
        <p className="text-caption uppercase text-grey">
          {restaurantName}
        </p>
        <h1 className="mt-sm font-serif text-heading-sm text-ink">
          {list.name}
        </h1>
      </header>

      {/* Empty state */}
      {sections.length === 0 && (
        <div className="my-3xl rounded-card border border-dashed border-rule-strong bg-wash px-lg py-2xl text-center">
          <p className="font-serif text-[18px] text-ink">
            Nothing to pour right now.
          </p>
          <p className="mt-xs text-[13px] text-grey">
            Add wines to your list in the editor.
          </p>
        </div>
      )}

      {/* Sections */}
      {sections.map((section) => (
        <section
          key={section.id}
          className="mb-2xl"
        >
          <h2 className="mb-md flex items-baseline gap-sm font-serif text-[22px] font-medium text-ink">
            <span>{section.name}</span>
            <span className="font-mono text-[13px] font-normal text-grey">
              {section.items.length}
            </span>
          </h2>
          <div className="flex flex-col">
            {section.items.map((item) => {
              const wine = item.wines;
              const isHidden = item.hidden;
              const is86d = item.is_marked_eightysixed;
              return (
                <div
                  key={item.id}
                  data-eightysixed={is86d ? "true" : undefined}
                  className={`border-b border-rule/50 py-sm last:border-b-0${isHidden ? " bg-risk-wash/10" : ""}${is86d ? " opacity-50" : ""}`}
                >
                  {/* BND-171: hidden item warning for editor */}
                  {isHidden && (
                    <div className="mb-sm flex items-center gap-xs rounded-pill bg-risk-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-risk-ink print:hidden">
                      <EyeOff className="h-3 w-3" strokeWidth={2} />
                      Hidden from guests
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-md">
                    <WineThumb
                      src={wine.hero_image_url}
                      producer={wine.producer}
                      name={wine.name}
                      colour={null}
                      size={44}
                      className="self-start print:hidden"
                    />
                    <div className="min-w-0 flex-1">
                      <span className={`font-serif text-[17px] font-medium${isHidden || is86d ? " line-through" : ""}${isHidden ? " text-grey" : " text-ink"}`}>
                        {wineListItemLabel(item)}
                      </span>
                      {is86d && (
                        <span className="ml-xs text-caption uppercase text-grey">
                          Unavailable
                        </span>
                      )}
                      {wine.vintage && (
                        <span className="ml-xs font-mono text-[12px] text-grey">
                          {wine.vintage}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-baseline gap-md font-mono text-[14px]">
                      {item.glass_price != null && (
                        <span className="text-grey">
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
                    <p className="mt-2xs text-[12px] text-grey">
                      {wine.region}
                      {wine.varietal && ` · ${wine.varietal}`}
                      {wine.serving_temp_label && wine.serving_temp_min != null && wine.serving_temp_max != null && (
                        <span className="text-grey">
                          {wine.region ? " · " : ""}{wine.serving_temp_min}–{wine.serving_temp_max}°F
                        </span>
                      )}
                    </p>
                  )}
                  {item.tasting_note && (
                    <p className="mt-xs font-sans text-[13px] italic text-grey">
                      {item.tasting_note}
                    </p>
                  )}
                  {/* BND-170: blurb renders under wine */}
                  {item.blurb && (
                    <p className="mt-xs text-[13px] text-grey leading-relaxed">
                      {item.blurb}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {/* Footer */}
      <footer className="mt-3xl border-t border-rule pt-lg text-center print:hidden">
        <p className="text-[12px] text-grey">
          Powered by <span className="font-serif font-medium text-accent">Terroir</span>
        </p>
      </footer>
    </main>
  );
}
