// Recover a wine's producer from inside its own `name`.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// A CSV import writes rows whose `producer` is the empty string and whose
// producer name is run together with the cuvée in `name`, with no delimiter:
//
//   producer = ''   name = 'Benjamin Leroux Vosne-Romanée'
//
// AGENTS.md § "two identity systems" records the incident and migration 0137's
// repair. 0137 fixed the rows that existed; it did not close the import path,
// so the shape recurs — this checkout's `My Restaurant` tenant holds 1,277 of
// them, measured 2026-08-30.
//
// Everything downstream of identity is producer-first. `resolveXWinesProfile`
// returns early on a blank producer rather than run its fuzzy matcher, because
// the matcher's whole precision argument rests on an independent producer
// floor and there is no producer to floor. So these wines could not reach a
// corpus entry by ANY path, and a corpus entry is the only place an imported
// wine's picture can come from. 1,277 wines, 0 images.
//
// The fix is to SUPPLY the missing producer, not to widen the floors. The
// producer is sitting in `name`; this module gets it out.
//
// ── HOW ────────────────────────────────────────────────────────────────────
//
// The same operation 0137 audited and used: LONGEST-WORD-PREFIX matching of
// the name against a catalogue of known producers, not a trigram match on the
// whole string. 0137 tried trigram first and rejected it on evidence — it
// scored 'Agrapart Experience' against 'ABK6, L`Experience, Cognac' at 0.364
// and would have written ABK6 as the producer.
//
// This matches against `xwines_catalog.winery_name` rather than 0137's
// `lwin_catalog.producer`, for one reason: the corpus is the thing we are
// trying to reach. A producer recovered from LWIN still has to be matched into
// X-Wines afterwards, whereas a prefix that IS an X-Wines winery name arrives
// already spelled the corpus's way and scores 1.000 against it. It also picks
// up producers LWIN could not: 'Bérêche & Fils' is one of the 321 rows
// AGENTS.md records 0137 leaving unrepaired (LWIN spells it 'Bereche et
// Fils'), and X-Wines spells it exactly as the tenant does.
//
// Matching is EXACT on the whole prefix — case- and accent-sensitive string
// equality, not similarity. Measured against the 1,277-wine tenant, dropping
// to case-insensitive would recover 742 producers instead of 724 and
// additionally unaccented 799; the extra 75 are not worth a filter this module
// cannot express safely through PostgREST, and an exact match is the claim
// that is easiest to defend.
//
// ── THE GENERIC-WORD TRAP, AND THE WORD FLOOR MEASURED AGAINST IT ──────────
//
// 0137 documented it: catalogues contain producers literally named 'Chateau',
// 'Maison' and 'Clos', so a one-word prefix can match a producer that is not
// this wine's. X-Wines has the same hazard with different words — 'Aurora'
// (127 wines), 'Áster', 'Canto', 'Fable', 'Trellis'.
//
// Negative set, reconstructed from scripts/seed-local-supabase.mjs's own
// generator: its 20 producers are invented ('Juniper Vale', 'Hollow Hill') and
// its cuvées are 'Burgundy Pinot Noir Lot 001', so no row of it can
// legitimately match a real-world corpus. Each row is folded into the imported
// shape this module exists for — producer blanked, name = '<producer>
// <cuvée>' — giving 250 wines on which EVERY match is a false positive.
//
// (That reconstruction is necessary now: commit #163 re-pointed the seeded
// cellar in the database at real X-Wines rows, so the live 250 rows are no
// longer the negative set xwines-profile.ts's header measured against. The
// generator still holds the invented producers, so the set is still
// derivable — but it must be built, not queried.)
//
//   prefix words >= 1   38 of 250 recover a producer — every one WRONG
//                       ('Aster House …' -> 'Áster', 'Canto Verde …' ->
//                       'Canto', 'Fable & Stone …' -> 'Fable')
//   prefix words >= 2    0 of 250 recover anything
//
// Two words is therefore the floor at which prefix recovery is safe ON ITS
// OWN. It is not free: on the 1,277-wine tenant it drops recovery from 724 to
// 520, and the 204 it loses are overwhelmingly legitimate one-word houses —
// Savart, Vietti, Valentini, Soldera, Bollinger, Billecart-Salmon.
//
// So the floor is applied only where nothing else constrains the answer. See
// wine-corpus-profile.ts: the strict tier keeps one-word recovery because
// xwines-profile.ts's cuvée floor independently rejects all 38 of those
// negatives (measured: 0 of 250 accepted), while the image-only tier has no
// cuvée check to lean on and takes the two-word floor.

