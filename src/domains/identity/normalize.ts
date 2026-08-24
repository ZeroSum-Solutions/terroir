// P2 — wine identity spine: the single TypeScript source of truth for
// normalizing producer/cuvée text and vintage strings into their
// identity-comparable forms. See
// docs/plans/2026-08-23-p2-identity-spine.md §5-6 for the full design —
// in particular, the boundary this file exists to enforce: vintage and
// bottle size (size_ml) are NEVER normalized/fuzzy-matched here or
// anywhere in the identity spine. Only producer and cuvée text ever pass
// through normalizeProducerOrCuvee, and the resulting identity key is
// always (producer_norm, cuvee_norm) PLUS the untouched, exact
// vintage/size_ml — see resolve_wine_variants_bulk (0099).
//
// CRITICAL CROSS-PIECE CONTRACT: normalizeProducerOrCuvee below must be
// byte-for-byte behaviorally identical to normalizeForDedup() in
// scripts/fixtures/generate-partner-cellar.mjs (P1's worktree,
// terroir-vw-p1 — not editable from here, per the P2 task brief). P1's
// 20,000-row fixture is the graded oracle for duplicate prevention;
// normalize.test.ts's golden-vector test enforces this agreement over
// all 40 SPELLING_SEEDS pairs by importing and calling P1's own function
// directly, not just eyeballing the two implementations for similarity.

export const MIN_VINTAGE = 1900;
export const CURRENT_YEAR = new Date().getFullYear();

/**
 * Normalize a producer or cuvée string into its identity-comparable
 * form: fold œ/æ ligatures by hand (Unicode NFKD does not decompose true
 * ligature letters), strip accents via NFKD + combining-mark removal,
 * fold case, collapse everything that isn't [a-z0-9] to single spaces,
 * then SORT TOKENS ALPHABETICALLY before rejoining.
 *
 * Step order and the token-sort are load-bearing, not stylistic — they
 * are what makes "Domaine Jean Grivot" and "Jean Grivot Domaine" an
 * EXACT match instead of a fuzzy one (docs/plans §5). Token-sort can
 * theoretically conflate two DIFFERENT producers whose names are
 * word-order permutations of each other; the mitigation is structural,
 * not a threshold — the exact-match identity key is never producer-alone,
 * it is always (producer_norm, cuvee_norm) for canonical identity plus
 * (vintage, size_ml) for variant identity, so an accidental collision
 * would require all four to coincide.
 */
// P2 ROUND-2 FIX (D3 - scratchpad db-audit/verify/P2-critic-r1.md): before
// this fix, "O'Brien's Vineyard" and "O.S. Brien Vineyard" normalized to
// the IDENTICAL token multiset {"brien","o","s","vineyard"} - a
// possessive apostrophe ("Brien's" -> stray "brien"+"s" tokens) and a
// pair of period-separated initials ("O.S." -> stray "o"+"s" tokens) are,
// after the general non-alnum-to-space collapse below, indistinguishable
// single-character tokens, so an over-merge was possible even though the
// two names are plausibly different real-world producers. The extra
// .replace() call merges a trailing possessive "'s" into its host word
// BEFORE that general collapse, so "Brien's" -> "briens" (one token)
// instead of "brien"+"s" (two tokens, one a coincidence-prone stray).
// This targets ONLY the possessive-suffix pattern (apostrophe
// immediately before a word-final "s") and deliberately leaves every
// other apostrophe position untouched - in particular a name-internal
// apostrophe like "d'Alsace" (P1's own punctuation_spacing golden
// vector, "Coeur d'Alsace") still splits exactly as before, which is
// required to stay byte-for-byte identical to P1's frozen
// normalizeForDedup (P1's worktree is not editable from here - see the
// file header). Confirmed via grep against P1's fixture generator that
// no producer/cuvee/name field in its seed data uses a possessive "'s",
// so this cannot affect any of P1's 40 golden vectors or the live
// 110-check matrix - it only changes behavior for inputs the graded
// fixture never exercises.
export function normalizeProducerOrCuvee(raw: string): string {
  const folded = raw
    .replace(/œ/gi, "oe")
    .replace(/æ/gi, "ae")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]s(?=\s|$)/g, "s")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return folded.split(" ").filter(Boolean).sort().join(" ");
}

