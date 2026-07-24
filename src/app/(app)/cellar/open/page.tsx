import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Wine } from "lucide-react";
import { getAuthContext } from "@/lib/auth-context";
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

  const { data: bottles, error } = await supabase
    .from("open_bottles")
    .select(
      "id, wine_id, opened_at, opened_by, remaining_ml, size_ml, wines!inner(id, name, producer, vintage)",
    )
    .eq("restaurant_id", restaurantId)
    .is("closed_at", null)
    .order("opened_at", { ascending: false });

  if (error) {
    console.error("Failed to load open bottles:", error);
  }

  const openBottles = (bottles ?? []) as unknown as OBRow[];
  const renderedAtMs = new Date().getTime();

  return (
    <section>
      <header className="mb-lg flex items-center gap-sm">
        <Link
          href="/cellar"
          className="flex h-[44px] w-[44px] items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted transition-colors"
          aria-label="Back to cellar"
        >
          <ArrowLeft className="h-5 w-5" strokeWidth={2} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-[28px] text-ink">Open Bottles</h1>
          <p className="text-[12px] text-ink-muted tabular">
            {openBottles.length} bottle{openBottles.length !== 1 ? "s" : ""} currently open
          </p>
        </div>
      </header>

      {openBottles.length === 0 && (
        <div className="flex flex-col items-center justify-center py-xxl text-center">
          <Wine className="h-12 w-12 text-ink-subtle mb-md" strokeWidth={1.5} />
          <p className="font-serif text-[18px] text-ink mb-xs">No open bottles</p>
          <p className="text-[14px] text-ink-muted max-w-[320px]">
            Open a bottle from the cellar to start tracking pours. Open bottles
            will appear here with their remaining volume.
          </p>
        </div>
      )}

      {openBottles.length > 0 && (
        <div className="rounded-md border border-border bg-white overflow-hidden">
          <div className="hidden md:grid md:grid-cols-[1fr_120px_160px_120px_100px] gap-md px-lg py-sm border-b border-border bg-surface-muted">
            <span className="text-[11px] font-medium text-ink-subtle uppercase tracking-wider">Wine</span>
            <span className="text-[11px] font-medium text-ink-subtle uppercase tracking-wider">Format</span>
            <span className="text-[11px] font-medium text-ink-subtle uppercase tracking-wider">Opened</span>
            <span className="text-[11px] font-medium text-ink-subtle uppercase tracking-wider text-right">Remaining</span>
            <span className="text-[11px] font-medium text-ink-subtle uppercase tracking-wider text-right">Action</span>
          </div>

          <ul className="divide-y divide-border">
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
                    className="block px-lg py-md hover:bg-surface-muted/50 transition-colors focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-none"
                  >
                    <div className="md:hidden">
                      <div className="flex items-start justify-between gap-sm">
                        <div className="font-serif text-[16px] text-ink leading-snug min-w-0">
                          {wine?.producer ?? "Unknown"}{" "}
                          {wine?.name ?? "Unknown"}
                          {wine?.vintage != null && (
                            <span className="text-ink-muted ml-xs">
                              {wine.vintage}
                            </span>
                          )}
                        </div>
                        <CloseBottleButton
                          bottleId={bottle.id}
                          openedAt={bottle.opened_at}
                          remainingOz={remainingOz}
                        />
                      </div>
                      <div className="mt-xs flex flex-wrap items-center gap-sm text-[12px] text-ink-muted">
                        <span>{formatBottleSize(bottle.size_ml)}</span>
                        <span aria-hidden>·</span>
                        <span>
                          {openedLabel}{" "}
                          <span className="text-ink-subtle">
                            {openedDate.toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            })}
                          </span>
                        </span>
                      </div>
                      <div className="mt-sm flex items-center gap-sm">
                        <div className="flex-1 h-[6px] rounded-full bg-surface-muted overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all",
                              remainingPct > 25
                                ? "bg-accent"
                                : remainingPct > 10
                                  ? "bg-warning"
                                  : "bg-error",
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
                        <div className="font-serif text-[16px] text-ink truncate">
                          {wine?.producer ?? "Unknown"}{" "}
                          {wine?.name ?? "Unknown"}
                        </div>
                        {wine?.vintage != null && (
                          <div className="text-[12px] text-ink-muted tabular">
                            {wine.vintage}
                          </div>
                        )}
                      </div>
                      <div className="text-[13px] text-ink tabular">
                        {formatBottleSize(bottle.size_ml)}
                      </div>
                      <div className="text-[13px] text-ink">
                        <span>{openedLabel}</span>
                        <span className="text-ink-muted ml-xs">
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
                          <div className="w-16 h-[6px] rounded-full bg-surface-muted overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full",
                                remainingPct > 25
                                  ? "bg-accent"
                                  : remainingPct > 10
                                    ? "bg-warning"
                                    : "bg-error",
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
                          openedAt={bottle.opened_at}
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
