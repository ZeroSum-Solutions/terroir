/**
 * BND-039 — DrinkWindowTimeline
 *
 * Reusable 3-zone horizontal timeline visual for the drink-window
 * intelligence feature. Shipped in:
 *   • Cellar wine-detail drawer (size="full")
 *   • Cellar list row indicator (size="mini")
 *   • Insights briefing alert card (size="full" or "mini")
 *
 * Tokens match DESIGN.md verbatim. Bordeaux #722F37 marker on a
 * 3-zone gradient track (Hold cool grey → Optimal warm cream/amber →
 * Past peak faded brown). The gradient is the same in every size —
 * the size prop adjusts axis labels and zone labels but not visuals.
 *
 * Returns null when no window is known (start || end is null).
 * Callers should conditionally render the parent section.
 *
 * Pure presentational, no client-side interactivity. CSS-only — no JS,
 * respects `prefers-reduced-motion` (no transitions to animate anyway).
 */

import { getMarkerPosition } from "@/lib/drink-window/status";

export type DrinkWindowTimelineSize = "mini" | "full";

export function DrinkWindowTimeline({
  start,
  end,
  currentYear = new Date().getFullYear(),
  size = "full",
  showAxis = true,
  showZoneLabel = true,
}: {
  start: number | null;
  end: number | null;
  currentYear?: number;
  size?: DrinkWindowTimelineSize;
  showAxis?: boolean;
  showZoneLabel?: boolean;
}) {
  if (start == null || end == null) return null;

  const markerPct = getMarkerPosition(start, end, currentYear);
  const isMini = size === "mini";

  // Heights tuned to mock proportions:
  //   mini: total 40px wrapper, 4px track, marker height 8px
  //   full: total 88px wrapper, 14px track, marker height 30px
  const trackHeight = isMini ? "h-[4px]" : "h-[14px]";
  const wrapperHeight = isMini ? "h-[40px]" : "h-[88px]";
  const trackTopOffset = isMini ? "top-[14px]" : "top-[32px]";
  const markerTopOffset = isMini ? "top-[10px]" : "top-[24px]";
  const markerHeight = isMini ? "h-[8px]" : "h-[30px]";
  const markerLabelTop = isMini ? "top-[24px]" : "top-[64px]";
  const axisFontSize = isMini ? "text-[10px]" : "text-[10px]";

  return (
    <div className={`relative w-full ${wrapperHeight}`} aria-hidden>
      {/* Axis labels */}
      {showAxis && (
        <div
          className={`absolute inset-x-0 top-0 flex justify-between font-mono ${axisFontSize} tracking-[0.04em] text-ink-subtle`}
        >
          <span>{start}</span>
          {!isMini && <span>{Math.round((start + end) / 2)}</span>}
          <span>{end}</span>
        </div>
      )}

      {/* 3-zone track. Single gradient — the gradient describes the
          full Hold→Optimal→Past arc; we don't need three explicit
          divs because we only ever care about the "Optimal" zone for
          a wine that has a known window. The HOLD/PAST zones at the
          extremes get visually faded because the gradient transitions
          from grey-cream-amber-faded-brown across 0-100%. */}
      <div
        className={`absolute inset-x-0 ${trackTopOffset} ${trackHeight} overflow-hidden rounded-full`}
        style={{
          background:
            "linear-gradient(90deg, #E3EFE8 0%, #FBF3DC 60%, #F2D896 88%, #E8DCD0 100%)",
        }}
      />

      {/* Optional zone label centered over track */}
      {showZoneLabel && !isMini && (
        <div
          className="absolute inset-x-0 top-[50px] flex justify-center"
          style={{ pointerEvents: "none" }}
        >
          <span
            className="text-[9px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: "rgba(26,26,26,0.45)" }}
          >
            Optimal · {start}–{end}
          </span>
        </div>
      )}

      {/* Current-year marker — Bordeaux pin + circle head */}
      <div
        className={`absolute ${markerTopOffset} w-[2px] ${markerHeight}`}
        style={{
          left: `${markerPct}%`,
          transform: "translateX(-50%)",
          background: "var(--color-accent)",
        }}
      >
        <span
          className="absolute left-1/2 -top-[6px] block h-[12px] w-[12px] -translate-x-1/2 rounded-full"
          style={{
            background: "var(--color-accent)",
            boxShadow: "0 0 0 3px var(--color-bg-primary, #FAFAF8)",
          }}
        />
      </div>

      {/* Marker year label below the pin */}
      <div
        className={`absolute ${markerLabelTop} font-mono text-[11px] font-medium`}
        style={{
          left: `${markerPct}%`,
          transform: "translateX(-50%)",
          color: "var(--color-accent)",
          whiteSpace: "nowrap",
        }}
      >
        {!isMini ? `Today · ${currentYear}` : currentYear}
      </div>
    </div>
  );
}
