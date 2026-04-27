/**
 * BND-040 — PriceBand
 *
 * Reusable horizontal band visual showing the bottle list price relative
 * to the user's target markup × retail reference. Mirrors the BND-039
 * DrinkWindowTimeline pattern (3-zone gradient + Bordeaux marker) for
 * design-system consistency, but with different semantics:
 *
 *   • Below band — bottle list < 70% of target price (tight margin)
 *   • Target band — within 70%-130% of target price (the optimal zone)
 *   • Above band — bottle list > 130% of target price (premium pricing)
 *
 * Returns null when retail reference or target markup is missing — the
 * parent surface should conditionally render. Pure presentational, CSS
 * only, respects `prefers-reduced-motion`.
 *
 * Used in:
 *   • Cellar wine-detail drawer Pricing section (size="full")
 *   • AddWineModal "Suggest list prices" step (size="full")
 *   • Insights pricing review row indicator (size="mini")
 *   • PriceInput popover in wine-list editor (size="mini")
 */

import { getBandMarkerPosition } from "@/lib/pricing/status";

export type PriceBandSize = "mini" | "full";

export function PriceBand({
  bottleList,
  retailReference,
  targetMarkup,
  size = "full",
  showAxis = true,
  showZoneLabel = true,
  showMarkerLabel = true,
}: {
  bottleList: number | null;
  retailReference: number | null;
  targetMarkup: number | null;
  size?: PriceBandSize;
  showAxis?: boolean;
  showZoneLabel?: boolean;
  showMarkerLabel?: boolean;
}) {
  if (
    bottleList == null ||
    retailReference == null ||
    targetMarkup == null ||
    retailReference <= 0 ||
    targetMarkup <= 0
  ) {
    return null;
  }

  const targetPrice = retailReference * targetMarkup;
  const minPrice = Math.round(targetPrice * 0.7);
  const maxPrice = Math.round(targetPrice * 1.3);
  const markerPct = getBandMarkerPosition(bottleList, retailReference, targetMarkup);
  const isMini = size === "mini";

  // Heights tuned to match the drink-window timeline proportions for
  // visual rhyme across the two intelligence layers.
  const trackHeight = isMini ? "h-[4px]" : "h-[14px]";
  const wrapperHeight = isMini ? "h-[40px]" : "h-[88px]";
  const trackTopOffset = isMini ? "top-[14px]" : "top-[32px]";
  const markerTopOffset = isMini ? "top-[10px]" : "top-[24px]";
  const markerHeight = isMini ? "h-[8px]" : "h-[30px]";
  const markerLabelTop = isMini ? "top-[24px]" : "top-[64px]";
  const axisFontSize = "text-[10px]";

  // Target tick — center of band (target markup × retail). Constant
  // 50% because the band axis is symmetric ±30% around target.
  const targetTickPct = 50;

  return (
    <div className={`relative w-full ${wrapperHeight}`} aria-hidden>
      {/* Axis labels */}
      {showAxis && (
        <div
          className={`absolute inset-x-0 top-0 flex justify-between font-mono ${axisFontSize} tracking-[0.04em] text-ink-subtle`}
        >
          <span>${minPrice}</span>
          {!isMini && <span>${Math.round(targetPrice)}</span>}
          <span>${maxPrice}</span>
        </div>
      )}

      {/* 3-zone track. Same gradient grammar as the drink-window timeline
          but with different semantic mapping (below-band / target / above-band). */}
      <div
        className={`absolute inset-x-0 ${trackTopOffset} ${trackHeight} overflow-hidden rounded-full`}
        style={{
          background:
            "linear-gradient(90deg, var(--color-bg-tertiary) 0%, var(--color-bg-tertiary) 18%, #E3EFE8 18%, #FBF3DC 50%, #F2D896 82%, #E8DCD0 82%, #E8DCD0 100%)",
        }}
      />

      {/* Target markup tick — center of band */}
      {!isMini && (
        <div
          className="absolute top-[28px] h-[22px] w-px bg-ink-subtle"
          style={{ left: `${targetTickPct}%` }}
        >
          <span
            className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] text-ink-subtle"
          >
            {targetMarkup.toFixed(1)}×
          </span>
        </div>
      )}

      {/* Optional zone label centered over track */}
      {showZoneLabel && !isMini && (
        <div className="absolute inset-x-0 top-[50px] flex justify-center" style={{ pointerEvents: "none" }}>
          <span
            className="text-[9px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: "rgba(26,26,26,0.45)" }}
          >
            Target band
          </span>
        </div>
      )}

      {/* Current-price marker — Bordeaux pin + circle head */}
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

      {/* Marker label below the pin */}
      {showMarkerLabel && (
        <div
          className={`absolute ${markerLabelTop} font-mono text-[11px] font-medium`}
          style={{
            left: `${markerPct}%`,
            transform: "translateX(-50%)",
            color: "var(--color-accent)",
            whiteSpace: "nowrap",
          }}
        >
          ${Math.round(bottleList)}
        </div>
      )}
    </div>
  );
}
