/**
 * LIST-02 — choose the list section a wine belongs in from the wine's own
 * colour, rather than from whichever section the user happened to be looking
 * at when they hit "Add wine".
 *
 * The old default pre-checked the active section, which is how a red Burgundy
 * (Benjamin Leroux Vosne-Romanée 2019) ended up filed under Sparkling: the
 * user was viewing Sparkling at the time, so the modal did exactly what it was
 * told and the wrong thing.
 *
 * The six colours the enrichment writes (`red | white | sparkling | rose |
 * dessert | fortified`, see `src/lib/cellar-facets`) do not map 1:1 onto
 * sections, because `DEFAULT_SECTIONS` ships **five** and folds two colours
 * into one: "Dessert & Fortified". So a section name is matched as a list of
 * alternatives — split on the separators people actually use — and a colour
 * matches when it equals one of them outright.
 *
 * That is deliberately narrower than substring matching:
 *
 *   "Dessert & Fortified"  → dessert | fortified   → both match
 *   "Sparkling & Champagne"→ sparkling | champagne → sparkling matches
 *   "Red Burgundy"         → red burgundy          → `red` does NOT match
 *   "Reds"                 → reds                  → `red` does NOT match
 *
 * "Red Burgundy" not matching `red` is the point: pre-filing every red into a
 * Burgundy-only section would be the same class of bug this exists to fix. A
 * miss is safe — the caller falls back to the active section, i.e. today's
 * behaviour — so the rule errs toward missing rather than guessing.
 */

export type ColourSection = { id: string; name: string };

/** Lowercase, trim, and strip diacritics, so "Rosé" and "rose" compare equal. */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleLowerCase();
}

/**
 * The alternatives a section name offers, e.g. "Dessert & Fortified" →
 * ["dessert", "fortified"]. Splits only on explicit list separators, never on
 * plain whitespace, so multi-word names stay a single alternative.
 */
function alternatives(sectionName: string): string[] {
  return fold(sectionName)
    .split(/\s*(?:&|\/|\+|,|\band\b)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The id of the section matching `colour`, or null when the wine has no
 * colour or no section corresponds to it. Null means "caller decides" — it is
 * not an error.
 *
 * A section whose whole name is the colour wins over one that merely lists it,
 * so a list carrying both "Dessert" and "Dessert & Fortified" sends a dessert
 * wine to the specific section rather than the combined one.
 */
export function sectionIdForColour(
  colour: string | null | undefined,
  sections: readonly ColourSection[],
): string | null {
  if (!colour) return null;
  const target = fold(colour);
  if (!target) return null;

  const exact = sections.find((section) => fold(section.name) === target);
  if (exact) return exact.id;

  return sections.find((section) => alternatives(section.name).includes(target))?.id ?? null;
}
