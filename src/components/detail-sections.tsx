import type { TasteAxis } from "@/lib/wine-intelligence/xwines-profile";

// Shared building blocks for the wine detail surfaces — the cellar wine page
// (src/app/(app)/cellar/[wineId]/wine-detail-view.tsx) and the catalogue
// detail page (src/app/(app)/catalogue/[source]/[id]/catalogue-detail-view.tsx)
// render the same corpus facts, so the pieces live once, here. Extracted from
// wine-detail-view.tsx when the catalogue view became their second consumer
// (P1 slice 2b).

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-rule pt-xl mt-xl md:pt-2xl md:mt-2xl">
      <h2 className="mb-lg font-serif text-heading-sm text-ink">{title}</h2>
      {children}
    </section>
  );
}

export function Fact({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode | null;
}) {
  if (value === null || value === "") return null;
  return (
    <div className="flex items-baseline justify-between gap-md border-b border-rule py-md last:border-b-0 sm:odd:border-b">
      <dt className="text-caption uppercase text-grey">{label}</dt>
      <dd className="text-right text-body-sm text-ink">{value}</dd>
    </div>
  );
}

/**
 * A taste axis. The corpus's own word for the value is shown alongside the bar
 * so the position is never the only claim being made — a reader who distrusts
 * a bar can still read "Very full-bodied".
 */
export function AxisBar({ axis }: { axis: TasteAxis }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-caption uppercase text-grey">
        <span>{axis.low}</span>
        <span className="text-ink-soft">{axis.label}</span>
        <span>{axis.high}</span>
      </div>
      <div
        className="mt-sm h-1.5 rounded-pill bg-surface-sunken"
        role="img"
        aria-label={`${axis.label}, between ${axis.low} and ${axis.high}`}
      >
        <div
          className="h-full rounded-pill bg-primary"
          style={{ width: `${Math.round(axis.position * 100)}%` }}
        />
      </div>
    </div>
  );
}

export function CommunityRating({ avg, count }: { avg: number; count: number }) {
  return (
    <div className="flex items-baseline gap-sm">
      <span className="font-serif text-heading text-ink">{avg.toFixed(1)}</span>
      <span className="text-body-sm text-grey">
        from {count.toLocaleString()} ratings
      </span>
    </div>
  );
}
