import { WORLD_COUNTRY_PATHS } from "./world-paths.generated";

/**
 * Atlas v1 (recon lane "atlas-map") — wines.country is uncontrolled free
 * text (no ISO normalization anywhere upstream), so this module resolves
 * whatever a wine's country label happens to be to the ISO 3166-1 numeric
 * key used by src/lib/atlas/world-paths.generated.ts.
 *
 * A label that can't be resolved returns UNMATCHED rather than silently
 * dropping — callers (src/lib/atlas/aggregate.ts) surface those in an
 * "Unmapped" section instead of losing bottles off the map.
 */
export const UNMATCHED = "__unmatched__" as const;

/** Trim/lowercase/diacritic-fold a country label for lookup. */
export function normalizeCountryText(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
    .replace(/\./g, "") // "U.S.A." -> "USA" before casing
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Hand alias map: common wine-country free-text spellings that don't
 * already match a world-atlas display name exactly (e.g. "France" needs
 * no entry here — it matches WORLD_COUNTRY_PATHS's own name). Only add an
 * alias once its target key actually exists in the generated map — a few
 * very small wine-producing places (e.g. Malta) aren't present at the
 * atlas's 110m resolution, and forcing them onto a key with no geometry
 * would be worse than leaving them Unmapped.
 */
const WINE_COUNTRY_ALIASES: Record<string, string> = {
  usa: "840",
  us: "840",
  "u s": "840", // "U.S." after period-stripping
  "u s a": "840", // "U.S.A." after period-stripping
  "united states": "840",
  "united states of america": "840",
  uk: "826",
  "u k": "826",
  england: "826",
  scotland: "826",
  wales: "826",
  "northern ireland": "826",
  "great britain": "826",
  "united kingdom": "826",
  "czech republic": "203",
  czechia: "203",
  "bosnia and herzegovina": "070",
  "bosnia & herzegovina": "070",
  macedonia: "807",
  "north macedonia": "807",
  holland: "528",
  "the netherlands": "528",
  turkiye: "792",
  "south korea": "410",
  "korea, south": "410",
  "republic of korea": "410",
};

/** Exact-name matches, derived from the generated atlas so it never drifts. */
const NAME_INDEX: Record<string, string> = Object.fromEntries(
  Object.entries(WORLD_COUNTRY_PATHS).map(([key, entry]) => [
    normalizeCountryText(entry.name),
    key,
  ]),
);

const ALIASES: Record<string, string> = { ...NAME_INDEX, ...WINE_COUNTRY_ALIASES };

/** Resolve a free-text wines.country label to a world-paths key, or UNMATCHED. */
export function lookupCountry(rawLabel: string): string | typeof UNMATCHED {
  const normalized = normalizeCountryText(rawLabel);
  if (!normalized) return UNMATCHED;
  return ALIASES[normalized] ?? UNMATCHED;
}
