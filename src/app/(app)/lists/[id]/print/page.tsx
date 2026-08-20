import type { Metadata } from "next";
import { NextResponse } from "next/server";
import { notFound, redirect } from "next/navigation";
import { requireMembership } from "@/lib/api/auth";
import { renderWineListSections } from "@/lib/wine-list/render";
import type { WineListSectionEmbed } from "@/lib/wine-list/shapes";
import { PrintControls } from "./print-controls";

export const metadata: Metadata = { title: "Print list" };

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

export default async function WineListPrintPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;

  const auth = await requireMembership();
  if (auth instanceof NextResponse) {
    redirect(`/login?next=/lists/${id}/print`);
  }
  const { supabase, restaurantId } = auth;

  const { data: list, error } = await supabase
    .from("wine_lists")
    .select(
      "name, slug, restaurant_id, restaurants(name), wine_list_sections(id, name, position, wine_list_items(id, position, glass_price, bottle_price, tasting_note, blurb, hidden, wines(name, producer, vintage, varietal, region, serving_temp_min, serving_temp_max, serving_temp_label, is_eightysixed)))",
    )
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (error || !list) notFound();

  const restaurantName =
    (list.restaurants as { name: string } | null)?.name ?? "";

  const sections = renderWineListSections(
    (list.wine_list_sections ?? []) as unknown as WineListSectionEmbed<PublicWineItem>[],
  ).map((section) => ({
    ...section,
    items: section.items.filter((it) => !it.hidden && it.wines && !it.wines.is_eightysixed),
  })).filter((s) => s.items.length > 0);

  return (
    <main className="mx-auto min-h-screen max-w-[720px] bg-white px-lg py-2xl print:px-0 print:py-md">
      <PrintControls listId={id} />

      <header className="mb-2xl border-b border-ink/20 pb-lg print:mb-xl print:pb-md">
        <p className="text-[11px] uppercase tracking-[0.12em] text-ink-subtle">
          {restaurantName}
        </p>
        <h1 className="mt-sm font-serif text-[32px] text-ink print:text-[26px]">
          {list.name}
        </h1>
      </header>

      {sections.length === 0 && (
        <p className="font-sans text-[14px] italic text-ink-muted">
          No wines to print.
        </p>
      )}

      {sections.map((section) => (
        <section key={section.id} className="mb-2xl break-inside-avoid print:mb-xl">
          <h2 className="mb-md border-b border-ink/10 pb-xs font-serif text-[20px] font-medium text-ink print:text-[17px]">
            {section.name}
          </h2>
          <div className="flex flex-col">
            {section.items.map((item) => {
              const wine = item.wines!;
              return (
                <div
                  key={item.id}
                  className="break-inside-avoid border-b border-ink/5 py-sm last:border-b-0 print:py-2xs"
                >
                  <div className="flex items-baseline justify-between gap-md">
                    <div className="min-w-0">
                      <span className="font-serif text-[17px] font-medium text-ink print:text-[14px]">
                        {wine.producer} {wine.name}
                      </span>
                      {wine.vintage && (
                        <span className="ml-xs font-mono text-[12px] text-ink-muted print:text-[11px]">
                          {wine.vintage}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-baseline gap-md font-mono text-[14px] print:text-[12px]">
                      {item.glass_price != null && (
                        <span className="text-ink-muted">${item.glass_price}</span>
                      )}
                      {item.bottle_price != null && (
                        <span className="text-ink">${item.bottle_price}</span>
                      )}
                    </div>
                  </div>
                  {(wine.region || wine.varietal) && (
                    <p className="mt-2xs text-[12px] text-ink-muted print:text-[10px]">
                      {wine.region}
                      {wine.varietal && (wine.region ? ` · ${wine.varietal}` : wine.varietal)}
                    </p>
                  )}
                  {item.blurb && (
                    <p className="mt-2xs font-sans text-[12px] italic text-ink-muted print:text-[10px]">
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
  );
}
