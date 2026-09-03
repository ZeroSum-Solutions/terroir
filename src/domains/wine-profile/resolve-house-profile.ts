/**
 * What this house's own palates say about one wine.
 *
 * This is one of the three composable resolvers in §4.2 of
 * docs/superpowers/specs/2026-09-03-wine-page-design.md. It returns a COMPLETE
 * object — there is no projection variant for the scan card, because a
 * sometimes-absent field destroys the guarantee the whole design exists for
 * (D8).
 *
 * WHY THERE ARE NO STRUCTURAL AXES HERE
 * -------------------------------------
 * The spec originally promised "the four structural axes" from this resolver.
 * It contradicted itself: the `wine_notes` schema it defines in §3.2 has no
 * body/acidity/tannin/sweetness columns, and the controlled vocabulary is
 * aroma-and-flavour only. Nobody was ever asked for structure, so there is
 * nothing to aggregate and nothing to backfill.
 *
 * Adding four optional 1–5 fields to the composer was considered and rejected
 * (D15). Against a floor of n >= 3, optional inputs on a capture path with zero
 * organic notes and 41 structureless legacy rows aggregate to n = 0 on every
 * axis — the same empty block, bought with a rating surface that exists purely
 * to make a type non-empty. That is D7's manufactured signal wearing a schema.
 * Body and acidity come from X-Wines with a real basis; tannin and sweetness
 * exist in neither source and are therefore not shown at all.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { loadWineNotes } from "@/domains/notes/load-wine-notes";
import type { HouseNote } from "@/domains/notes/note-list";
import type { Score, Sourced } from "@/lib/provenance/sourced";

/**
 * Below this many notes the block shows per-note chips attributed to their
 * authors instead of an aggregate — honest, because two palates are two
 * palates. Exported so the UI copy can name the number once rather than
 * hardcoding "3" in the resolver and again in the sentence beside it.
 */
export const AGGREGATE_FLOOR = 3;

export type HouseTaste = {
  descriptors: { slug: string; label: string; family: string; notes: number }[];
  /** Notes on this wine. Always reported, including below the floor. */
  corpusSize: number;
};

/**
 * The aggregation rules, as a pure function over notes already loaded.
 *
 * Pure so the rules are testable without a database, and so the page can
 * aggregate notes it has already fetched rather than reading `wine_notes`
 * twice to render one screen.
 */
export function aggregateHouseTaste(notes: HouseNote[]): {
  taste: Sourced<HouseTaste>;
  score: Sourced<Score> | null;
} {
  // loadWineNotes has already dropped 'inferred' rows, so every descriptor
  // reaching here is one a person confirmed. A count is one honest number.
  const counts = new Map<string, { slug: string; label: string; family: string; notes: number }>();
  for (const note of notes) {
    for (const descriptor of note.descriptors) {
      const seen = counts.get(descriptor.slug);
      if (seen) seen.notes += 1;
      else counts.set(descriptor.slug, { ...descriptor, notes: 1 });
    }
  }

  const descriptors = [...counts.values()].sort(
    // The label tiebreak is not cosmetic: without it two descriptors on the
    // same count come back in row order, and the chip cloud reshuffles itself
    // between two renders of identical data.
    (a, b) => b.notes - a.notes || a.label.localeCompare(b.label),
  );

  const scores = notes
    .map((note) => note.score)
    .filter((score): score is number => score !== null);

  return {
    taste: {
      value: { descriptors, corpusSize: notes.length },
      basis: { kind: "house", notes: notes.length },
    },
    // Null rather than a mean over nothing. NaN through a number formatter
    // renders as 0 — a wine this house apparently rated zero out of a hundred.
    // The score's own basis counts SCORED notes, not all of them: "three people
    // wrote about this" and "one person scored it 92" are different claims, and
    // a 92 captioned "from 3 notes" is a fabricated consensus.
    score:
      scores.length === 0
        ? null
        : {
            value: {
              n: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
              scale: 100,
            },
            basis: { kind: "house", notes: scores.length },
          },
  };
}

export async function resolveHouseProfile(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  wineId: string,
): Promise<{
  taste: Sourced<HouseTaste>;
  score: Sourced<Score> | null;
  notes: HouseNote[];
}> {
  const notes = await loadWineNotes(supabase, restaurantId, wineId);
  return { ...aggregateHouseTaste(notes), notes };
}
