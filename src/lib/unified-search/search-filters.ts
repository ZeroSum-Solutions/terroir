// P1 slice 3b — applying a parsed query to three corpora that disagree.
//
// parseSearchQuery (slice 3a) resolves "a crisp white from Portugal" to
// canonical facts. Acting on them is not a matter of passing those canonical
// strings to three `.eq()` calls, because the cellar, LWIN and X-Wines each
// record the same fact in their OWN vocabulary. Measured on the local stack,
// 2026-09-01:
//
//   colour   wines.colour is lowercase ("red"); lwin_catalog.colour is
//            capitalised and unaccented ("Rose"); xwines_catalog.type is
//            capitalised and accented ("Rosé") and splits dessert wine into
//            "Dessert" and "Dessert/Port".
//   region   lwin_catalog: 25,420 rows say "Burgundy", 0 say "Bourgogne".
//            xwines_catalog: 2,429 say "Bourgogne", 0 say "Burgundy". LWIN
//            files Napa under California — 0 rows match region ~ "napa",
//            3,930 match display_name ~ "napa".
//   country  all three spell it identically. This is the only fact that
//            needs no translation.
//
// A filter written without those facts would not return fewer rows; it would
// return NONE, and the palette would report "nothing found" — a confident
// wrong answer, which is the failure mode this whole program exists to
// remove. So every predicate below is built from a measured column value,
// and where a corpus cannot express a filter at all the source is dropped
// from the query rather than queried unfiltered.
//
// The two ways a corpus can fail to express a filter are NOT the same:
//
//   CONTRADICTED — lwin_catalog.colour has a value on every row and none of
//     them mean "sparkling" (its 5,598 Champagne rows are filed White and
//     Rose). There is no honest predicate, and running the query without one
//     would answer a sparkling question with still reds. The source is
//     dropped: `answerable: false`.
//   ABSENT — lwin_catalog has no vintage column at all, because an LWIN row
//     is the WINE, not the bottling. Showing "Produttori del Barolo Barolo"
//     for "2016 Barolo" is the right wine at the grain LWIN models, not a
//     wrong row. The filter simply does not apply and the source stays in.

import { regionSurfaceTerms } from "./wine-gazetteer";
import type { ParsedSearchQuery, SearchPreferences } from "./query-parse";

export type SearchSource = "cellar" | "lwin" | "xwines";

/** Verbatim from /api/wines/search: the proven quoting for a value embedded
 *  in a PostgREST `.or()` filter string — LIKE wildcards escaped, then the
 *  whole pattern double-quoted with inner quotes escaped. */
export function quotePostgrestPattern(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")
    .replaceAll('"', '\\"');
  return `"%${escaped}%"`;
}

type ColourPredicate = { column: string; values: string[] };

type SourceShape = {
  countryColumn: string;
  regionColumn: string;
  /** Null where the corpus does not record vintages at all (the ABSENT case). */
  vintage: { column: string; array: boolean } | null;
  /** Columns free text is matched across — the D4 fix: a query names a wine
   *  OR describes where it is from, and both must be searchable. */
  textColumns: readonly string[];
  /** Canonical colour -> this corpus's own predicate, or null when the
   *  corpus contradicts the filter (see CONTRADICTED above). */
  colour: Record<string, ColourPredicate | null>;
};

