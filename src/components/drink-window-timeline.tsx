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
 *
 * BND-071 — peak year diamond marker added to the timeline.
 */

import { getMarkerPosition } from "@/lib/drink-window/status";

export type DrinkWindowTimelineSize = "mini" | "full";

export function DrinkWindowTimeline({
  start,
  end,
  peak,
  currentYear = new Date().getFullYear(),
  size = "full",
  showAxis = true,
  showZoneLabel = true,
}: {
  start: number | null;
  end: number | null;
  peak?: number | undefined;
  currentYear?: number;
  size?: DrinkWindowTimelineSize;
  showAxis?: boolean;
  showZoneLabel?: boolean;
}) {
  if (start == null || end == null) return null;

  const markerPct = getMarkerPosition(start, end, currentYear);
  const isMini = size === "mini";

  // BND-071 — compute peak year position as percentage along the timeline.
  const peakPct =
    peak != null && start !== end
      ? Math.max(0, Math.min(100, ((peak - start) / (end - start)) * 100))
      : null;

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
  const markerLabelTransform =
    markerPct <= 15
      ? "translateX(0)"
      : markerPct >= 85
        ? "translateX(-100%)"
        : "translateX(-50%)";

  return (
    <div className={`relative w-full ${wrapperHeight}`} aria-hidden>
      {/* Axis labels */}
      {showAxis && (
        <div
          className={`absolute inset-x-0 top-0 flex justify-between font-mono ${axisFontSize} tracking-[0.04em] text-grey`}
        >
          <span>{start}</span>
          {!isMini && <span>{Math.round((start + end) / 2)}</span>}
          <span>{end}</span>
        </div>
      )}

      {/* 3-zone track — sage (in window) → powder (approaching) → blush (past peak). */}
      <div
        className={`absolute inset-x-0 ${trackTopOffset} ${trackHeight} overflow-hidden rounded-full`}
        style={{
          // --t-* runtime vars, not --color-*: @theme inline only emits
          // custom properties for tokens the scanner sees referenced.
          background:
            "linear-gradient(90deg, var(--t-sage-wash) 0%, var(--t-powder-wash) 60%, var(--t-blush-wash) 88%, var(--t-blush-wash) 100%)",
        }}
      />

      {/* BND-071 — peak year diamond marker on the track. */}
      {peakPct != null && !isMini && (
        <div
          className={`absolute ${trackTopOffset} flex items-center justify-center`}
          style={{
            left: `${peakPct}%`,
            transform: "translateX(-50%)",
            width: "10px",
            height: trackHeight === "h-[4px]" ? "4px" : "14px",
            zIndex: 2,
          }}
        >
          <div
            className="rotate-45 border border-grey"
            style={{
              width: "8px",
              height: "8px",
              background: "var(--color-primary)",
              opacity: 0.7,
            }}
          />
        </div>
      )}

      {/* Optional zone label centered over track */}
      {showZoneLabel && !isMini && (
        <div
          className="absolute inset-x-0 top-[50px] flex justify-center"
          style={{ pointerEvents: "none" }}
        >
          <span
            className="text-[9px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: "var(--color-grey)" }}
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
          background: "var(--color-primary)",
        }}
      >
        <span
          className="absolute left-1/2 -top-[6px] block h-[12px] w-[12px] -translate-x-1/2 rounded-full"
          style={{
            background: "var(--color-primary)",
            boxShadow: "0 0 0 3px var(--color-canvas)",
          }}
        />
      </div>

      {/* Marker year label below the pin */}
      <div
        className={`absolute ${markerLabelTop} font-mono text-[11px] font-medium`}
        style={{
          left: `${markerPct}%`,
          transform: markerLabelTransform,
          color: "var(--color-primary)",
          whiteSpace: "nowrap",
        }}
      >
        {!isMini ? `Today · ${currentYear}` : currentYear}
      </div>
    </div>
  );
}
