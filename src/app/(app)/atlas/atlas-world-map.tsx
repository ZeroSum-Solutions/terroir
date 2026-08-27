"use client";

import type { AtlasCountryAggregate } from "@/lib/atlas/aggregate";
import { ATLAS_VIEWBOX, WORLD_COUNTRY_PATHS } from "@/lib/atlas/world-paths.generated";

// Countries with data still get a visible sliver of gold even when their
// count is tiny next to the cellar's biggest country — a bare-minimum
// density ramp is unreadable for a modest cellar (recon risk: "a
// single-country cellar shows one full-intensity country and nothing
// else" would be worse without a floor).
const MIN_INTENSITY = 0.16;

/**
 * Atlas v1 (recon lane "atlas-map") — pure presentational inline SVG.
 * Fill is a single-hue ramp on the gold token, scaled to the cellar's own
 * max country (never an absolute scale) — semantic tokens only, no hex.
 * Tap-only in v1: no pan/zoom. Each country with bottles is a button-role
 * path (44px targets don't apply to map geometry — a focus outline
 * stands in for the touch-target contract instead).
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
      role="img"
      aria-label="Map of the countries in your cellar"
      className="h-auto w-full"
    >
      {Object.entries(WORLD_COUNTRY_PATHS).map(([key, geo]) => {
        const country = byKey.get(key);
        if (!country || country.bottles <= 0) {
          return (
            <path
              key={key}
              d={geo.d}
              fill="var(--color-canvas)"
              stroke="var(--color-hairline)"
              strokeWidth={0.5}
            />
          );
        }

        const selected = key === selectedKey;
        const intensity = Math.max(MIN_INTENSITY, country.bottles / maxBottles);
        const fillPct = Math.round(intensity * 100);
        const bottleWord = country.bottles === 1 ? "bottle" : "bottles";

        return (
          <path
            key={key}
            d={geo.d}
            role="button"
            tabIndex={0}
            aria-label={`${country.label}, ${country.bottles} ${bottleWord}`}
            aria-pressed={selected}
            onClick={() => onSelect(key)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(key);
              }
            }}
            fill={`color-mix(in srgb, var(--color-gold) ${fillPct}%, var(--color-surface))`}
            stroke={selected ? "var(--color-accent)" : "var(--color-hairline)"}
            strokeWidth={selected ? 2 : 0.5}
            className="cursor-pointer outline-none transition-[stroke-width] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            <title>{`${country.label} — ${country.bottles} ${bottleWord}`}</title>
          </path>
        );
      })}
    </svg>
  );
}