const SOURCES: Record<SearchSource, SourceShape> = {
  cellar: {
    countryColumn: "country",
    regionColumn: "region",
    vintage: { column: "vintage", array: false },
    textColumns: ["name", "producer", "region", "varietal", "country"],
    colour: {
      Red: { column: "colour", values: ["red"] },
      White: { column: "colour", values: ["white"] },
      "Rosé": { column: "colour", values: ["rose"] },
      Sparkling: { column: "colour", values: ["sparkling"] },
      Dessert: { column: "colour", values: ["dessert"] },
      Fortified: { column: "colour", values: ["fortified"] },
    },
  },
  lwin: {
    countryColumn: "country",
    regionColumn: "region",
    vintage: null,
    textColumns: ["display_name", "producer", "region", "varietal", "country"],
    colour: {
      Red: { column: "colour", values: ["Red"] },
      White: { column: "colour", values: ["White"] },
      "Rosé": { column: "colour", values: ["Rose"] },
      Sparkling: null,
      Dessert: null,
      // The one fortified case LWIN CAN express, on a different column:
      // 3,088 rows carry type "Fortified Wine" (their colour is "NA").
      Fortified: { column: "type", values: ["Fortified Wine"] },
    },
  },
  xwines: {
    countryColumn: "country",
    regionColumn: "region_name",
    vintage: { column: "vintages", array: true },
    textColumns: ["name", "winery_name", "region_name", "country"],
    colour: {
      Red: { column: "type", values: ["Red"] },
      White: { column: "type", values: ["White"] },
      "Rosé": { column: "type", values: ["Rosé"] },
      Sparkling: { column: "type", values: ["Sparkling"] },
      Dessert: { column: "type", values: ["Dessert", "Dessert/Port"] },
      // Port is fortified, so these rows are genuinely the thing asked for.
      // Sherry and madeira are typed "Dessert" and are not reached — an
      // incomplete answer, never a wrong one.
      Fortified: { column: "type", values: ["Dessert/Port"] },
    },
  },
};

export type SourcePlan = {
  /** False when a filter is CONTRADICTED here — query this source and it lies. */
  answerable: boolean;
  countries: string[];
  /** Values for `colourColumn`; empty means no colour predicate. */
  colours: string[];
  colourColumn: string;
  vintages: number[];
  /** True when `vintages` must be matched with array overlap, not equality. */
  vintageIsArray: boolean;
  vintageColumn: string | null;
  /** PostgREST `.or()` string for the region, or null when none was asked for. */
  regionOr: string | null;
  /** PostgREST `.or()` string for the free-text needle, or null when it is empty. */
  textOr: string | null;
  /** What is left to match as text once the facts are taken out. */
  text: string;
};

function orAcross(columns: readonly string[], terms: readonly string[]): string {
  const clauses: string[] = [];
  for (const term of terms) {
    const pattern = quotePostgrestPattern(term);
    for (const column of columns) clauses.push(`${column}.ilike.${pattern}`);
  }
  return clauses.join(",");
}

export function planSource(source: SearchSource, parsed: ParsedSearchQuery): SourcePlan {
  const shape = SOURCES[source];
  const { filters, text } = parsed;

  const colours: string[] = [];
  let colourColumn = "colour";
  for (const canonical of filters.colours) {
    const predicate = shape.colour[canonical];
    if (predicate === undefined || predicate === null) {
      // CONTRADICTED — nothing this corpus can be asked that means this.
      return {
        answerable: false,
        countries: [],
        colours: [],
        colourColumn,
        vintages: [],
        vintageIsArray: false,
        vintageColumn: null,
        regionOr: null,
        textOr: null,
        text,
      };
    }
    colourColumn = predicate.column;
    for (const value of predicate.values) {
      if (!colours.includes(value)) colours.push(value);
    }
  }

  // Region: every surface term, across the region column AND the columns that
  // name the wine (textColumns carries both), because a corpus that files
  // Napa under California still says "Napa" in the wine's own name.
  const regionTerms = filters.regions.flatMap((region) => regionSurfaceTerms(region));

  return {
    answerable: true,
    countries: [...filters.countries],
    colours,
    colourColumn,
    vintages: shape.vintage === null ? [] : [...filters.vintages],
    vintageIsArray: shape.vintage?.array ?? false,
    vintageColumn: shape.vintage?.column ?? null,
    regionOr: regionTerms.length > 0 ? orAcross(shape.textColumns, regionTerms) : null,
    textOr: text === "" ? null : orAcross(shape.textColumns, [text]),
    text,
  };
}

/**
 * How well a row's body matches what was asked for. A PREFERENCE ranks and
 * never excludes (program plan D1), so this returns an ordering nudge, not a
 * predicate.
 *
 * An unrecorded body scores neutral rather than last: body is recorded for a
 * fraction of the corpus, and sorting "we don't know how this tastes" below
 * a wine we know is the wrong shape would turn missing data into a verdict.
 */
export function bodyRank(body: string | null, preferences: SearchPreferences): number {
  if (preferences.body.length === 0) return 0;
  if (body === null || body === "") return 0;
  return preferences.body.includes(body) ? 1 : -1;
}
