import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { metricHref, type MetricKey } from "./metric-href";

export type OwnerMetrics = {
  inventoryValue: number;
  totalBottles: number;
  eightysixedCount: number;
  drinkNowCount: number;
};

export type TodayException = {
  wineId: string;
  kind: "drink-window" | "past-window" | "pricing";
  title: string;
  detail: string;
};

export function selectTodayExceptions(
  candidates: TodayException[],
): TodayException[] {
  const selected: TodayException[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.wineId)) continue;
    selected.push(candidate);
    seen.add(candidate.wineId);
    if (selected.length === 3) break;
  }
  return selected;
}

export function TodayStrip({ exceptions }: { exceptions: TodayException[] }) {
  if (exceptions.length === 0) return null;

  return (
    <section className="mb-lg md:mb-xl" aria-labelledby="today-heading">
      <div className="mb-sm flex items-baseline justify-between gap-sm">
        <h2
          id="today-heading"
          className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent"
        >
          Today
        </h2>
        <span className="text-[12px] text-ink-muted">Most actionable</span>
      </div>
      <ul className="grid gap-sm md:grid-cols-3">
        {exceptions.map((exception) => (
          <li
            key={`${exception.kind}:${exception.wineId}`}
            data-metric={`today-${exception.kind}-${exception.wineId}`}
          >
            <Link
              href={metricHref("wine", exception.wineId)}
              className="group flex h-full items-start justify-between gap-md rounded-md border border-border bg-surface p-md transition-colors hover:border-border-strong hover:bg-surface-muted"
            >
              <span className="min-w-0">
                <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-warning">
                  {exceptionLabel(exception.kind)}
                </span>
                <span className="mt-xs block truncate text-[14px] font-medium text-ink">
                  {exception.title}
                </span>
                <span className="mt-2xs block text-[12px] text-ink-muted">
                  {exception.detail}
                </span>
              </span>
              <ArrowUpRight
                className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle transition-colors group-hover:text-accent"
                strokeWidth={1.75}
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function OwnerMetricGrid({ metrics }: { metrics: OwnerMetrics }) {
  const items: Array<{
    key: Exclude<MetricKey, "varietal" | "wine">;
    label: string;
    value: string;
  }> = [
    {
      key: "inventory-value",
      label: "Inventory value",
      value: formatMoney(metrics.inventoryValue),
    },
    {
      key: "bottles-in",
      label: "Bottles in",
      value: metrics.totalBottles.toLocaleString("en-US"),
    },
    {
      key: "eightysixed-count",
      label: "86'd",
      value: metrics.eightysixedCount.toLocaleString("en-US"),
    },
    {
      key: "drink-now-count",
      label: "Drink now",
      value: metrics.drinkNowCount.toLocaleString("en-US"),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-sm md:gap-md">
      {items.map((item) => (
        <div key={item.key} data-metric={item.key}>
          <Link
            href={metricHref(item.key)}
            className="group block rounded-md border border-transparent p-sm transition-colors hover:border-border hover:bg-surface-muted"
          >
            <span className="flex items-center gap-xs text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              {item.label}
              <ArrowUpRight
                className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                strokeWidth={2}
                aria-hidden
              />
            </span>
            <span className="mt-xs block font-mono text-[26px] font-medium leading-none tracking-[-0.03em] text-ink md:text-[34px]">
              {item.value}
            </span>
          </Link>
        </div>
      ))}
    </div>
  );
}

function exceptionLabel(kind: TodayException["kind"]): string {
  switch (kind) {
    case "drink-window":
      return "Window closing";
    case "past-window":
      return "Past window";
    case "pricing":
      return "Pricing review";
  }
}

function formatMoney(value: number): string {
  return "$" + value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
