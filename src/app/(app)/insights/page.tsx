import { getAuthContext } from "@/lib/auth-context";
import { BarChart3, ScanLine } from "lucide-react";
import Link from "next/link";
import { fetchDrinkWindowAlerts } from "@/lib/drink-window/alerts";
import { fetchPricingAlerts } from "@/lib/pricing/alerts";
import { accuracyColor } from "@/lib/scanner/accuracy-color";
import { timeAgo } from "@/lib/time";
import { TimeAgo } from "@/components/time-ago";
import { BriefingAlertCard } from "./briefing-alert-card";
import { EnrichCellarButton } from "./enrich-cellar-button";
import { RefreshRetailButton } from "./refresh-retail-button";
import { PricingReviewCard } from "./pricing-review-card";
import { SnoozedAlertsCard, type SnoozedRow } from "./snoozed-alerts-card";

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

  // Accessible summary: range + last value so screen-reader users get
  // the same signal sighted users get from the chart shape.
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
      {/* Per-point hit targets. The visible circle is small; the
          transparent overlay is wider so hover/touch picks up easily
          even on dense charts. SVG <title> renders as a native
          browser tooltip without extra JS. */}
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

export default async function DashboardPage() {
  const auth = (await getAuthContext())!; // AppLayout redirects when null
  const { supabase, restaurantId: rid, restaurantName, user, userRole } = auth;

  // BND-039 + BND-040 — alerts pipelines. Fetch in parallel with the
  // Dashboard aggregates below; alerts render above the metric cards.
  // Pricing alerts gracefully return [] when no retail data is enriched
  // yet (operator hasn't clicked the Refresh retail button).
  const [drinkWindowAlerts, pricingAlerts, snoozedRows] = await Promise.all([
    fetchDrinkWindowAlerts(supabase, rid),
    fetchPricingAlerts(supabase, rid).catch(() => []),
    fetchSnoozedAlerts(supabase, rid).catch(() => [] as SnoozedRow[]),
  ]);
  const firstName = parseFirstName(user.email ?? "") || "there";
  const canEnrich = userRole === "owner" || userRole === "manager";

  // Get this month's aggregates
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  // Fetch all data in parallel instead of sequentially
  const [{ data: scans }, { data: inventoryItems }, { data: scanItems }] =
    await Promise.all([
      supabase
        .from("invoice_scans")
        .select(
          "id, distributor_name, item_count, accuracy_score, created_at, final_line_items",
        )
        .eq("restaurant_id", rid)
        .order("created_at", { ascending: false }),
      supabase
        .from("inventory_items")
        .select("quantity, unit_cost, wine_id, wines(varietal)")
        .eq("restaurant_id", rid),
      supabase
        .from("inventory_items")
        .select("quantity, unit_cost, invoice_scan_id, invoice_scans!inner(distributor_name)")
        .eq("restaurant_id", rid),
    ]);

  const allScans = scans ?? [];
  const items = inventoryItems ?? [];

  // This month's scans
  const monthScans = allScans.filter(
    (s) => new Date(s.created_at) >= startOfMonth,
  );

  // Compute metrics. The hero shows total inventory value at current
  // cost (spec §insights_and_analytics — "System shows total inventory
  // value at current cost"), so this sums quantity × unit_cost across
  // every item still on hand. `scanCount` is the per-month activity
  // counter shown beneath the hero.
  const inventoryValue = items.reduce((s, i) => s + i.quantity * i.unit_cost, 0);
  const totalBottles = items.reduce((s, i) => s + i.quantity, 0);
  const scanCount = monthScans.length;

  // Varietal breakdown
  const varietalMap = new Map<string, number>();
  for (const item of items) {
    const varietal =
      (item.wines as { varietal: string | null } | null)?.varietal ?? "Other";
    varietalMap.set(varietal, (varietalMap.get(varietal) ?? 0) + item.quantity * item.unit_cost);
  }
  const varietalBreakdown = [...varietalMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const varietalTotal = varietalBreakdown.reduce((s, [, v]) => s + v, 0) || 1;

  // Distributor breakdown — spend from inventory items linked via invoice scans
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

  // Whole-program distributor spend (across all distributors, not just
  // the top-5 slice below) so each row's % reflects share-of-program,
  // not share-of-top-5. Floored at 1 to avoid divide-by-zero.
  const distTotalSpend =
    [...distMap.values()].reduce((s, d) => s + d.spend, 0) || 1;

  const distributors = [...distMap.entries()]
    .sort((a, b) => b[1].spend - a[1].spend)
    .slice(0, 5);

  // Recent activity from scans
  const recentScans = allScans.slice(0, 5);

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
        <h1 className="font-serif text-[28px] text-ink">Dashboard</h1>
        <p className="mt-xs text-[15px] text-ink-muted">
          {restaurantName}
        </p>
      </header>

      {/* BND-039 — Drink-window watch. Renders above the spend metrics
          when there are active alerts OR the user can enrich (so they
          can populate the data even when no alerts exist). */}
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
              {drinkWindowAlerts.map((alert) => (
                <BriefingAlertCard
                  key={alert.wine_id}
                  alert={alert}
                  firstName={firstName}
                />
              ))}
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

      {/* BND-040 — Pricing review section. Renders only when there are
          alerts. Sits below drink-window watch since drink-window is the
          time-urgent signal; pricing is a "worth a review" signal. */}
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

      {/* BND-040 follow-up — snoozed-alerts viewer. Audit-finding M2.
          Renders only when there are active snoozes. Collapsed-by-default
          card lets operators unsnooze early. */}
      {snoozedRows.length > 0 && (
        <section className="mb-lg md:mb-xl" aria-labelledby="snoozed-heading">
          <h2
            id="snoozed-heading"
            className="sr-only"
          >
            Snoozed alerts
          </h2>
          <SnoozedAlertsCard snoozed={snoozedRows} />
        </section>
      )}

      <div className="grid gap-md md:grid-cols-2">
        {/* Hero metric — spans both columns */}
        <div className="rounded-md border border-border bg-surface p-lg md:col-span-2 md:grid md:grid-cols-2 md:gap-lg md:p-xl">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              Inventory value
            </div>
            <div className="mt-sm font-mono text-[48px] font-medium leading-none tracking-[-0.04em] text-ink md:text-[72px]">
              {formatMoney(inventoryValue)}
            </div>
            <div className="mt-sm text-[13px] text-ink-muted">
              at current cost · {scanCount} scan{scanCount === 1 ? "" : "s"}{" "}
              this month
            </div>

            <div className="mt-lg grid grid-cols-3 gap-sm md:gap-md">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  Bottles in
                </div>
                <div className="mt-xs font-mono text-[20px] font-medium text-ink">
                  {totalBottles}
                </div>
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  Scans
                </div>
                <div className="mt-xs font-mono text-[20px] font-medium text-ink">
                  {scanCount}
                </div>
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  Avg accuracy
                </div>
                <div className="mt-xs font-mono text-[20px] font-medium text-ink">
                  {allScans.length > 0
                    ? `${Math.round(
                        (allScans.reduce(
                          (s, sc) => s + (sc.accuracy_score ?? 0),
                          0,
                        ) /
                          allScans.length) *
                          100,
                      )}%`
                    : "—"}
                </div>
              </div>
            </div>
          </div>

          {/* Sparkline — items per scan (recent 12 scans) */}
          <div className="mt-lg md:mt-0">
            <div className="mb-sm flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              <span>Scan activity</span>
            </div>
            {allScans.length >= 2 ? (
              <Sparkline
                data={allScans
                  .slice(0, 12)
                  .reverse()
                  .map((s) => ({ value: s.item_count, date: s.created_at }))}
              />
            ) : (
              <div className="flex h-[100px] items-center justify-center text-[13px] text-ink-subtle">
                More data needed for trend
              </div>
            )}
          </div>
        </div>

        {/* Spend by varietal */}
        <div className="rounded-md border border-border bg-surface p-lg">
          <div className="mb-md flex items-center justify-between">
            <h3 className="text-[15px] font-semibold text-ink">
              Spend by varietal
            </h3>
            <span className="font-mono text-[12px] text-ink-subtle">
              {formatMoney(varietalTotal)} total
            </span>
          </div>
          {varietalBreakdown.length === 0 ? (
            <p className="text-[13px] text-ink-muted">No data yet</p>
          ) : (
            <div className="flex flex-col gap-sm">
              {varietalBreakdown.map(([label, spend], i) => {
                const pct = spend / varietalTotal;
                return (
                  <div key={label} className="flex items-center gap-sm">
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
                  </div>
                );
              })}
            </div>
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
                {distributors.map(([name, data], i) => {
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
            <p className="text-[13px] text-ink-muted">No activity yet</p>
          ) : (
            <div>
              {recentScans.map((scan, i) => {
                const relative = timeAgo(scan.created_at);
                const lineItems = (scan.final_line_items ?? []) as Array<{
                  qty?: number;
                  unitCost?: number;
                }>;
                const scanTotal = lineItems.reduce(
                  (sum, it) => sum + (it.qty ?? 0) * (it.unitCost ?? 0),
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

// BND-039 — drink-window alerts pipeline lives in
// @/lib/drink-window/alerts (shared with /api/insights/drink-window-alerts).
// Code-quality-review finding 5: a local copy here was bound to drift.

/**
 * BND-040 follow-up — server-side fetch for currently-snoozed wines.
 * Mirrors the API route at /api/insights/snoozed but inline so the
 * server component doesn't have to do an extra round-trip.
 *
 * "Active snooze" = column non-null AND in the future. Past
 * timestamps mean the snooze already expired; the alert reappears
 * naturally without needing a list entry.
 */
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
    .map((w) => {
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
    .filter((r): r is SnoozedRow => r !== null);

  rows.sort((a, b) => {
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
  // Best-effort first name from email local-part. "devin@example.com" → "Devin"
  // Falls back to empty string for non-name-shaped emails.
  const local = email.split("@")[0] ?? "";
  const cleaned = local.replace(/[._-]+/g, " ").split(" ")[0] ?? "";
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

