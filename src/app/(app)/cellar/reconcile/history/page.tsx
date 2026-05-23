import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, History, TrendingDown, TrendingUp, BarChart3 } from "lucide-react";
import { getAuthContext } from "@/lib/auth-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Reconcile History — Terroir" };

type ReconEvent = {
  id: string;
  created_at: string;
  delta: number | null;
  note: string | null;
  user_id: string | null;
  wine_id: string;
  wines: {
    producer: string;
    name: string;
    vintage: number | null;
  } | null;
};

type DailySummary = {
  date: string;
  displayDate: string;
  totalVarianceMl: number;
  eventCount: number;
  sessions: ReconSession[];
};

type ReconSession = {
  timeLabel: string;
  events: ReconEvent[];
  totalVarianceMl: number;
  bottleCount: number;
};

function formatDateHeader(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatOz(ml: number): string {
  const oz = Math.abs(ml) / 29.5735;
  return oz.toFixed(1) + " oz";
}

/**
 * Group reconciliation events into daily summaries and sessions.
 * Events within 10 minutes of each other are considered the same session.
 */
function buildHistory(events: ReconEvent[]): DailySummary[] {
  if (events.length === 0) return [];

  const SESSION_GAP_MS = 10 * 60 * 1000; // 10 minutes

  // Group by date first
  const byDate = new Map<string, ReconEvent[]>();
  for (const e of events) {
    const dateKey = e.created_at.slice(0, 10); // YYYY-MM-DD
    const arr = byDate.get(dateKey) || [];
    arr.push(e);
    byDate.set(dateKey, arr);
  }

  const dailySummaries: DailySummary[] = [];

  for (const [dateKey, dayEvents] of byDate) {
    // Sort by created_at ascending within the day
    dayEvents.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    // Split into sessions (events within 10 min of each other)
    const sessions: ReconSession[] = [];
    let currentSession: ReconEvent[] = [dayEvents[0]];

    for (let i = 1; i < dayEvents.length; i++) {
      const prev = new Date(dayEvents[i - 1].created_at).getTime();
      const curr = new Date(dayEvents[i].created_at).getTime();
      if (curr - prev <= SESSION_GAP_MS) {
        currentSession.push(dayEvents[i]);
      } else {
        sessions.push(buildSession(currentSession));
        currentSession = [dayEvents[i]];
      }
    }
    sessions.push(buildSession(currentSession));

    const totalVarianceMl = sessions.reduce(
      (sum, s) => sum + Math.abs(s.totalVarianceMl),
      0,
    );

    dailySummaries.push({
      date: dateKey,
      displayDate: formatDateHeader(dayEvents[0].created_at),
      totalVarianceMl,
      eventCount: dayEvents.length,
      sessions,
    });
  }

  // Sort newest first
  dailySummaries.sort((a, b) => b.date.localeCompare(a.date));

  return dailySummaries;
}

function buildSession(events: ReconEvent[]): ReconSession {
  const totalVarianceMl = events.reduce(
    (sum, e) => sum + (e.delta ?? 0),
    0,
  );
  return {
    timeLabel: formatTime(events[0].created_at),
    events,
    totalVarianceMl,
    bottleCount: events.length,
  };
}

/**
 * Simple CSS bar chart for variance trend over time.
 * Each bar represents one day; height is proportional to max variance.
 */
function VarianceChart({ dailySummaries }: { dailySummaries: DailySummary[] }) {
  if (dailySummaries.length === 0) return null;

  // Chart shows oldest→newest (left→right), so reverse
  const chartData = [...dailySummaries].reverse();
  const maxVariance = Math.max(
    ...chartData.map((d) => d.totalVarianceMl),
    1,
  );

  return (
    <div className="mb-xl rounded-md border border-border bg-surface p-lg">
      <h2 className="mb-md flex items-center gap-xs font-serif text-[18px] text-ink">
        <BarChart3 className="h-5 w-5 text-ink-subtle" strokeWidth={1.5} />
        Variance trend
      </h2>
      <div className="flex items-end gap-xs" style={{ height: "120px" }}>
        {chartData.map((day) => {
          const pct = (day.totalVarianceMl / maxVariance) * 100;
          return (
            <div
              key={day.date}
              className="flex flex-1 flex-col items-center justify-end"
              style={{ height: "100%" }}
            >
              <span className="mb-xs font-mono text-[10px] text-ink-subtle tabular-nums">
                {formatOz(day.totalVarianceMl)}
              </span>
              <div
                className="w-full max-w-[40px] rounded-t-sm bg-accent/70 transition-colors hover:bg-accent"
                style={{ height: `${Math.max(pct, 4)}%` }}
                title={`${day.displayDate}: ${formatOz(day.totalVarianceMl)}`}
              />
              <span className="mt-xs font-mono text-[9px] text-ink-subtle leading-tight text-center">
                {new Date(day.date + "T12:00:00").toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default async function ReconcileHistoryPage() {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");

  const { supabase, restaurantId, userRole } = auth;

  // Role gate: manager or owner only
  if (userRole !== "owner" && userRole !== "manager") {
    redirect("/cellar");
  }

  // Fetch reconciliation events with wine details
  const { data: events } = await supabase
    .from("availability_events")
    .select("id, created_at, delta, note, user_id, wine_id, wines(producer, name, vintage)")
    .eq("restaurant_id", restaurantId)
    .eq("direction", "reconcile")
    .order("created_at", { ascending: false })
    .limit(500);

  const history = buildHistory((events ?? []) as unknown as ReconEvent[]);

  return (
    <section>
      <header className="mb-lg flex items-center gap-sm">
        <Link
          href="/cellar/reconcile"
          className="flex h-[44px] w-[44px] items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted transition-colors"
          aria-label="Back to reconcile"
        >
          <ArrowLeft className="h-5 w-5" strokeWidth={2} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-[28px] text-ink">Reconcile History</h1>
          <p className="text-[12px] text-ink-muted tabular">
            {history.length > 0
              ? `${history.length} day${history.length === 1 ? "" : "s"} of reconciliation data`
              : "No reconciliation history yet"}
          </p>
        </div>
      </header>

      {history.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border-strong bg-surface-muted px-lg py-3xl text-center">
          <History className="mb-md h-10 w-10 text-ink-subtle" strokeWidth={1.5} />
          <p className="text-[15px] font-medium text-ink">
            No reconciliation history yet
          </p>
          <p className="mt-xs text-[13px] text-ink-muted">
            History will appear here after you run your first end-of-shift
            reconciliation.
          </p>
          <Link
            href="/cellar/reconcile"
            className="mt-lg flex h-[38px] items-center gap-sm rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover"
          >
            Go to reconcile
          </Link>
        </div>
      ) : (
        <>
          {/* Variance chart */}
          <VarianceChart dailySummaries={history} />

          {/* Summary cards */}
          <div className="mb-lg grid grid-cols-1 gap-sm sm:grid-cols-3">
            <div className="rounded-md border border-border bg-surface p-md">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Total sessions
              </div>
              <div className="mt-xs font-mono text-[20px] font-medium text-ink">
                {history.reduce((sum, d) => sum + d.sessions.length, 0)}
              </div>
            </div>
            <div className="rounded-md border border-border bg-surface p-md">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Bottles reconciled
              </div>
              <div className="mt-xs font-mono text-[20px] font-medium text-ink">
                {history.reduce((sum, d) => sum + d.eventCount, 0)}
              </div>
            </div>
            <div className="rounded-md border border-border bg-surface p-md">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Total variance
              </div>
              <div className="mt-xs font-mono text-[20px] font-medium text-ink">
                {formatOz(history.reduce((sum, d) => sum + d.totalVarianceMl, 0))}
              </div>
            </div>
          </div>

          {/* Daily history */}
          <div className="flex flex-col gap-lg">
            {history.map((day) => (
              <div key={day.date}>
                <h2 className="mb-md flex items-center gap-xs font-serif text-[16px] text-ink">
                  <span className="inline-block h-[6px] w-[6px] rounded-full bg-accent" />
                  {day.displayDate}
                  <span className="font-mono text-[12px] text-ink-subtle">
                    · {day.sessions.length} session
                    {day.sessions.length !== 1 ? "s" : ""}
                    {" · "}
                    {formatOz(day.totalVarianceMl)} variance
                  </span>
                </h2>

                <div className="flex flex-col gap-md">
                  {day.sessions.map((session, si) => {
                    const wineCount = session.bottleCount;
                    const isOverpour = session.totalVarianceMl > 0;
                    const isUnderpour = session.totalVarianceMl < 0;

                    return (
                      <div
                        key={`${day.date}-${si}`}
                        className="rounded-md border border-border bg-white"
                      >
                        {/* Session header */}
                        <div className="flex items-center justify-between border-b border-border px-md py-sm">
                          <span className="font-mono text-[13px] font-medium text-ink tabular-nums">
                            {session.timeLabel}
                          </span>
                          <div className="flex items-center gap-sm">
                            <span className="text-[12px] text-ink-muted tabular-nums">
                              {wineCount} bottle{wineCount !== 1 ? "s" : ""}
                            </span>
                            {isOverpour && (
                              <span className="inline-flex items-center gap-xs rounded-pill bg-warning-soft px-sm py-2xs text-[11px] font-semibold text-warning">
                                <TrendingUp className="h-3 w-3" strokeWidth={2.5} />
                                +{formatOz(session.totalVarianceMl)}
                              </span>
                            )}
                            {isUnderpour && (
                              <span className="inline-flex items-center gap-xs rounded-pill bg-success-soft px-sm py-2xs text-[11px] font-semibold text-success">
                                <TrendingDown className="h-3 w-3" strokeWidth={2.5} />
                                −{formatOz(session.totalVarianceMl)}
                              </span>
                            )}
                            {!isOverpour && !isUnderpour && (
                              <span className="inline-flex items-center gap-xs rounded-pill bg-surface-muted px-sm py-2xs text-[11px] font-semibold text-ink-subtle">
                                0 oz
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Session wines — desktop table */}
                        <div className="hidden md:block">
                          <table className="w-full text-[13px]">
                            <thead>
                              <tr className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                                <th scope="col" className="px-md py-sm text-left font-semibold">
                                  Wine
                                </th>
                                <th scope="col" className="px-md py-sm text-right font-semibold">
                                  Variance
                                </th>
                                <th scope="col" className="px-md py-sm text-left font-semibold">
                                  Note
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {session.events.map((event) => (
                                <tr
                                  key={event.id}
                                  className="border-t border-dashed border-border"
                                >
                                  <td className="px-md py-sm">
                                    {event.wines ? (
                                      <Link
                                        href={`/cellar?wine=${event.wine_id}`}
                                        className="group rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                                      >
                                        <span className="font-medium text-ink group-hover:text-accent">
                                          {event.wines.producer}
                                        </span>
                                        <span className="text-ink-muted group-hover:text-accent">
                                          {" "}
                                          {event.wines.name}
                                          {event.wines.vintage
                                            ? ` ${event.wines.vintage}`
                                            : ""}
                                        </span>
                                      </Link>
                                    ) : (
                                      <span className="text-ink-muted">Unknown wine</span>
                                    )}
                                  </td>
                                  <td className="px-md py-sm text-right font-mono tabular-nums">
                                    {event.delta != null ? (
                                      <span
                                        className={
                                          event.delta > 0
                                            ? "text-warning"
                                            : event.delta < 0
                                              ? "text-success"
                                              : "text-ink-subtle"
                                        }
                                      >
                                        {event.delta > 0 ? "+" : ""}
                                        {formatOz(event.delta)}
                                      </span>
                                    ) : (
                                      <span className="text-ink-subtle">—</span>
                                    )}
                                  </td>
                                  <td className="px-md py-sm text-ink-muted">
                                    {event.note || "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Session wines — mobile cards */}
                        <div className="flex flex-col md:hidden">
                          {session.events.map((event) => (
                            <div
                              key={event.id}
                              className="flex items-center justify-between border-t border-dashed border-border px-md py-sm"
                            >
                              <div className="min-w-0 flex-1">
                                {event.wines ? (
                                  <Link
                                    href={`/cellar?wine=${event.wine_id}`}
                                    className="group rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                                  >
                                    <div className="truncate text-[13px] font-medium text-ink group-hover:text-accent">
                                      {event.wines.producer} {event.wines.name}
                                    </div>
                                    {event.wines.vintage && (
                                      <div className="font-mono text-[11px] text-ink-subtle">
                                        {event.wines.vintage}
                                      </div>
                                    )}
                                  </Link>
                                ) : (
                                  <span className="text-[13px] text-ink-muted">
                                    Unknown wine
                                  </span>
                                )}
                                {event.note && (
                                  <div className="mt-2xs truncate text-[11px] text-ink-subtle">
                                    {event.note}
                                  </div>
                                )}
                              </div>
                              <span
                                className={`ml-sm shrink-0 font-mono text-[13px] font-medium tabular-nums ${
                                  (event.delta ?? 0) > 0
                                    ? "text-warning"
                                    : (event.delta ?? 0) < 0
                                      ? "text-success"
                                      : "text-ink-subtle"
                                }`}
                              >
                                {event.delta != null
                                  ? `${event.delta > 0 ? "+" : ""}${formatOz(event.delta)}`
                                  : "—"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
