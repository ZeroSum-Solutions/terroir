"use client";

import { useState, useEffect, useCallback } from "react";
import { Wine, TrendingUp, DollarSign } from "lucide-react";

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

type PourData = {
  range: string;
  topN: number;
  totalPours: number;
  pourVolumeBySection: PourVolumeItem[];
  topWinesByPours: TopWineItem[];
  topWinesByRevenue: TopRevenueItem[];
};

const RANGE_OPTIONS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
] as const;

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
        className="h-full rounded-pill bg-accent transition-all duration-300"
        style={{ width: `${Math.max(pct, 1)}%` }}
      />
    </div>
  );
}

export default function PourAnalyticsSection() {
  const [range, setRange] = useState<string>("30d");
  const [data, setData] = useState<PourData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (r: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/insights/pour?range=${r}&topN=10`);
      if (!res.ok) throw new Error("Failed to load pour data");
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(range);
  }, [range, fetchData]);

  if (loading) {
    return (
      <section className="rounded-md border border-border bg-surface p-lg">
        <div className="mb-md flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-ink">Pour analytics</h2>
          <div className="flex gap-xs">
            {RANGE_OPTIONS.map((opt) => (
              <span
                key={opt.value}
                className="h-[28px] w-[80px] animate-pulse rounded-sm bg-surface-muted"
              />
            ))}
          </div>
        </div>
        <div className="grid gap-md md:grid-cols-2">
          <div className="h-[200px] animate-pulse rounded-md bg-surface-muted" />
          <div className="h-[200px] animate-pulse rounded-md bg-surface-muted" />
        </div>
      </section>
    );
  }

  if (error || !data) {
    return (
      <section className="rounded-md border border-border bg-surface p-lg">
        <h2 className="text-[15px] font-semibold text-ink">Pour analytics</h2>
        <p className="mt-sm text-[13px] text-ink-muted">
          {error ?? "No data available yet. Start pouring to see analytics."}
        </p>
      </section>
    );
  }

  const maxSectionOz = Math.max(
    ...data.pourVolumeBySection.map((s) => s.oz),
    1,
  );
  const maxPourCount = Math.max(
    ...data.topWinesByPours.map((w) => w.pour_count),
    1,
  );
  const maxRevenue = Math.max(
    ...data.topWinesByRevenue.map((w) => w.revenue),
    1,
  );

  const hasData = data.totalPours > 0;

  return (
    <section
      className="rounded-md border border-border bg-surface p-lg"
      aria-labelledby="pour-analytics-heading"
    >
      <div className="mb-md flex flex-wrap items-center justify-between gap-sm">
        <div className="flex items-center gap-sm">
          <h2
            id="pour-analytics-heading"
            className="text-[15px] font-semibold text-ink"
          >
            Pour analytics
          </h2>
          <span className="font-mono text-[12px] text-ink-subtle">
            {data.totalPours} pour{data.totalPours === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex rounded-sm border border-border overflow-hidden" role="radiogroup" aria-label="Date range">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              role="radio"
              aria-checked={range === opt.value}
              onClick={() => setRange(opt.value)}
              className={`px-sm py-2xs text-[12px] font-medium transition-colors ${
                range === opt.value
                  ? "bg-accent text-white"
                  : "text-ink-muted hover:bg-surface-muted"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {!hasData ? (
        <div className="flex flex-col items-center justify-center py-3xl text-center">
          <Wine
            className="mb-md h-10 w-10 text-ink-subtle"
            strokeWidth={1.5}
          />
          <p className="text-[15px] font-medium text-ink">
            No pour data for this range
          </p>
          <p className="mt-xs text-[13px] text-ink-muted">
            Start pouring wines to see analytics here.
          </p>
        </div>
      ) : (
        <div className="grid gap-md md:grid-cols-2">
          {/* Pour volume by section chart */}
          <div className="rounded-md border border-dashed border-border p-md">
            <div className="mb-sm flex items-center gap-xs">
              <TrendingUp className="h-4 w-4 text-ink-subtle" strokeWidth={1.5} />
              <h3 className="text-[13px] font-semibold text-ink">
                Volume by section
              </h3>
            </div>
            {data.pourVolumeBySection.length === 0 ? (
              <p className="text-[13px] text-ink-muted">
                No sections with pour data
              </p>
            ) : (
              <div className="flex flex-col gap-xs">
                {data.pourVolumeBySection.map((s) => (
                  <div key={s.section} className="flex items-center gap-sm">
                    <span className="w-[110px] shrink-0 truncate text-[13px] text-ink">
                      {s.section}
                    </span>
                    <PourBar oz={s.oz} maxOz={maxSectionOz} />
                    <span className="w-[60px] shrink-0 text-right font-mono text-[12px] text-ink-muted">
                      {formatOz(s.oz)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Top wines by pour count */}
          <div className="rounded-md border border-dashed border-border p-md">
            <div className="mb-sm flex items-center gap-xs">
              <Wine className="h-4 w-4 text-ink-subtle" strokeWidth={1.5} />
              <h3 className="text-[13px] font-semibold text-ink">
                Most poured
              </h3>
            </div>
            {data.topWinesByPours.length === 0 ? (
              <p className="text-[13px] text-ink-muted">No pour data</p>
            ) : (
              <div className="flex flex-col gap-xs">
                {data.topWinesByPours.map((w, i) => (
                  <div key={w.wine_id} className="flex items-center gap-sm">
                    <span className="w-[18px] shrink-0 text-right font-mono text-[11px] text-ink-subtle">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-ink">
                        {w.producer} {w.name}
                        {w.vintage ? ` ${w.vintage}` : ""}
                      </div>
                    </div>
                    <PourBar oz={w.pour_count} maxOz={maxPourCount} />
                    <span className="w-[32px] shrink-0 text-right font-mono text-[12px] text-ink-muted">
                      {w.pour_count}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Top wines by revenue — full width on desktop */}
          <div className="rounded-md border border-dashed border-border p-md md:col-span-2">
            <div className="mb-sm flex items-center gap-xs">
              <DollarSign className="h-4 w-4 text-ink-subtle" strokeWidth={1.5} />
              <h3 className="text-[13px] font-semibold text-ink">
                Revenue leaders
              </h3>
            </div>
            {data.topWinesByRevenue.length === 0 ? (
              <p className="text-[13px] text-ink-muted">
                No wines with pricing data poured in this range
              </p>
            ) : (
              <div className="grid gap-xs md:grid-cols-2 md:gap-sm">
                {data.topWinesByRevenue.map((w, i) => (
                  <div
                    key={w.wine_id}
                    className="flex items-center gap-sm rounded-sm p-xs hover:bg-surface-muted/50"
                  >
                    <span className="w-[18px] shrink-0 text-right font-mono text-[11px] text-ink-subtle">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-ink">
                        {w.producer} {w.name}
                        {w.vintage ? ` ${w.vintage}` : ""}
                      </div>
                      <div className="mt-2xs text-[12px] text-ink-muted">
                        {w.pour_count} pour{w.pour_count === 1 ? "" : "s"}
                      </div>
                    </div>
                    <PourBar oz={w.revenue} maxOz={maxRevenue} />
                    <span className="w-[48px] shrink-0 text-right font-mono text-[13px] font-medium text-ink">
                      {formatMoney(w.revenue)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
