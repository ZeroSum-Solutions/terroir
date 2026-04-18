import { createClient } from "@/lib/supabase/server";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  ListOrdered,
  ScanLine,
} from "lucide-react";
import Link from "next/link";

function formatMoney(n: number) {
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const width = 440;
  const height = 100;
  const pad = 6;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * w;
    const y = pad + (1 - (v - min) / range) * h;
    return [x, y] as [number, number];
  });

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`)
    .join(" ");

  const last = points[points.length - 1];
  const first = points[0];
  const areaPath = `${path} L ${last[0].toFixed(1)},${height - pad} L ${first[0].toFixed(1)},${height - pad} Z`;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
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
      <circle
        cx={last[0]}
        cy={last[1]}
        r="4"
        fill="var(--color-accent)"
        stroke="var(--color-surface)"
        strokeWidth="2"
      />
    </svg>
  );
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: membership } = await supabase
    .from("memberships")
    .select("restaurant_id, restaurants(name)")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership) return null;

  const rid = membership.restaurant_id;
  const restaurantName =
    (membership.restaurants as { name: string } | null)?.name ?? "My Restaurant";

  // Get this month's aggregates
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { data: scans } = await supabase
    .from("invoice_scans")
    .select("id, distributor_name, item_count, accuracy_score, created_at")
    .eq("restaurant_id", rid)
    .order("created_at", { ascending: false });

  const allScans = scans ?? [];

  // This month's scans
  const monthScans = allScans.filter(
    (s) => new Date(s.created_at) >= startOfMonth,
  );

  // Get inventory items for aggregation
  const { data: inventoryItems } = await supabase
    .from("inventory_items")
    .select("quantity, unit_cost, wine_id, wines(varietal)")
    .eq("restaurant_id", rid);

  const items = inventoryItems ?? [];

  // Compute metrics
  const monthlySpend = items.reduce((s, i) => s + i.quantity * i.unit_cost, 0);
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

  // Distributor breakdown
  const distMap = new Map<string, { scans: number; spend: number }>();
  for (const scan of allScans) {
    const existing = distMap.get(scan.distributor_name) ?? { scans: 0, spend: 0 };
    existing.scans += 1;
    distMap.set(scan.distributor_name, existing);
  }
  // Add spend per distributor from inventory
  // For now, just show scan counts
  const distributors = [...distMap.entries()]
    .sort((a, b) => b[1].scans - a[1].scans)
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
            href="/scanner"
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

      <div className="grid gap-md md:grid-cols-2">
        {/* Hero metric — spans both columns */}
        <div className="rounded-md border border-border bg-surface p-lg md:col-span-2 md:grid md:grid-cols-2 md:gap-lg md:p-xl">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              Monthly spend
            </div>
            <div className="mt-sm font-mono text-[48px] font-medium leading-none tracking-[-0.04em] text-ink md:text-[72px]">
              {formatMoney(monthlySpend)}
            </div>
            <div className="mt-sm flex items-center gap-md">
              <span className="inline-flex items-center gap-xs rounded-pill bg-success-soft px-sm py-xs text-[12px] font-medium text-success">
                <ArrowDown className="h-3 w-3" strokeWidth={2.5} />
                this month
              </span>
              <span className="text-[13px] text-ink-muted">
                {scanCount} scans
              </span>
            </div>

            <div className="mt-lg grid grid-cols-3 gap-md">
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

          {/* Sparkline — monthly spend over time (placeholder with scan-count data) */}
          <div className="mt-lg md:mt-0">
            <div className="mb-sm flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              <span>Scan activity</span>
            </div>
            {allScans.length >= 2 ? (
              <Sparkline
                data={allScans
                  .slice(0, 12)
                  .reverse()
                  .map((s) => s.item_count)}
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
                  <th scope="col" className="pb-sm text-right font-semibold">Scans</th>
                </tr>
              </thead>
              <tbody>
                {distributors.map(([name, data]) => (
                  <tr
                    key={name}
                    className="border-t border-dashed border-border"
                  >
                    <td className="py-sm font-medium text-ink">{name}</td>
                    <td className="py-sm text-right font-mono text-ink-muted">
                      {data.scans}
                    </td>
                  </tr>
                ))}
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
                const timeAgo = getTimeAgo(scan.created_at);
                return (
                  <div
                    key={scan.id}
                    className={`flex items-center gap-md py-sm ${i > 0 ? "border-t border-dashed border-border" : ""}`}
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
                      </div>
                    </div>
                    {scan.accuracy_score != null && (
                      <span className="font-mono text-[12px] text-success">
                        {Math.round(scan.accuracy_score * 100)}%
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-[12px] text-ink-subtle">
                      {timeAgo}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function getTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
