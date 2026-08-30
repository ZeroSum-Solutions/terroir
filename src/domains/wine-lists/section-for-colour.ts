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
 * dessert | fortified`, see `src/lib/cellar-facets`) map 1:1 onto the six
 * sections a wine list ships with — but only once the accent on "Rosé" and the
 * casing on everything else are folded away.
 *
 * Matching is deliberately exact-after-folding. A section named "Sparkling &
 * Champagne" or "Reds" does not match, and the caller falls back to the active
 * section — i.e. today's behaviour. Guessing at compound names risks pre-filing
 * a wine into the wrong section, which is the bug this exists to fix.
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
 * The id of the section matching `colour`, or null when the wine has no
 * colour or no section corresponds to it. Null means "caller decides" — it is
 * not an error.
 */
export function sectionIdForColour(
  colour: string | null | undefined,
  sections: readonly ColourSection[],
): string | null {
  if (!colour) return null;
  const target = fold(colour);
  if (!target) return null;
  return sections.find((section) => fold(section.name) === target)?.id ?? null;
}
