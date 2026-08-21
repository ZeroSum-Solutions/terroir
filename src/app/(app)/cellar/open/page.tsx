import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Wine } from "lucide-react";
import { getAuthContext } from "@/lib/auth-context";
import { RouteDataEmpty } from "@/components/route-data-state";
import { ML_PER_OZ } from "@/lib/units";
import { cn } from "@/lib/utils";
import { CloseBottleButton } from "./close-button";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Open Bottles" };

type OBRow = {
  id: string;
  wine_id: string;
  opened_at: string;
  opened_by: string | null;
  remaining_ml: number;
  size_ml: number;
  wines: {
    id: string;
    name: string;
    producer: string;
    vintage: number | null;
  } | null;
};

export default async function OpenBottlesPage() {
  const auth = (await getAuthContext())!;
  const { supabase, restaurantId } = auth;

  const { data: bottles, error: bottlesError } = await supabase
    .from("open_bottles")
    .select(
      "id, wine_id, opened_at, opened_by, remaining_ml, size_ml, wines!inner(id, name, producer, vintage)",
    )
    .eq("restaurant_id", restaurantId)
    .is("closed_at", null)
    .order("opened_at", { ascending: false });

  if (bottlesError) throw bottlesError;

  const openBottles = (bottles ?? []) as unknown as OBRow[];
  const renderedAtMs = new Date().getTime();

  return (
    <section>
      <header className="mb-lg flex items-center gap-sm">
        <Link
          href="/cellar"
          className="flex h-[44px] w-[44px] items-center justify-center rounded-pill text-grey hover:bg-bridge-surface transition-colors"
          aria-label="Back to cellar"
        >
          <ArrowLeft className="h-5 w-5" strokeWidth={2} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-[28px] font-medium text-ink">Open Bottles</h1>
          <p className="text-[12px] text-grey tabular">
            {openBottles.length} bottle{openBottles.length !== 1 ? "s" : ""} currently open
          </p>
        </div>
      </header>

      {openBottles.length === 0 && (
        <RouteDataEmpty
          icon={<Wine className="h-6 w-6" strokeWidth={1.5} />}
          title="No open bottles"
          description="Open a bottle from the cellar to start tracking pours. Open bottles will appear here with their remaining volume."
          action={
            <Link
              href="/cellar"
              className="inline-flex h-11 items-center rounded-pill bg-primary px-md text-[14px] font-medium text-white hover:bg-primary-hover"
            >
              Return to cellar
            </Link>
          }
        />
      )}

      {openBottles.length > 0 && (
        <div className="rounded-card border border-hairline bg-white overflow-hidden">
          <div className="hidden md:grid md:grid-cols-[1fr_120px_160px_120px_100px] gap-md px-lg py-sm border-b border-hairline bg-bridge-surface">
            <span className="text-caption font-medium text-grey uppercase">Wine</span>
            <span className="text-caption font-medium text-grey uppercase">Format</span>
            <span className="text-caption font-medium text-grey uppercase">Opened</span>
            <span className="text-caption font-medium text-grey uppercase text-right">Remaining</span>
            <span className="text-caption font-medium text-grey uppercase text-right">Action</span>
          </div>

          <ul className="divide-y divide-hairline">
            {openBottles.map((bottle) => {
              const wine = bottle.wines;
              const remainingOz = bottle.remaining_ml / ML_PER_OZ;
              const remainingPct =
                bottle.size_ml > 0
                  ? Math.round((bottle.remaining_ml / bottle.size_ml) * 100)
                  : 0;
              const openedDate = new Date(bottle.opened_at);
              const daysOpen = Math.floor(
                (renderedAtMs - openedDate.getTime()) / (1000 * 60 * 60 * 24),
              );
              const openedLabel =
                daysOpen === 0
                  ? "Today"
                  : daysOpen === 1
                    ? "Yesterday"
                    : `${daysOpen}d ago`;

              return (
                <li key={bottle.id}>
                  <Link
                    href={`/cellar?wine=${bottle.wine_id}`}
                    className="block px-lg py-md hover:bg-bridge-surface transition-colors focus-visible:ring-2 focus-visible:ring-blush-wash focus-visible:outline-none"
                  >
                    <div className="md:hidden">
                      <div className="flex items-start justify-between gap-sm">
                        <div className="font-serif text-[17px] font-medium text-ink leading-snug min-w-0">
                          {wine?.producer ?? "Unknown"}{" "}
                          {wine?.name ?? "Unknown"}
                          {wine?.vintage != null && (
                            <span className="font-sans font-light text-grey ml-xs">
                              {wine.vintage}
                            </span>
                          )}
                        </div>
                        <CloseBottleButton
                          bottleId={bottle.id}
                          remainingOz={remainingOz}
                        />
                      </div>
                      <div className="mt-xs flex flex-wrap items-center gap-sm text-[12px] text-grey">
                        <span>{formatBottleSize(bottle.size_ml)}</span>
                        <span aria-hidden>·</span>
                        <span>
                          {openedLabel}{" "}
                          <span className="text-grey">
                            {openedDate.toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            })}
                          </span>
                        </span>
                      </div>
                      <div className="mt-sm flex items-center gap-sm">
                        <div className="flex-1 h-[6px] rounded-pill bg-bridge-surface overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-pill transition-all",
                              remainingPct > 25
                                ? "bg-sage"
                                : remainingPct > 10
                                  ? "bg-amber"
                                  : "bg-primary",
                            )}
                            style={{
                              width: `${Math.max(remainingPct, 2)}%`,
                            }}
                          />
                        </div>
                        <span className="font-mono text-[13px] tabular text-ink shrink-0">
                          {formatOz(remainingOz)}
                        </span>
                      </div>
                    </div>

                    <div className="hidden md:grid md:grid-cols-[1fr_120px_160px_120px_100px] gap-md items-center">
                      <div className="min-w-0">
                        <div className="font-serif text-[17px] font-medium text-ink truncate">
                          {wine?.producer ?? "Unknown"}{" "}
                          {wine?.name ?? "Unknown"}
                        </div>
                        {wine?.vintage != null && (
                          <div className="text-[12px] text-grey tabular">
                            {wine.vintage}
                          </div>
                        )}
                      </div>
                      <div className="text-[13px] text-ink tabular">
                        {formatBottleSize(bottle.size_ml)}
                      </div>
                      <div className="text-[13px] text-ink">
                        <span>{openedLabel}</span>
                        <span className="text-grey ml-xs">
                          {openedDate.toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <div className="text-right">
                        <div className="flex items-center justify-end gap-sm">
                          <div className="w-16 h-[6px] rounded-pill bg-bridge-surface overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-pill",
                                remainingPct > 25
                                  ? "bg-sage"
                                  : remainingPct > 10
                                    ? "bg-amber"
                                    : "bg-primary",
                              )}
                              style={{
                                width: `${Math.max(remainingPct, 2)}%`,
                              }}
                            />
                          </div>
                          <span className="font-mono text-[13px] tabular text-ink">
                            {formatOz(remainingOz)}
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        <CloseBottleButton
                          bottleId={bottle.id}
                          remainingOz={remainingOz}
                        />
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function formatBottleSize(ml: number): string {
  if (ml === 750) return "Standard (750ml)";
  if (ml === 375) return "Half (375ml)";
  if (ml === 1500) return "Magnum (1.5L)";
  if (ml === 3000) return "Double Magnum (3L)";
  if (ml >= 1000) return `${(ml / 1000).toFixed(1)}L`;
  return `${ml}ml`;
}

function formatOz(oz: number): string {
  if (oz < 0.05) return "0 oz";
  if (oz < 1) return `${oz.toFixed(1)} oz`;
  return `${oz.toFixed(1)} oz`;
}
