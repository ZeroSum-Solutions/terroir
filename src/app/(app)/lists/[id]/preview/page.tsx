import type { Metadata } from "next";
import { NextResponse } from "next/server";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, EyeOff } from "lucide-react";
import { requireMembership } from "@/lib/api/auth";
import { renderWineListSections } from "@/lib/wine-list/render";
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

/**
 * BND-172: Preview renders the wine list with the same public styling
 * regardless of publish status. Hidden items are shown with a visual
 * warning so the editor can see what guests won't. Only authenticated
 * members of the owning restaurant can access the preview.
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
  const { data: list, error } = await supabase
    .from("wine_lists")
    .select(
      "name, is_published, slug, template, restaurant_id, restaurants(name), wine_list_sections(id, name, position, wine_list_items(id, position, glass_price, bottle_price, tasting_note, blurb, hidden, wines(name, producer, vintage, varietal, region, serving_temp_min, serving_temp_max, serving_temp_label, is_eightysixed)))",
    )
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (error || !list) notFound();

  const restaurantName =
    (list.restaurants as { name: string } | null)?.name ?? "";

  // Unlike the public list, preview INCLUDES hidden items so the
  // editor can see what the public will miss.
  const sections = renderWineListSections(
    (list.wine_list_sections ?? []) as unknown as WineListSectionEmbed<PublicWineItem>[],
  );

  return (
    <main className="mx-auto min-h-screen max-w-[720px] bg-surface px-lg py-3xl">
      {/* Back link */}
      <Link
        href={`/lists/${id}`}
        className="mb-md inline-flex items-center gap-xs text-[13px] text-ink-muted hover:text-ink no-underline print:hidden"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
        Back to editor
      </Link>

      {/* Preview badge */}
      <div className="mb-lg rounded-md border border-amber-wash bg-amber-wash/30 px-md py-sm print:hidden">
        <p className="text-[13px] font-medium text-amber">
          Preview mode
          {!list.is_published && " — this list is not yet published"}
        </p>
        <p className="mt-2xs text-[12px] text-ink-muted">
          This is how guests will see the list.
          {" "}
          {list.is_published && (
            <a href={`/list/${list.slug}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              Open live version
            </a>
          )}
        </p>
      </div>

      {/* Header */}
      <header className="mb-2xl border-b border-hairline pb-xl">
        <p className="text-caption uppercase text-grey">
          {restaurantName}
        </p>
        <h1 className="mt-sm font-serif text-heading-sm text-ink">
          {list.name}
        </h1>
      </header>

      {/* Empty state */}
      {sections.length === 0 && (
        <div className="my-3xl rounded-card border border-dashed border-beige-deep bg-bridge-surface px-lg py-2xl text-center">
          <p className="font-serif text-[18px] text-ink">
            Nothing to pour right now.
          </p>
          <p className="mt-xs text-[13px] text-ink-muted">
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
            <span className="font-mono text-[13px] font-normal text-ink-muted">
              {section.items.length}
            </span>
          </h2>
          <div className="flex flex-col">
            {section.items.map((item) => {
              const wine = item.wines;
              const isHidden = item.hidden;
              return (
                <div
                  key={item.id}
                  className={`border-b border-hairline/50 py-sm last:border-b-0${isHidden ? " bg-amber-wash/10" : ""}`}
                >
                  {/* BND-171: hidden item warning for editor */}
                  {isHidden && (
                    <div className="mb-sm flex items-center gap-xs rounded-pill bg-amber-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-amber print:hidden">
                      <EyeOff className="h-3 w-3" strokeWidth={2} />
                      Hidden from guests
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-md">
                    <div className="min-w-0">
                      <span className={`font-serif text-[17px] font-medium${isHidden ? " text-ink-muted line-through" : " text-ink"}`}>
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
                    <p className="mt-xs font-sans text-[13px] italic text-ink-muted">
                      {item.tasting_note}
                    </p>
                  )}
                  {/* BND-170: blurb renders under wine */}
                  {item.blurb && (
                    <p className="mt-xs text-[13px] text-ink-muted leading-relaxed">
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
      <footer className="mt-3xl border-t border-hairline pt-lg text-center print:hidden">
        <p className="text-[12px] text-ink-subtle">
          Powered by <span className="font-serif font-medium text-primary">Terroir</span>
        </p>
      </footer>
    </main>
  );
}
