import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
import { BarChart3, ScanLine, History, Activity, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { fetchDrinkWindowAlerts } from "@/lib/drink-window/alerts";
import { DRINK_NOW_THRESHOLD_YEARS } from "@/lib/drink-window/status";
import { fetchPricingAlerts } from "@/lib/pricing/alerts";
import { accuracyColor } from "@/lib/scanner/accuracy-color";
import { timeAgo } from "@/lib/time";
import { TimeAgo } from "@/components/time-ago";
import { BriefingAlertCard } from "./briefing-alert-card";
import { EnrichCellarButton } from "./enrich-cellar-button";
import { RefreshRetailButton } from "./refresh-retail-button";
import { PricingReviewCard } from "./pricing-review-card";
import { SnoozedAlertsCard, type SnoozedRow } from "./snoozed-alerts-card";
import PourAnalyticsSection from "./pour-analytics-section";
import DateRangeSelector from "./date-range-selector";
import { dateRangeSince, dateRangeUntil } from "./date-range";
import {
  OwnerMetricGrid,
  TodayStrip,
  selectTodayExceptions,
  type TodayException,
} from "./insights-drilldown";
import { metricHref } from "./metric-href";

type NullableDateRange = { range?: string; from?: string; to?: string };
type SearchParams = Promise<NullableDateRange>;

export const metadata: Metadata = { title: "Insights" };

function formatMoney(n: number) {
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

type SparklinePoint = { value: number; date?: string };

function formatSparkDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function Sparkline({ data }: { data: SparklinePoint[] }) {
  if (data.length < 2) return null;
  const width = 440;
  const height = 100;
  const pad = 6;
  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const points = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * w;
    const y = pad + (1 - (d.value - min) / range) * h;
    return { x, y, value: d.value, date: d.date };
  });

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");

  const last = points[points.length - 1];
  const first = points[0];
  const areaPath = `${path} L ${last.x.toFixed(1)},${height - pad} L ${first.x.toFixed(1)},${height - pad} Z`;

  const ariaLabel =
    `Scan activity over the last ${data.length} scans: ` +
    `${min}–${max} items per scan, most recent ${last.value}.`;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
      className="block"
    >
      <defs>
        <linearGradient id="spark-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#spark-grad)" />
      <path
        d={path}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {points.map((p, i) => {
        const dateLabel = formatSparkDate(p.date);
        const tooltip =
          `${p.value} item${p.value === 1 ? "" : "s"}` +
          (dateLabel ? ` · ${dateLabel}` : "");
        const isLast = i === points.length - 1;
        return (
          <g key={i}>
            <circle
              cx={p.x}
              cy={p.y}
              r={isLast ? 4 : 2.5}
              fill="var(--color-accent)"
              stroke="var(--color-surface)"
              strokeWidth={isLast ? 2 : 1}
              opacity={isLast ? 1 : 0.7}
            />
            <circle cx={p.x} cy={p.y} r="10" fill="transparent">
              <title>{tooltip}</title>
            </circle>
          </g>
        );
      })}
    </svg>
  );
}

