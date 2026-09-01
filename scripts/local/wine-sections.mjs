/**
 * scripts/local/wine-sections.mjs
 *
 * Which section holds a wine of a given colour and origin — the ONE rule
 * every local seeder and fixer files a wine under, so the demo cellar and
 * its wine lists cannot disagree about what "Whites" means.
 *
 * The base seeder dealt inventory into cellar sections round-robin, so
 * `/cellar` opened on "Sparkling" holding a red and "Whites" holding a tawny
 * port; fix-demo-wine-lists.mjs had already fixed the same fault on the wine
 * lists with this exact rule, privately. Shared now, so the third copy is
 * never written.
 *
 * Returns the section names in preference order: a red from France wants
 * "Reds - Old World" and falls back to "Reds - New World" only where a list
 * or cellar has no Old World section to offer.
 */

export const SECTION_NAMES = [
  "Sparkling",
  "Whites",
  "Rose",
  "Reds - Old World",
  "Reds - New World",
  "Dessert & Fortified",
];

/** Old World / New World, for splitting reds across the two red sections. */
export const OLD_WORLD = new Set([
  "France", "Italy", "Spain", "Portugal", "Germany", "Austria", "Greece",
  "Hungary", "Switzerland", "Croatia", "Slovenia", "Romania", "Bulgaria",
  "Georgia", "Moldova", "Israel", "Lebanon", "Turkey", "Czech Republic",
]);

/** Which section name should hold a wine of this colour, best first. */
export function sectionNameFor(wine) {
  switch (wine.colour) {
    case "sparkling": return ["Sparkling"];
    case "white":     return ["Whites"];
    case "rose":      return ["Rose"];
    case "dessert":
    case "fortified": return ["Dessert & Fortified"];
    case "red":
    default:
      return OLD_WORLD.has(wine.country ?? "")
        ? ["Reds - Old World", "Reds - New World"]
        : ["Reds - New World", "Reds - Old World"];
  }
}
