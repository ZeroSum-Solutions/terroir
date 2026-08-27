/**
 * BND-039 — DrinkWindowTimeline
 *
 * Reusable horizontal timeline visual for the drink-window
 * intelligence feature. Shipped in:
 *   • Cellar wine-detail drawer (size="full")
 *   • Cellar list row indicator (size="mini")
 *   • Insights briefing alert card (size="full" or "mini")
 *
 * Kimi audit 2026-08-26 rework:
 *   • Two-stop ramp (warm neutral → burgundy by day, candle gold →
 *     burgundy by night) via --t-window-ramp-start / --t-primary.
 *     The old sage → powder → blush blend broke the one-accent law
 *     and went muddy at the midpoint.
 *   • ONE axis: start / peak (true percentage position, when known) /
 *     end. The rounded-midpoint tick only renders when no peak exists,
 *     so "Peak 2017" can never sit over a conflicting "2018".
 *   • Past-window honesty: when today is beyond the end year the
 *     marker steps OFF the track (calc(100% + 10px)) behind a dashed
 *     overflow stub — terminus and today never share an x-position.
 *   • Marker color is --t-window-marker (burgundy day / gold night):
 *     burgundy on lacquer measured ~1.9:1 and vanished.
 *
 * Returns null when no window is known (start || end is null).
 * Pure presentational, CSS-only, respects `prefers-reduced-motion`.
 *
 * BND-071 — peak year diamond marker on the track.
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

  const isPastWindow = currentYear > end;
  const markerPct = getMarkerPosition(start, end, currentYear);
  const isMini = size === "mini";

  // BND-071 — peak year position as a percentage along the timeline.
  // Clamped inward slightly so the axis label can't collide with the
  // start/end years at the track edges.
  const peakPct =
    peak != null && start !== end
      ? Math.max(12, Math.min(88, ((peak - start) / (end - start)) * 100))
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
    isPastWindow || markerPct >= 85
      ? "translateX(-100%)"
      : markerPct <= 15
        ? "translateX(0)"
        : "translateX(-50%)";
  const markerLeft = isPastWindow ? "calc(100% + 10px)" : `${markerPct}%`;

  return (
    <div className={`relative w-full ${wrapperHeight}`} aria-hidden>
      {/* Axis — the one row of years. Peak replaces the midpoint tick. */}
      {showAxis && (
        <div
          className={`absolute inset-x-0 top-0 font-mono ${axisFontSize} tracking-[0.04em] text-grey`}
        >
          <span className="absolute left-0">{start}</span>
          {!isMini && peakPct != null && (
            <span
              className="absolute -translate-x-1/2 font-medium text-accent"
              style={{ left: `${peakPct}%` }}
            >
              Peak {peak}
            </span>
          )}
          {!isMini && peakPct == null && (
            <span className="absolute left-1/2 -translate-x-1/2">
              {Math.round((start + end) / 2)}
            </span>
          )}
          <span className="absolute right-0">{end}</span>
        </div>
      )}

      {/* Two-stop track — warm neutral → burgundy (day), gold → burgundy (night). */}
      <div
        className={`absolute inset-x-0 ${trackTopOffset} ${trackHeight} overflow-hidden rounded-full`}
        style={{
          // --t-* runtime vars, not --color-*: @theme inline only emits
          // custom properties for tokens the scanner sees referenced.
          background:
            "linear-gradient(90deg, var(--t-window-ramp-start) 0%, var(--t-primary) 100%)",
        }}
      />

      {/* Past-window overflow stub — dashed continuation from the track's
          end to the off-track today marker. */}
      {isPastWindow && (
        <div
          className={`absolute ${trackTopOffset} flex items-center`}
          style={{ left: "100%", width: "10px", height: isMini ? "4px" : "14px" }}
        >
          <div
            className="w-full border-t border-dashed"
            style={{ borderColor: "var(--t-window-marker)" }}
          />
        </div>
      )}

      {/* BND-071 — peak year diamond marker on the track. */}
      {peakPct != null && !isMini && (
        <div
          className={`absolute ${trackTopOffset} flex items-center justify-center`}
          style={{
            left: `${peakPct}%`,
            transform: "translateX(-50%)",
            width: "10px",
            height: "14px",
            zIndex: 2,
          }}
        >
          <div
            className="rotate-45"
            style={{
              width: "8px",
              height: "8px",
              background: "var(--t-ink)",
              boxShadow: "0 0 0 2px var(--t-surface)",
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

      {/* Current-year marker — pin + circle head. Steps off the track when
          the window is over so "past peak" reads spatially. */}
      <div
        data-past-window={isPastWindow ? "true" : undefined}
        className={`absolute ${markerTopOffset} w-[2px] ${markerHeight}`}
        style={{
          left: markerLeft,
          transform: "translateX(-50%)",
          background: "var(--t-window-marker)",
        }}
      >
        <span
          className="absolute left-1/2 -top-[6px] block h-[12px] w-[12px] -translate-x-1/2 rounded-full"
          style={{
            background: "var(--t-window-marker)",
            boxShadow: "0 0 0 3px var(--color-canvas)",
          }}
        />
      </div>

      {/* Marker year label below the pin */}
      <div
        className={`absolute ${markerLabelTop} font-mono text-[11px] font-medium`}
        style={{
          left: markerLeft,
          transform: markerLabelTransform,
          color: "var(--t-window-marker)",
          whiteSpace: "nowrap",
        }}
      >
        {!isMini ? `Today · ${currentYear}` : currentYear}
      </div>
    </div>
  );
}