// ── Bar chart for scan throughput (#148) ──────────────────────────────
function ThroughputBarChart({ data }: { data: { weekLabel: string; count: number }[] }) {
  if (data.length === 0) return null;
  const maxCount = Math.max(...data.map((d) => d.count), 1);
  const barHeightMax = 120;

  return (
    <div className="flex items-end gap-1" style={{ height: barHeightMax + 24 }}>
      {data.map((d, i) => {
        const barH = (d.count / maxCount) * barHeightMax;
        return (
          <div
            key={i}
            className="group relative flex flex-1 flex-col items-center justify-end"
          >
            <div
              className="w-full rounded-t-sm bg-accent/70 transition-colors hover:bg-accent"
              style={{ height: Math.max(barH, 2), minWidth: 4 }}
            >
              <div className="invisible absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-ink px-1.5 py-0.5 font-mono text-[11px] text-white opacity-0 transition-opacity group-hover:visible group-hover:opacity-100">
                {d.count}
              </div>
            </div>
            {data.length <= 8 || i % 4 === 0 || i === data.length - 1 ? (
              <span className="mt-1 text-[9px] text-ink-muted">{d.weekLabel}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ── Past drink window row type (#147) ─────────────────────────────────
type PastDrinkWindowRow = {
  wine_id: string;
  name: string;
  producer: string;
  vintage: number | null;
  drink_window_end: number | null;
  bottle_count: number;
  bin_location: string | null;
};

async function fetchPastDrinkWindow(
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthContext>>>["supabase"],
  restaurantId: string,
): Promise<PastDrinkWindowRow[]> {
  const currentYear = new Date().getFullYear();

  const { data: wines, error: wineErr } = await supabase
    .from("wines")
    .select(
      "id, name, producer, vintage, drink_window_end",
    )
    .eq("restaurant_id", restaurantId)
    .eq("is_eightysixed", false)
    .not("drink_window_end", "is", null)
    .lt("drink_window_end", currentYear);

  if (wineErr) throw wineErr;
  if (!wines || wines.length === 0) return [];

  // Aggregate inventory counts
  const wineIds = wines.map((w) => w.id);
  const { data: invRows, error: invErr } = await supabase
    .from("inventory_items")
    .select("wine_id, quantity, bin_location")
    .eq("restaurant_id", restaurantId)
    .in("wine_id", wineIds);

  if (invErr) throw invErr;

  const aggByWine = new Map<string, { count: number; bin: string | null }>();
  for (const row of invRows ?? []) {
    if (!row.wine_id) continue;
    const prev = aggByWine.get(row.wine_id) ?? { count: 0, bin: null };
    prev.count += row.quantity ?? 0;
    if (!prev.bin && row.bin_location) prev.bin = row.bin_location;
    aggByWine.set(row.wine_id, prev);
  }

  const rows: PastDrinkWindowRow[] = [];
  for (const w of wines) {
    const inv = aggByWine.get(w.id);
    // Only show wines with stock on hand
    if (!inv || inv.count <= 0) continue;
    rows.push({
      wine_id: w.id,
      name: w.name,
      producer: w.producer,
      vintage: w.vintage,
      drink_window_end: w.drink_window_end,
      bottle_count: inv.count,
      bin_location: inv.bin,
    });
  }

  // Sort: oldest past-peak first (lowest drink_window_end first)
  rows.sort((a, b) => {
    const aEnd = a.drink_window_end ?? 9999;
    const bEnd = b.drink_window_end ?? 9999;
    if (aEnd !== bEnd) return aEnd - bEnd;
    return a.producer.localeCompare(b.producer);
  });

  return rows;
}

// ── Scan throughput type (#148) ───────────────────────────────────────
type ThroughputWeek = { weekLabel: string; count: number };

/** Get the Monday of the ISO week for a given date. */
function getMonday(d: Date): Date {
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // Monday offset
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function computeScanThroughput(
  scans: Array<{ created_at: string }>,
  weekCount: number = 12,
): ThroughputWeek[] {
  // Group scans by ISO week (Monday of each week)
  const weekMap = new Map<number, number>();

  for (const s of scans) {
    const d = new Date(s.created_at);
    if (Number.isNaN(d.getTime())) continue;
    const monday = getMonday(d);
    weekMap.set(monday.getTime(), (weekMap.get(monday.getTime()) ?? 0) + 1);
  }

  // Convert to array, sort by Monday timestamp, take latest N weeks
  const sorted = [...weekMap.entries()]
    .sort(([a], [b]) => a - b)
    .slice(-weekCount);

  return sorted.map(([ts, count]) => {
    const monday = new Date(ts);
    const weekLabel = monday.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    return { weekLabel, count };
  });
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const auth = (await getAuthContext())!;
  const { supabase, restaurantId: rid, restaurantName, user, userRole } = auth;

  // ── Date range from URL search params ──────────────────────────────
  const range = sp.range ?? "all";
  const rangeSince = dateRangeSince(range, sp.from);
  const rangeUntil = dateRangeUntil(range, sp.to);

  const [drinkWindowAlerts, pricingAlerts, snoozedRows] = await Promise.all([
    fetchDrinkWindowAlerts(supabase, rid),
    fetchPricingAlerts(supabase, rid).catch(function () { return []; }),
    fetchSnoozedAlerts(supabase, rid).catch(function () { return [] as SnoozedRow[]; }),
  ]);
  const firstName = parseFirstName(user.email ?? "") || "there";
  const canEnrich = userRole === "owner" || userRole === "manager";

  // ── Build scan query, conditionally filtering by date range ─────────
  let scanQuery = supabase
    .from("invoice_scans")
    .select(
      "id, distributor_name, item_count, accuracy_score, created_at, final_line_items",
    )
    .eq("restaurant_id", rid)
    .order("created_at", { ascending: false });

  if (rangeSince) {
    scanQuery = scanQuery.gte("created_at", rangeSince.toISOString());
  }
  if (rangeUntil) {
    scanQuery = scanQuery.lte("created_at", rangeUntil.toISOString());
  }

  const [
    { data: scans },
    { data: inventoryItems },
    { data: scanItems },
    { count: rawEightysixedCount },
    { count: rawDrinkNowCount },
    initPastDrinkWindow,
  ] =
    await Promise.all([
      scanQuery,
      supabase
        .from("inventory_items")
        .select("quantity, unit_cost, wine_id, wines(varietal)")
        .eq("restaurant_id", rid),
      supabase
        .from("inventory_items")
        .select("quantity, unit_cost, invoice_scan_id, invoice_scans!inner(distributor_name)")
        .eq("restaurant_id", rid),
      // Server-side counts: a .select() read is capped at the PostgREST row
      // limit, which silently truncates on large cellars.
      supabase
        .from("wines")
        .select("id", { count: "exact", head: true })
        .eq("restaurant_id", rid)
        .eq("is_eightysixed", true),
      // Mirrors isClosingWindow(end): end != null && end <= year + threshold.
      supabase
        .from("wines")
        .select("id", { count: "exact", head: true })
        .eq("restaurant_id", rid)
        .eq("is_eightysixed", false)
        .lte(
          "drink_window_end",
          new Date().getFullYear() + DRINK_NOW_THRESHOLD_YEARS,
        ),
      fetchPastDrinkWindow(supabase, rid).catch(function () { return [] as PastDrinkWindowRow[]; }),
    ]);

  const allScans = scans ?? [];
  const items = inventoryItems ?? [];
  const pastDrinkWindowWines: PastDrinkWindowRow[] = initPastDrinkWindow;

  const inventoryValue = items.reduce(function (s, i) { return s + i.quantity * i.unit_cost; }, 0);
  const totalBottles = items.reduce(function (s, i) { return s + i.quantity; }, 0);
  const eightysixedCount = rawEightysixedCount ?? 0;
  const drinkNowCount = rawDrinkNowCount ?? 0;
  const todayExceptions = buildTodayExceptions(
    drinkWindowAlerts,
    pastDrinkWindowWines,
    pricingAlerts,
  );

  // Varietal breakdown (current inventory — not time-filtered)
  const varietalMap = new Map<string, number>();
  for (const item of items) {
    const varietal =
      (item.wines as { varietal: string | null } | null)?.varietal ?? "Other";
    varietalMap.set(varietal, (varietalMap.get(varietal) ?? 0) + item.quantity * item.unit_cost);
  }
  const varietalEntries = [...varietalMap.entries()].sort(function (a, b) { return b[1] - a[1]; });
  const varietalBreakdown = varietalEntries.slice(0, 6);
  const varietalTotalAll =
    varietalEntries.reduce(function (s, _a) { const v = _a[1]; return s + v; }, 0) || 1;
  const otherVarietalCount = Math.max(
    0,
    varietalEntries.length - varietalBreakdown.length,
  );

  // Distributor breakdown (filtered by date range via allScans)
  const distMap = new Map<string, { scans: number; spend: number }>();
  for (const scan of allScans) {
    const existing = distMap.get(scan.distributor_name) ?? { scans: 0, spend: 0 };
    existing.scans += 1;
    distMap.set(scan.distributor_name, existing);
  }

  for (const item of scanItems ?? []) {
    const distName = (item.invoice_scans as { distributor_name: string })?.distributor_name;
    if (!distName) continue;
    const existing = distMap.get(distName) ?? { scans: 0, spend: 0 };
    existing.spend += item.quantity * item.unit_cost;
    distMap.set(distName, existing);
  }

  const distTotalSpend =
    [...distMap.values()].reduce(function (s, d) { return s + d.spend; }, 0) || 1;

  const distributors = [...distMap.entries()]
    .sort(function (a, b) { return b[1].spend - a[1].spend; })
    .slice(0, 5);

  // Recent activity
  const recentScans = allScans.slice(0, 5);

  // ── #148: Scan throughput (invoices per week) ──────────────────────
  const throughputData = computeScanThroughput(allScans, 12);
  const totalWeeks = throughputData.length;
  const avgScansPerWeek =
    totalWeeks > 0
      ? Math.round(
          (throughputData.reduce(function (s, w) { return s + w.count; }, 0) / totalWeeks) * 10,
        ) / 10
      : 0;

  // ── #149: Extraction accuracy (auto-accepted vs corrected) ─────────
  let totalItemCount = 0;
  let totalAutoAcceptedFields = 0;
  for (const s of allScans) {
    const itemCount = s.item_count ?? 0;
    const acc = s.accuracy_score ?? 0;
    totalItemCount += itemCount;
    totalAutoAcceptedFields += itemCount * acc;
  }
  const extractionAccuracyPct =
    totalItemCount > 0
      ? Math.round((totalAutoAcceptedFields / totalItemCount) * 100)
      : 0;

  const latestScanAccuracy =
    allScans.length > 0 && allScans[0].accuracy_score != null
      ? Math.round(allScans[0].accuracy_score * 100)
      : null;

  // Empty state
  if (allScans.length === 0 && items.length === 0) {
    return (
      <section>
        <header className="mb-xl">
          <h1 className="font-serif text-[28px] text-ink">Dashboard</h1>
          <p className="mt-xs text-[15px] text-ink-muted">
            {restaurantName}
          </p>
        </header>
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border-strong bg-surface-muted px-lg py-3xl text-center">
          <BarChart3
            className="mb-md h-10 w-10 text-ink-subtle"
            strokeWidth={1.5}
          />
          <p className="text-[15px] font-medium text-ink">
            Scan your first invoice to start tracking
          </p>
          <p className="mt-xs text-[13px] text-ink-muted">
            Your wine program metrics will appear here after your first scan.
          </p>
          <Link
            href="/scan"
            className="mt-lg flex h-[38px] items-center gap-sm rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover"
          >
            <ScanLine className="h-4 w-4" strokeWidth={2} />
            Go to scanner
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section>
      <header className="mb-lg md:mb-xl">
        <div className="flex flex-wrap items-center justify-between gap-md">
          <div>
            <h1 className="font-serif text-[28px] text-ink">Dashboard</h1>
            <p className="mt-xs text-[15px] text-ink-muted">
              {restaurantName}
            </p>
          </div>
          <a
            href="/api/insights/csv"
            download="insights-export.csv"
            className="flex h-[34px] items-center gap-xs rounded-sm border border-border-strong bg-white px-md text-[13px] font-medium text-ink hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0"
              aria-hidden="true"
            >
              <path d="M14 10v2.67A1.33 1.33 0 0 1 12.67 14H3.33A1.33 1.33 0 0 1 2 12.67V10" />
              <path d="M4.67 6.67L8 10l3.33-3.33" />
              <path d="M8 10V2" />
            </svg>
            Export CSV
          </a>
        </div>

        {/* Date range selector */}
        <div className="mt-md">
          <DateRangeSelector />
        </div>
      </header>

      <TodayStrip exceptions={todayExceptions} />

      {/* Drink-window watch */}
      {(drinkWindowAlerts.length > 0 || canEnrich) && (
        <section className="mb-lg md:mb-xl" aria-labelledby="dw-watch-heading">
          <div className="mb-md flex flex-wrap items-baseline justify-between gap-sm">
            <h2
              id="dw-watch-heading"
              className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent"
            >
              Drink-window watch
            </h2>
            <span className="text-[12px] text-ink-muted">
              {drinkWindowAlerts.length === 0
                ? "No alerts right now"
                : `${drinkWindowAlerts.length} alert${drinkWindowAlerts.length === 1 ? "" : "s"}`}
            </span>
          </div>
          {drinkWindowAlerts.length > 0 && (
            <div className="flex flex-col gap-md">
              {drinkWindowAlerts.map(function (alert) {
                return (
                  <BriefingAlertCard
                    key={alert.wine_id}
                    alert={alert}
                    firstName={firstName}
                  />
                );
              })}
            </div>
          )}
          {canEnrich && (
            <div className="mt-md flex flex-col items-start gap-md md:flex-row md:items-start">
              <EnrichCellarButton />
              <RefreshRetailButton />
            </div>
          )}
        </section>
      )}

      {/* BND-147 — Past drink window */}
      {pastDrinkWindowWines.length > 0 && (
        <section className="mb-lg md:mb-xl" aria-labelledby="past-dw-heading">
          <div className="mb-md flex flex-wrap items-baseline justify-between gap-sm">
            <h2
              id="past-dw-heading"
              className="text-[10px] font-semibold uppercase tracking-[0.08em] text-warning"
            >
              Past drink window
            </h2>
            <span className="text-[12px] text-ink-muted">
              {pastDrinkWindowWines.length} wine{pastDrinkWindowWines.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="rounded-md border border-border bg-surface p-lg">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                    <th scope="col" className="pb-sm text-left font-semibold">Wine</th>
                    <th scope="col" className="pb-sm text-right font-semibold">Vintage</th>
                    <th scope="col" className="pb-sm text-right font-semibold">Window ended</th>
                    <th scope="col" className="pb-sm text-right font-semibold">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {pastDrinkWindowWines.map(function (w, i) {
                    return (
                      <tr
                        key={w.wine_id}
                        data-metric={`past-drink-window-${w.wine_id}`}
                        className={`${i > 0 ? "border-t border-dashed border-border" : ""}`}
                      >
                        <td className="py-sm">
                          <Link
                            href={metricHref("wine", w.wine_id)}
                            className="font-medium text-ink hover:text-accent transition-colors"
                          >
                            {w.producer} {w.name}
                          </Link>
                          {w.bin_location && (
                            <div className="mt-0.5 text-[11px] text-ink-muted">
                              {w.bin_location}
                            </div>
                          )}
                        </td>
                        <td className="py-sm text-right font-mono text-ink-muted">
                          {w.vintage ?? "—"}
                        </td>
                        <td className="py-sm text-right font-mono text-ink">
                          {w.drink_window_end}
                        </td>
                        <td className="py-sm text-right font-mono text-ink">
                          {w.bottle_count}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Pricing review */}
      {pricingAlerts.length > 0 && (
        <section className="mb-lg md:mb-xl" aria-labelledby="pricing-review-heading">
          <div className="mb-md flex flex-wrap items-baseline justify-between gap-sm">
            <h2
              id="pricing-review-heading"
              className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent"
            >
              Pricing review
            </h2>
            <span className="text-[12px] text-ink-muted">
              {pricingAlerts.length} alert{pricingAlerts.length === 1 ? "" : "s"}
            </span>
          </div>
          <PricingReviewCard alerts={pricingAlerts} firstName={firstName} />
        </section>
      )}

      {/* Snoozed alerts */}
      {snoozedRows.length > 0 && (
        <section className="mb-lg md:mb-xl" aria-labelledby="snoozed-heading">
          <h2 id="snoozed-heading" className="sr-only">
            Snoozed alerts
          </h2>
          <SnoozedAlertsCard snoozed={snoozedRows} />
        </section>
      )}

      {/* Pour analytics (#144, #145, #146) */}
      <div className="mb-lg md:mb-xl">
        <PourAnalyticsSection />
      </div>

      <div className="grid gap-md md:grid-cols-2">
        {/* Hero metric */}
        <div className="rounded-md border border-border bg-surface p-lg md:col-span-2 md:grid md:grid-cols-2 md:gap-lg md:p-xl">
          <OwnerMetricGrid
            metrics={{
              inventoryValue,
              totalBottles,
              eightysixedCount,
              drinkNowCount,
            }}
          />

          {/* Sparkline — items per scan */}
          <div className="mt-lg md:mt-0">
            <div className="mb-sm flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              <span>Scan activity</span>
            </div>
            {allScans.length >= 2 ? (
              <Sparkline
                data={allScans
                  .slice(0, 12)
                  .reverse()
                  .map(function (s) { return { value: s.item_count, date: s.created_at }; })}
              />
            ) : (
              <div className="flex h-[100px] items-center justify-center text-[13px] text-ink-subtle">
                More data needed for trend
              </div>
            )}
          </div>
        </div>

        {/* BND-149 — Extraction accuracy KPI */}
        <div className="rounded-md border border-border bg-surface p-lg">
          <div className="mb-md flex items-center justify-between">
            <h3 className="text-[15px] font-semibold text-ink">
              Extraction accuracy
            </h3>
            <CheckCircle2
              className={`h-5 w-5 shrink-0 ${accuracyColor(extractionAccuracyPct)}`}
              strokeWidth={1.5}
            />
          </div>
          {allScans.length === 0 ? (
            <p className="text-[13px] text-ink-muted">No scans yet</p>
          ) : (
            <div>
              <div className="flex items-baseline gap-xs">
                <span
                  className={`font-mono text-[36px] font-medium leading-none tracking-[-0.02em] ${accuracyColor(extractionAccuracyPct)}`}
                >
                  {extractionAccuracyPct}%
                </span>
                <span className="text-[12px] text-ink-muted">
                  auto-accepted
                </span>
              </div>
              <p className="mt-sm text-[12px] text-ink-subtle">
                {totalItemCount} line items processed ·{" "}
                {Math.round(totalAutoAcceptedFields)} auto-accepted
              </p>
              {latestScanAccuracy !== null && (
                <div className="mt-md flex items-center gap-sm rounded-md bg-surface-muted px-sm py-sm">
                  <Activity className="h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.5} />
                  <span className="text-[12px] text-ink-muted">
                    Latest scan:{" "}
                    <span className={`font-mono font-medium ${accuracyColor(latestScanAccuracy)}`}>
                      {latestScanAccuracy}%
                    </span>{" "}
                    auto-accepted
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* BND-148 — Scan throughput */}
        <div className="rounded-md border border-border bg-surface p-lg">
          <div className="mb-md flex items-center justify-between">
            <h3 className="text-[15px] font-semibold text-ink">
              Scan throughput
            </h3>
            <History className="h-5 w-5 shrink-0 text-ink-subtle" strokeWidth={1.5} />
          </div>
          {throughputData.length === 0 ? (
            <p className="text-[13px] text-ink-muted">No scan data yet</p>
          ) : (
            <div>
              <div className="flex items-baseline gap-xs">
                <span className="font-mono text-[36px] font-medium leading-none tracking-[-0.02em] text-ink">
                  {avgScansPerWeek}
                </span>
                <span className="text-[12px] text-ink-muted">
                  scans / week avg
                </span>
              </div>
              <p className="mt-sm text-[12px] text-ink-subtle">
                {allScans.length} total scans · last {totalWeeks} week{totalWeeks === 1 ? "" : "s"}
              </p>
              <div className="mt-lg">
                <ThroughputBarChart data={throughputData} />
              </div>
            </div>
          )}
        </div>

        {/* Spend by varietal */}
        <div className="rounded-md border border-border bg-surface p-lg">
          <div className="mb-md flex items-center justify-between">
            <h3 className="text-[15px] font-semibold text-ink">
              Spend by varietal
            </h3>
            <span className="font-mono text-[12px] text-ink-subtle">
              {formatMoney(varietalTotalAll)} total
            </span>
          </div>
          {varietalBreakdown.length === 0 ? (
            <p className="text-[13px] text-ink-muted">No data yet</p>
          ) : (
            <>
              <div className="flex flex-col gap-sm">
                {varietalBreakdown.map(function (_a, i) {
                  const label = _a[0];
                  const spend = _a[1];
                  const pct = spend / varietalTotalAll;
                  return (
                    <div key={label} data-metric={`varietal-${label}`}>
                      <Link
                        href={metricHref("varietal", label)}
                        className="flex items-center gap-sm rounded-sm transition-colors hover:bg-surface-muted/50"
                      >
                        <span className="w-[100px] shrink-0 truncate text-[13px] text-ink">
                          {label}
                        </span>
                        <div className="h-2.5 flex-1 overflow-hidden rounded-pill bg-surface-sunken">
                          <div
                            className="h-full rounded-pill bg-accent"
                            style={{
                              width: `${pct * 100}%`,
                              opacity: 1 - i * 0.07,
                            }}
                          />
                        </div>
                        <span className="w-[36px] shrink-0 text-right font-mono text-[12px] text-ink-muted">
                          {Math.round(pct * 100)}%
                        </span>
                      </Link>
                    </div>
                  );
                })}
              </div>
              {otherVarietalCount > 0 && (
                <p className="mt-sm text-[12px] text-ink-subtle">
                  +{otherVarietalCount} more varietal
                  {otherVarietalCount === 1 ? "" : "s"}
                </p>
              )}
            </>
          )}
        </div>

        {/* Top distributors */}
        <div className="rounded-md border border-border bg-surface p-lg">
          <div className="mb-md flex items-center justify-between">
            <h3 className="text-[15px] font-semibold text-ink">
              Top distributors
            </h3>
          </div>
          {distributors.length === 0 ? (
            <p className="text-[13px] text-ink-muted">No scans yet</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  <th scope="col" className="pb-sm text-left font-semibold">Distributor</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Spend</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Share</th>
                  <th scope="col" className="pb-sm text-right font-semibold">Scans</th>
                </tr>
              </thead>
              <tbody>
                {distributors.map(function (_a, i) {
                  const name = _a[0];
                  const data = _a[1];
                  const pct = data.spend / distTotalSpend;
                  return (
                    <tr
                      key={name}
                      className="border-t border-dashed border-border"
                    >
                      <td className="py-sm">
                        <div className="font-medium text-ink">{name}</div>
                        <div className="mt-2xs h-1.5 overflow-hidden rounded-pill bg-surface-sunken">
                          <div
                            className="h-full rounded-pill bg-accent"
                            style={{
                              width: `${pct * 100}%`,
                              opacity: 1 - i * 0.07,
                            }}
                          />
                        </div>
                      </td>
                      <td className="py-sm text-right font-mono text-ink">
                        {formatMoney(data.spend)}
                      </td>
                      <td className="py-sm text-right font-mono text-ink-muted">
                        {Math.round(pct * 100)}%
                      </td>
                      <td className="py-sm text-right font-mono text-ink-muted">
                        {data.scans}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Recent activity */}
        <div className="rounded-md border border-border bg-surface p-lg md:col-span-2">
          <div className="mb-md flex items-center justify-between">
            <h3 className="text-[15px] font-semibold text-ink">
              Recent activity
            </h3>
          </div>
          {recentScans.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-md py-xl text-center">
              <ScanLine
                className="mb-sm h-8 w-8 text-ink-subtle"
                strokeWidth={1.5}
                aria-hidden
              />
              <p className="text-[14px] font-medium text-ink">
                No invoices scanned yet
              </p>
              <p className="mt-2xs text-[13px] text-ink-muted">
                Scan a distributor invoice to start tracking your activity.
              </p>
              <Link
                href="/scan"
                className="mt-md inline-flex h-[34px] items-center gap-xs rounded-sm bg-accent px-md text-[13px] font-medium text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
              >
                <ScanLine className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                Scan an invoice
              </Link>
            </div>
          ) : (
            <div>
              {recentScans.map(function (scan, i) {
                const relative = timeAgo(scan.created_at);
                const lineItems = (scan.final_line_items ?? []) as Array<{
                  qty?: number;
                  unitCost?: number;
                }>;
                const scanTotal = lineItems.reduce(
                  function (sum, it) { return sum + (it.qty ?? 0) * (it.unitCost ?? 0); },
                  0,
                );
                return (
                  <Link
                    key={scan.id}
                    href={`/scan/${scan.id}`}
                    aria-label={`View scan from ${scan.distributor_name}, ${scan.item_count} wines, ${formatMoney(scanTotal)}, ${relative}`}
                    className={`flex items-center gap-md rounded-sm py-sm transition-colors hover:bg-surface-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft ${i > 0 ? "border-t border-dashed border-border" : ""}`}
                  >
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-muted text-ink-muted">
                      <ScanLine className="h-4 w-4" strokeWidth={1.75} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium text-ink">
                        Invoice scanned
                      </div>
                      <div className="mt-2xs text-[13px] text-ink-muted">
                        {scan.distributor_name} · {scan.item_count} wines
                        {scanTotal > 0 && (
                          <>
                            {" · "}
                            <span className="font-mono">
                              {formatMoney(scanTotal)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    {scan.accuracy_score != null && (
                      <span
                        className={`font-mono text-[12px] ${accuracyColor(
                          Math.round(scan.accuracy_score * 100),
                        )}`}
                      >
                        {Math.round(scan.accuracy_score * 100)}%
                      </span>
                    )}
                    <TimeAgo
                      iso={scan.created_at}
                      className="shrink-0 font-mono text-[12px] text-ink-subtle"
                    />
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function buildTodayExceptions(
  drinkWindowAlerts: Awaited<ReturnType<typeof fetchDrinkWindowAlerts>>,
  pastDrinkWindowWines: PastDrinkWindowRow[],
  pricingAlerts: Awaited<ReturnType<typeof fetchPricingAlerts>>,
): TodayException[] {
  // Priority is intentional: stock at the end of its window, then stock
  // already past its window, then pricing outliers. All three feeds were
  // already loaded by Insights; duplicate wines are removed before the cap.
  const candidates: TodayException[] = [
    ...drinkWindowAlerts.map((alert) => ({
      wineId: alert.wine_id,
      kind: "drink-window" as const,
      title: `${alert.producer} ${alert.name}${alert.vintage ? ` ${alert.vintage}` : ""}`,
      detail: `${alert.bottle_count} bottle${alert.bottle_count === 1 ? "" : "s"} · window ends ${alert.drink_window_end ?? "soon"}`,
    })),
    ...pastDrinkWindowWines.map((wine) => ({
      wineId: wine.wine_id,
      kind: "past-window" as const,
      title: `${wine.producer} ${wine.name}${wine.vintage ? ` ${wine.vintage}` : ""}`,
      detail: `${wine.bottle_count} bottle${wine.bottle_count === 1 ? "" : "s"} · ended ${wine.drink_window_end ?? "earlier"}`,
    })),
    ...pricingAlerts.map((alert) => ({
      wineId: alert.wine_id,
      kind: "pricing" as const,
      title: `${alert.producer} ${alert.name}${alert.vintage ? ` ${alert.vintage}` : ""}`,
      detail: "Bottle or glass pricing is outside its target",
    })),
  ];
  return selectTodayExceptions(candidates);
}

async function fetchSnoozedAlerts(
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthContext>>>["supabase"],
  restaurantId: string,
): Promise<SnoozedRow[]> {
  const nowIso = new Date().toISOString();
  const { data: wines } = await supabase
    .from("wines")
    .select(
      "id, name, producer, vintage, alert_snoozed_until, pricing_dismissed_until",
    )
    .eq("restaurant_id", restaurantId)
    .or(
      `alert_snoozed_until.gt.${nowIso},pricing_dismissed_until.gt.${nowIso}`,
    );

  const rows: SnoozedRow[] = (wines ?? [])
    .map(function (w) {
      const dw = w.alert_snoozed_until;
      const pr = w.pricing_dismissed_until;
      const dwActive = dw && new Date(dw).getTime() > Date.now();
      const prActive = pr && new Date(pr).getTime() > Date.now();
      if (!dwActive && !prActive) return null;
      return {
        wine_id: w.id,
        name: w.name,
        producer: w.producer,
        vintage: w.vintage,
        drinkWindowSnoozedUntil: dwActive ? dw : null,
        pricingDismissedUntil: prActive ? pr : null,
      };
    })
    .filter(function (r): r is SnoozedRow { return r !== null; });

  rows.sort(function (a, b) {
    const aSoon = Math.min(
      a.drinkWindowSnoozedUntil
        ? new Date(a.drinkWindowSnoozedUntil).getTime()
        : Infinity,
      a.pricingDismissedUntil
        ? new Date(a.pricingDismissedUntil).getTime()
        : Infinity,
    );
    const bSoon = Math.min(
      b.drinkWindowSnoozedUntil
        ? new Date(b.drinkWindowSnoozedUntil).getTime()
        : Infinity,
      b.pricingDismissedUntil
        ? new Date(b.pricingDismissedUntil).getTime()
        : Infinity,
    );
    if (aSoon !== bSoon) return aSoon - bSoon;
    return a.producer.localeCompare(b.producer);
  });
  return rows;
}

function parseFirstName(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local.replace(/[._-]+/g, " ").split(" ")[0] ?? "";
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}
