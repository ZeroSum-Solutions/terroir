"use client";

import type { AtlasCountryAggregate } from "@/lib/atlas/aggregate";
import { ATLAS_VIEWBOX, WORLD_COUNTRY_PATHS } from "@/lib/atlas/world-paths.generated";

// Countries with data still get a visible sliver of the accent even when
// their count is tiny next to the cellar's biggest country — a bare-minimum
// density ramp is unreadable for a modest cellar (recon risk: "a
// single-country cellar shows one full-intensity country and nothing
// else" would be worse without a floor).
const MIN_INTENSITY = 0.16;

/**
 * Atlas v1 (recon lane "atlas-map") — pure presentational inline SVG.
 * Fill is a single-hue ramp on the ACCENT token (burgundy by day, candle
 * gold by night — the one-accent-per-room law; a gold ramp over the light
 * room's cream drifted olive/brown, which is banned), scaled to the
 * cellar's own max country (never an absolute scale) — semantic tokens
 * only, no hex. A country without bottles is `wash`, one step off the
 * canvas the map sits on, outlined in `rule-strong`: `canvas` is the page
 * ground itself, so filling with it erases every country that has no data,
 * and `rule` at a 0.5 stroke is below Nocturne's visibility floor.
 * Tap-only in v1: no pan/zoom. Each country with bottles is a button-role
 * path, but small-country geometry can't guarantee a 44px hit area — the
 * accessible country list AtlasShell renders below the map is the reliable
 * touch/keyboard path; the map itself is exposed as a labelled `group` (not
 * `img`) so its button-role descendants stay in the accessibility tree.
 */
export function AtlasWorldMap({
  countries,
  selectedKey,
  onSelect,
}: {
  countries: AtlasCountryAggregate[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const byKey = new Map(countries.map((c) => [c.key, c] as const));
  const maxBottles = Math.max(1, ...countries.map((c) => c.bottles));

  return (
    <svg
      viewBox={ATLAS_VIEWBOX}
      role="group"
      aria-label="Map of the countries in your cellar"
      className="h-auto w-full"
    >
      {Object.entries(WORLD_COUNTRY_PATHS).map(([key, geo]) => {
        const country = byKey.get(key);
        // Presence, not sealed count, decides interactivity: a wine with
        // only an open bottle has bottles === 0 but still lives here.
        if (!country || country.wines <= 0) {
          return (
            <path
              key={key}
              d={geo.d}
              fill="var(--color-wash)"
              stroke="var(--color-rule-strong)"
              strokeWidth={0.5}
            />
          );
        }

        const selected = key === selectedKey;
        // maxBottles is clamped to >= 1 above, so an open-bottle-only
        // country (bottles 0) lands on the MIN_INTENSITY floor.
        const intensity = Math.max(MIN_INTENSITY, country.bottles / maxBottles);
        const fillPct = Math.round(intensity * 100);
        const bottleLabel =
          country.bottles > 0
            ? `${country.bottles} ${country.bottles === 1 ? "bottle" : "bottles"}`
            : "open bottle only";

        return (
          <path
            key={key}
            d={geo.d}
            role="button"
            tabIndex={0}
            aria-label={`${country.label}, ${bottleLabel}`}
            aria-pressed={selected}
            onClick={() => onSelect(key)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(key);
              }
            }}
            fill={`color-mix(in srgb, var(--color-accent) ${fillPct}%, var(--color-surface))`}
            stroke={selected ? "var(--color-accent)" : "var(--color-rule-strong)"}
            strokeWidth={selected ? 2 : 0.5}
            className="cursor-pointer outline-none transition-[stroke-width] duration-150 focus-ring"
          >
            <title>{`${country.label} — ${bottleLabel}`}</title>
          </path>
        );
      })}
    </svg>
  );
}
