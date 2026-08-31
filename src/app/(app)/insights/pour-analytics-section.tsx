"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Wine, TrendingUp, DollarSign } from "lucide-react";
import { metricHref } from "./metric-href";
import { wineTitle } from "@/lib/wine-display-name";

type PourVolumeItem = {
  section: string;
  oz: number;
};

type TopWineItem = {
  wine_id: string;
  name: string;
  producer: string;
  vintage: number | null;
  pour_count: number;
};

type TopRevenueItem = {
  wine_id: string;
  name: string;
  producer: string;
  vintage: number | null;
  revenue: number;
  pour_count: number;
};

export type PourData = {
  range: string;
  topN: number;
  totalPours: number;
  pourVolumeBySection: PourVolumeItem[];
  topWinesByPours: TopWineItem[];
  topWinesByRevenue: TopRevenueItem[];
};

function formatOz(oz: number): string {
  if (oz >= 1000) return (oz / 1000).toFixed(1) + "k oz";
  return oz.toFixed(1) + " oz";
}

function formatMoney(n: number): string {
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function PourBar({ oz, maxOz }: { oz: number; maxOz: number }) {
  const pct = maxOz > 0 ? (oz / maxOz) * 100 : 0;
  return (
    <div className="h-2.5 flex-1 overflow-hidden rounded-pill bg-surface-sunken">
      <div
        className="h-full rounded-pill bg-primary transition-all duration-300"
        style={{ width: `${Math.max(pct, 1)}%` }}
      />
    </div>
  );
}

function ytdStart(): string {
  const d = new Date();
  d.setMonth(0, 1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

export default function PourAnalyticsSection() {
  const searchParams = useSearchParams();

  // Derive range from URL search params
  const range = searchParams.get("range") ?? "all";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";

  const [data, setData] = useState<PourData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    function () {
      let cancelled = false;

      async function fetchData() {
        await Promise.resolve();
        if (cancelled) return;
        setLoading(true);
        setError(null);

        // Build API query params
        const params = new URLSearchParams();
        params.set("topN", "10");

        if (range === "custom" && from && to) {
          params.set("range", "custom");
          params.set("from", from);
          params.set("to", to);
        } else if (range === "ytd") {
          params.set("range", "custom");
          params.set("from", ytdStart());
          params.set("to", new Date().toISOString().slice(0, 10));
        } else {
          params.set("range", range);
        }

        try {
          const res = await fetch("/api/insights/pour?" + params.toString());
          if (!res.ok) throw new Error("Failed to load pour data");
          const json = await res.json();
          if (!cancelled) setData(json);
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "Unknown error");
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      }

      void fetchData();
      return function () {
        cancelled = true;
      };
    },
    [range, from, to],
  );

  if (loading) {
    return (
      <section className="rounded-card card-surface p-lg">
        <div className="mb-md flex items-center justify-between">
          <h2 className="text-[15px] font-medium text-ink">Pour analytics</h2>
        </div>
        <div className="grid gap-md md:grid-cols-2">
          <div className="h-[200px] animate-pulse rounded-md bg-wash" />
          <div className="h-[200px] animate-pulse rounded-md bg-wash" />
        </div>
      </section>
    );
  }

  if (error || !data) {
    return (
      <section className="rounded-card card-surface p-lg">
        <h2 className="text-[15px] font-medium text-ink">Pour analytics</h2>
        <p className="mt-sm text-[13px] text-grey">
          {error ?? "No data available yet. Start pouring to see analytics."}
        </p>
      </section>
    );
  }

  return <PourAnalyticsContent data={data} />;
}

export function PourAnalyticsContent({ data }: { data: PourData }) {
  const maxSectionOz = Math.max(
    ...data.pourVolumeBySection.map(function (s) { return s.oz; }),
    1,
  );
  const maxPourCount = Math.max(
    ...data.topWinesByPours.map(function (w) { return w.pour_count; }),
    1,
  );
  const maxRevenue = Math.max(
    ...data.topWinesByRevenue.map(function (w) { return w.revenue; }),
    1,
  );

  const hasData = data.totalPours > 0;

  return (
    <section
      className="rounded-card card-surface p-lg"
      aria-labelledby="pour-analytics-heading"
    >
      <div className="mb-md flex flex-wrap items-center justify-between gap-sm">
        <div className="flex items-center gap-sm">
          <h2
            id="pour-analytics-heading"
            className="text-[15px] font-medium text-ink"
          >
            Pour analytics
          </h2>
          <span className="tabular text-[12px] text-grey">
            {data.totalPours} pour{data.totalPours === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {!hasData ? (
        <div className="flex flex-col items-center justify-center py-3xl text-center">
          <Wine
            className="mb-md h-10 w-10 text-grey"
            strokeWidth={1.5}
          />
          <p className="text-[15px] font-medium text-ink">
            No pour data for this range
          </p>
          <p className="mt-xs text-[13px] text-grey">
            Start pouring wines to see analytics here.
          </p>
        </div>
      ) : (
        <div className="grid gap-md md:grid-cols-2">
          {/* Pour volume by section chart */}
          <div className="min-w-0 rounded-md border border-rule bg-wash p-md">
            <div className="mb-sm flex items-center gap-xs">
              <TrendingUp className="h-4 w-4 text-grey" strokeWidth={1.5} />
              <h3 className="text-[13px] font-medium text-ink">
                Volume by section
              </h3>
            </div>
            {data.pourVolumeBySection.length === 0 ? (
              <p className="text-[13px] text-grey">
                No sections with pour data
              </p>
            ) : (
              <div className="flex flex-col gap-xs">
                {data.pourVolumeBySection.map(function (s) {
                  return (
                    <div key={s.section} className="flex items-center gap-sm">
                      <span className="w-[110px] shrink-0 truncate text-[13px] text-ink">
                        {s.section}
                      </span>
                      <PourBar oz={s.oz} maxOz={maxSectionOz} />
                      <span className="w-[60px] shrink-0 text-right tabular text-[12px] text-grey">
                        {formatOz(s.oz)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Top wines by pour count */}
          <div className="min-w-0 rounded-md border border-rule bg-wash p-md">
            <div className="mb-sm flex items-center gap-xs">
              <Wine className="h-4 w-4 text-grey" strokeWidth={1.5} />
              <h3 className="text-[13px] font-medium text-ink">
                Most poured
              </h3>
            </div>
            {data.topWinesByPours.length === 0 ? (
              <p className="text-[13px] text-grey">No pour data</p>
            ) : (
              <div className="flex flex-col gap-xs">
                {data.topWinesByPours.map(function (w, i) {
                  return (
                    <div key={w.wine_id} data-metric={`ranked-pours-${w.wine_id}`}>
                      <Link
                        href={metricHref("wine", w.wine_id)}
                        className="flex min-h-11 items-center gap-sm rounded-sm p-xs transition-colors hover:bg-surface focus-ring"
                      >
                        <span className="w-[18px] shrink-0 text-right tabular text-[11px] text-grey">
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-ink">
                            {wineTitle(w.producer, w.name)}
                            {w.vintage ? " " + String(w.vintage) : ""}
                          </div>
                        </div>
                        <PourBar oz={w.pour_count} maxOz={maxPourCount} />
                        <span className="w-[32px] shrink-0 text-right tabular text-[12px] text-grey">
                          {w.pour_count}
                        </span>
                      </Link>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Top wines by revenue — full width on desktop */}
          <div className="min-w-0 rounded-md border border-rule bg-wash p-md md:col-span-2">
            <div className="mb-sm flex items-center gap-xs">
              <DollarSign className="h-4 w-4 text-grey" strokeWidth={1.5} />
              <h3 className="text-[13px] font-medium text-ink">
                Revenue leaders
              </h3>
            </div>
            {data.topWinesByRevenue.length === 0 ? (
              <p className="text-[13px] text-grey">
                No wines with pricing data poured in this range
              </p>
            ) : (
              <div className="grid gap-xs md:grid-cols-2 md:gap-sm">
                {data.topWinesByRevenue.map(function (w, i) {
                  return (
                    <div
                      key={w.wine_id}
                      data-metric={`ranked-revenue-${w.wine_id}`}
                      className="min-w-0"
                    >
                      <Link
                        href={metricHref("wine", w.wine_id)}
                        className="flex min-h-11 items-center gap-sm rounded-sm p-xs transition-colors hover:bg-surface focus-ring"
                      >
                        <span className="w-[18px] shrink-0 text-right tabular text-[11px] text-grey">
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-ink">
                            {wineTitle(w.producer, w.name)}
                            {w.vintage ? " " + String(w.vintage) : ""}
                          </div>
                          <div className="mt-2xs text-[12px] text-grey">
                            {w.pour_count} pour{w.pour_count === 1 ? "" : "s"}
                          </div>
                        </div>
                        <PourBar oz={w.revenue} maxOz={maxRevenue} />
                        <span className="w-[48px] shrink-0 text-right tabular text-[13px] font-medium text-ink">
                          {formatMoney(w.revenue)}
                        </span>
                      </Link>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