import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { CorpusRead } from "./xwines-profile";

/**
 * How many leading words may be tried as a producer.
 *
 * 0137 measured the same bound against lwin_catalog: producers longer than six
 * words do not occur.
 */
export const PRODUCER_PREFIX_MAX_WORDS = 6;

/**
 * The minimum prefix length for a recovery that nothing downstream re-checks.
 * Measured above: one word admits 38 wrong producers per 250 negatives, two
 * words admits none.
 */
export const PRODUCER_PREFIX_SAFE_WORDS = 2;

export type RecoveredProducer = {
  /** The corpus's own spelling of the winery, so it scores 1.000 against it. */
  producer: string;
  /** What is left of `name` once the producer is taken off the front. */
  cuvee: string;
  /** How many words the producer consumed. Governs the image-only tier. */
  words: number;
};

export type ProducerPrefix = { prefix: string; cuvee: string; words: number };

// PostgREST's `in.()` list is comma-separated with double-quoted values, and
// supabase-js quotes a value only when it contains one of `[,()]` — it does
// not ESCAPE anything inside the quotes it adds. A prefix carrying a quote or
// a backslash would therefore change the shape of the filter rather than the
// value in it, so such a prefix is dropped instead of sent. Losing a candidate
// costs a picture; sending a malformed filter is a different kind of bug.
const UNSENDABLE = /["\\]/;

/**
 * The leading-word prefixes of `name` that could be a producer, longest first.
 *
 * A prefix must leave at least one word behind: a name that is ENTIRELY a
 * winery name has no cuvée to match on, and asking the corpus for the empty
 * cuvée is not a question with a right answer.
 */
export function producerPrefixCandidates(name: string): ProducerPrefix[] {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const limit = Math.min(PRODUCER_PREFIX_MAX_WORDS, words.length - 1);
  const out: ProducerPrefix[] = [];
  for (let k = limit; k >= 1; k--) {
    const prefix = words.slice(0, k).join(" ");
    if (UNSENDABLE.test(prefix)) continue;
    out.push({ prefix, cuvee: words.slice(k).join(" "), words: k });
  }
  return out;
}

/**
 * The longest leading-word prefix of `name` that is a winery in the corpus.
 *
 * `{ status: "ok", value: null }` is the ordinary outcome — most names do not
 * start with a winery this corpus knows. `{ status: "unavailable" }` means the
 * catalogue could not be read, which a caller must not render as "no match".
 *
 * One query. The candidates are nested prefixes of one string, so a shorter
 * one always sorts before the longer one that extends it — descending order
 * with `limit(1)` returns the longest match without a second round trip.
 */
export async function recoverProducerFromName(
  supabase: SupabaseClient<Database>,
  name: string,
): Promise<CorpusRead<RecoveredProducer | null>> {
  const candidates = producerPrefixCandidates(name);
  if (candidates.length === 0) return { status: "ok", value: null };

  const { data, error } = await supabase
    .from("xwines_catalog")
    .select("winery_name")
    .in(
      "winery_name",
      candidates.map((candidate) => candidate.prefix),
    )
    .order("winery_name", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("xwines: producer-prefix-lookup failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wine-detail", phase: "producer-prefix-lookup" },
      extra: { name },
    });
    return { status: "unavailable" };
  }

  const winery = data?.winery_name ?? null;
  if (winery === null) return { status: "ok", value: null };

  // Ordering picked the longest MATCHING candidate; find it again to read back
  // the cuvée and the word count that go with it.
  const hit = candidates.find((candidate) => candidate.prefix === winery);
  if (!hit) return { status: "ok", value: null };

  return {
    status: "ok",
    value: { producer: winery, cuvee: hit.cuvee, words: hit.words },
  };
}