/**
 * Closed allowlist of "no vintage" text — deliberately not a fuzzy
 * detector. A fuzzy "is this NV?" heuristic risks reclassifying
 * genuinely malformed vintage text ("202X", "circa 1998", "'98") as
 * legitimate non-vintage data, which is corruption in the OPPOSITE
 * direction from the fuzzy-identity risk the rest of this module guards
 * against. Every string here is an unambiguous, closed synonym for "this
 * wine legitimately has no vintage" — nothing here is a guess.
 */
const NV_SYNONYMS = new Set(["NV", "N V", "NON VINTAGE", "NONVINTAGE", "MV", "MULTI VINTAGE"]);

function collapseVintageText(raw: string): string {
  return raw.trim().toUpperCase().replace(/[.\-/]/g, " ").replace(/\s+/g, " ").trim();
}

/** True iff raw's collapsed form is one of the closed NV-synonym set —
 * this IS the identity fact "no vintage," not an error. Exported
 * separately from normalizeVintage so
 * src/domains/import/row-validator.ts can check it BEFORE its own
 * existing numeric-parse-and-range validation, skipping that branch on a
 * hit rather than routing every vintage cell through a function that
 * throws for the invalid case. */
export function isNvVintageText(raw: string): boolean {
  return NV_SYNONYMS.has(collapseVintageText(raw));
}

/**
 * Parse a raw vintage cell into its identity year, or null for NV/empty
 * (both are the same identity fact: "no vintage"). Throws for anything
 * else that is not a valid year in [MIN_VINTAGE, CURRENT_YEAR + 1] — the
 * existing numeric-parse-and-range check, unchanged.
 *
 * Deliberate design note: null and "throws" are kept as two DISTINCT
 * outcomes rather than collapsing everything unparseable to null. If
 * "genuinely malformed" and "NV" both returned null, a caller could not
 * tell them apart — which is exactly the "corruption in the opposite
 * direction" the NV_SYNONYMS comment above warns about. Callers that
 * need a field-level validation error (row-validator.ts) catch the
 * throw; callers downstream of already-validated rows (identity
 * resolution) never see it, because row-validator has already rejected
 * malformed text by the time that pipeline runs.
 */
export function normalizeVintage(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (isNvVintageText(trimmed)) return null;

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < MIN_VINTAGE || parsed > CURRENT_YEAR + 1) {
    throw new Error(`invalid vintage text: ${raw}`);
  }
  return parsed;
}

/**
 * Closed lookup for bottle-format text -> size_ml, for a CSV row-
 * validator to consult when size_ml is blank but a text format column is
 * present (docs/plans/2026-08-23-p2-identity-spine.md §5). Closed, not
 * fuzzy, for the same reason as NV_SYNONYMS. Not wired into any P2 code
 * path — P2's own CSV fields never populate a bare format-only column
 * without size_ml — this is exported for P3's row-validator to consult.
 */
export const FORMAT_SIZE_ML: Readonly<Record<string, number>> = Object.freeze({
  split: 187,
  piccolo: 187,
  half: 375,
  demi: 375,
  bottle: 750,
  magnum: 1500,
  "double magnum": 3000,
  jeroboam: 3000, // Bordeaux jeroboam == double magnum (per the plan's own resolution of the Bordeaux/Champagne jeroboam-size ambiguity)
  rehoboam: 4500,
  methuselah: 6000,
  imperial: 6000,
  salmanazar: 9000,
  balthazar: 12000,
  nebuchadnezzar: 15000,
});
