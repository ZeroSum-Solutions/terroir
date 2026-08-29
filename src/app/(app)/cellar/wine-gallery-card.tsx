import Link from "next/link";
import { WineThumb } from "@/components/wine-thumb";
import {
  formatStatusLabel,
  getDrinkWindowStatus,
  getYearsUntilWindowClose,
  getYearsUntilWindowOpen,
  type DrinkStatus,
} from "@/lib/drink-window/status";
import { cn } from "@/lib/utils";
import type { CellarWineRow } from "./types";

/**
 * The Gallery card — the bottle-forward view of a cellar.
 *
 * The design brief (2026-08-29) asked for the look of the reference
 * folder: a near-black room with one warm light source and the bottle as
 * the subject. That is literally what the stage below is — a sunken well
 * with a radial pool of the champagne mark behind whatever image we have.
 *
 * The reason it is a *well* and not a plain image slot: most of the
 * catalogue has no photograph, and an empty white square reads as broken.
 * A lit well with a monogram in it reads as deliberate, so the unphoto-
 * graphed majority looks intentional rather than unfinished.
 *
 * Everything on the card is data we already hold on `wines` /
 * `inventory_items`. Nothing here waits on the X-Wines corpus join — the
 * corpus attributes (body, acidity, pairings, crowd rating) belong to the
 * detail page and to the second wave of facets.
 */

/**
 * The pool of candlelight — the one place paint is allowed to be warm,
 * because it is standing in for a light source rather than tinting a
 * surface. Same recipe as the detail-page hero.
 */
const STAGE_GLOW = {
  backgroundImage:
    "radial-gradient(ellipse 44% 62% at 50% 58%, color-mix(in oklab, var(--t-mark) 22%, transparent), transparent 70%)",
} as const;

/**
 * Two bottles is the point where a sommelier starts treating a wine as
 * scarce — below that it can't be sold by the glass for a full service.
 * Matches the low-stock counter's own threshold.
 */
const SCARCE_AT = 2;

/** DESIGN.md — Status. Four states, and "at peak" is deliberately achromatic. */
const STATUS_TONE: Record<DrinkStatus, string> = {
  drink_now: "bg-ready-wash text-ready-ink",
  optimal: "bg-peak-wash text-peak-ink",
  hold: "bg-hold-wash text-hold-ink",
  past_peak: "bg-risk-wash text-risk-ink",
  unknown: "",
};

export function WineGalleryCard({ wine }: { wine: CellarWineRow }) {
  const status = getDrinkWindowStatus(wine.drink_window_start, wine.drink_window_end);
  const statusLabel =
    status === "unknown"
      ? null
      : formatStatusLabel(
          status,
          getYearsUntilWindowClose(wine.drink_window_end),
          getYearsUntilWindowOpen(wine.drink_window_start),
        );

  const scarce = wine.sealed_count > 0 && wine.sealed_count <= SCARCE_AT;
  const place = [wine.vintage ?? "NV", wine.region].filter(Boolean).join(" · ");

  return (
    <Link
      href={`/cellar/${wine.wine_id}`}
      className={cn(
        "group grid gap-sm rounded-lg card-surface p-sm",
        "transition-[transform,border-color] duration-200",
        "hover:-translate-y-[2px] hover:border-rule-strong",
        "focus-ring",
        "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        wine.is_eightysixed && "opacity-60",
      )}
    >
      <div className="relative grid aspect-[4/3] place-items-center overflow-hidden rounded-md bg-surface-sunken">
        <div aria-hidden className="absolute inset-0" style={STAGE_GLOW} />

        <WineThumb
          src={wine.hero_image_url}
          colour={wine.colour}
          producer={wine.producer}
          name={wine.name}
          size={72}
          className="relative"
        />

        {/* Stock reads before the name does — scarcity is the thing a
            sommelier scans a wall for. */}
        <span
          className={cn(
            "absolute right-xs top-xs grid h-6 min-w-6 place-items-center rounded-pill px-2",
            "tabular text-ledger font-bold",
            scarce ? "bg-primary text-seal-ink" : "glass text-ink",
          )}
        >
          {wine.sealed_count}
        </span>

        {statusLabel && (
          <span
            className={cn(
              "absolute bottom-xs left-xs rounded-pill px-2 py-[3px]",
              "text-caption font-semibold uppercase",
              STATUS_TONE[status],
            )}
          >
            {statusLabel}
          </span>
        )}
      </div>

      <div className="grid gap-3xs">
        <p className="truncate text-caption font-semibold uppercase text-grey">
          {wine.producer}
        </p>
        <p className="line-clamp-2 font-serif text-body-lg leading-tight text-ink">
          {wine.name}
        </p>
        {place && (
          <p className="tabular truncate text-ledger text-grey">{place}</p>
        )}
      </div>

      {(wine.rating != null || wine.current_bottle_price != null) && (
        <div className="flex items-center justify-between gap-xs border-t border-rule pt-xs">
          {wine.rating != null ? (
            <span className="flex items-baseline gap-1">
              <span className="tabular font-serif text-subheading leading-none text-ink">
                {wine.rating}
              </span>
              {/* The scale, spelled out. `wines.rating` is a critic score
                  out of 100 — not the 1–5 crowd average the corpus
                  carries. Two different numbers; never show one bare. */}
              <span className="text-caption text-grey">/100</span>
            </span>
          ) : (
            <span />
          )}
          {wine.current_bottle_price != null && (
            <span className="tabular text-body-sm font-bold text-ink">
              ${wine.current_bottle_price.toFixed(0)}
            </span>
          )}
        </div>
      )}
    </Link>
  );
}
