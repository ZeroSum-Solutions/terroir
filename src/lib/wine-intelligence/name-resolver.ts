// Server-side wine-name resolution for the voice paths (SPEC-19/20/21
// precursor; VWP-FR-024..026). Resolves a raw STT transcript against a
// bounded candidate list (a venue inventory / catalog slice) and returns
// resolved / ambiguous / abstain — never a bare-threshold accept.
//
// DESIGN PROVENANCE (honest split — see the terroir-overnight run log and the
// GPT-5.6 Sol audit of 2026-08-25 that reshaped this rule):
//
// Grounded in independent measurement (spikes 1 + 9, docs/plans/2026-08-25-*):
//   - accept threshold 0.30 = match_lwin's production threshold (0078);
//   - accent folding both sides: live pg_trgm scores
//     similarity('côte-rôtie','cote rotie') = 0.294 < 0.30, catalog 99.75% ASCII;
//   - producer corroboration as a concept: naive thresholds misidentify
//     cross-producer at 31–50% on the open catalog; corroboration cuts it to
//     6–8% (spike-1 full-catalog replay);
//   - same-producer multi-bottling ambiguity as a product state (spike 1: ~8%
//     wrong-cuvée class; SPEC-20's disambiguation-list contract).
// Fitted on the spike-9 TUNING fixture (134 cases — NOT sealed acceptance
// evidence; SPEC-21's untouched partner-weighted holdout is the acceptance
// gate): word-similarity bars 0.5/0.3, margin floor 0.02, producer-df cap 3,
// the carrier/style word lists, and the attribution window. Treat these as
// engineering defaults to re-derive at SPEC-21 time, not measured constants.
//
// THE RULE (v5, post-audit):
//   1. Score candidates by best span-trigram similarity (accent-folded,
//      pg_trgm-parity — see below). Below 0.30 → abstain.
//   2. ATTRIBUTION CONTRADICTION: "from/by <name>" whose name-words match no
//      winner-row word at >= 0.5 means the guest attributed a producer we do
//      not stock as the winner → abstain. (Kills "Brunello … from
//      Biondi-Santi" → Fanti at 0.59, and "… from Santi" → Fanti 0.333.)
//   3. PRODUCER CORROBORATION, word-level: a transcript word must match one
//      of the winner-producer's INFORMATIVE words at >= 0.5. Informative
//      excludes generic winery/style vocabulary, carrier words, and any word
//      whose producer-level document frequency (count of DISTINCT producers
//      whose rows contain it) reaches 3 — an ABSOLUTE cap, so growing the
//      inventory can only remove corroborating power, never add it (audit:
//      the proportional cap was non-monotone; and 'romanee' must never
//      corroborate DRC on a "Vosne-Romanée" query).
//   4. SAME-PRODUCER SUBSET AMBIGUITY: if the runner-up shares the winner's
//      producer, scores above threshold, and the winner's row words are a
//      subset of the runner's, the utterance cannot have distinguished the
//      bottlings ("Roumier Musigny" vs "Roumier Musigny Vieilles Vignes") →
//      ambiguous, surfacing both for SPEC-20's disambiguation list.
//   5. UNCORROBORATED ARM (cuvée-only requests): accept only when (a) no
//      unexplained name-like residue remains (length >= 4, non-carrier,
//      non-numeric, matching no winner-row word at >= 0.3), (b) at least one
//      spoken word matches a DISTINCTIVE winner-row word (producer-df < 3) at
//      >= 0.5 — a bare high-frequency grape word ("cabernet") resolves
//      nothing — and (c) the margin over the runner-up is >= 0.02.
//   Every error path is an abstention or a truth-preserving disambiguation;
//   on the tuning fixture: 25/48 resolved + 16/48 disambiguated (truth always
//   in the list) + 7 abstained, 16/16 out-of-inventory pure abstentions,
//   6/6 garbage, ZERO wrong-wine on both STT configs.
//
// PARITY: similarity()/bestSpanSimilarity() are numerically pinned via
// fixtures/trgm-parity-vectors.json to the spike-1 Python implementation,
// which was validated byte-exact (max |delta| 0.000000, 203 pairs) against
// live Postgres 16 pg_trgm on accent-folded/ASCII material. The œ/æ pre-fold
// is an app-side folding extension consistent with the identity normalizer,
// NOT part of the pg validation. fixtures/generate.py is the committed
// generator; regenerate vectors through it if norm/trigram behavior changes.
//
// This module is deliberately unwired: no route imports it yet. It becomes
// the resolution core of SPEC-20's constrained retrieval tool at ticket time.

export interface WineCandidate {
  itemId: string;
  lwinId?: string;
  displayName: string;
  producer: string;
}

export interface ScoredCandidate {
  candidate: WineCandidate;
  /** best span-trigram similarity of "producer displayName" vs the transcript */
  score: number;
  /** word-level producer corroboration score (rule 3) */
  producerScore: number;
}

export type ResolveOutcome =
  | { kind: "resolved"; match: ScoredCandidate; margin: number; runnerUp?: ScoredCandidate }
  | { kind: "ambiguous"; candidates: ScoredCandidate[] }
  | {
      kind: "abstain";
      reason: "empty_transcript" | "below_threshold" | "contradicted" | "no_corroboration";
      /** the losing best candidate, surfaced for UX correction-search */
      best?: ScoredCandidate;
    };

export interface ResolveOptions {
  /** primary accept threshold — match_lwin's 0.30 (0078); (0, 1] */
  acceptThreshold?: number;
  /** word-level bar for producer corroboration and attribution names; (0, 1] */
  producerWordThreshold?: number;
  /** minimum top1–top2 margin for the uncorroborated arm; [0, 1) */
  marginFloor?: number;
  /** a transcript word explains itself by matching a row word at this sim; (0, 1] */
  residueMatchThreshold?: number;
  /** margin at/below which two corroborated candidates are indistinguishable; [0, 1) */
  ambiguityMargin?: number;
}

const DEFAULTS: Required<ResolveOptions> = {
  acceptThreshold: 0.3,
  producerWordThreshold: 0.5,
  marginFloor: 0.02,
  residueMatchThreshold: 0.3,
  ambiguityMargin: 0.01,
};

// Voice utterances are short; the scoring cost is quadratic-ish in transcript
// length, so a runaway transcript (STT glitch, abuse) is truncated rather
// than scored unbounded (audit: 5,000 words took seconds AND still resolved).
const MAX_TRANSCRIPT_WORDS = 120;
// Producer-level document frequency at/above which a word stops being
// producer identity (absolute — monotone under inventory growth).
const PRODUCER_DF_CAP = 3;

function validateOptions(opts: Required<ResolveOptions>): void {
  const inUnitOpen = (v: number) => Number.isFinite(v) && v > 0 && v <= 1;
  const inUnitClosed = (v: number) => Number.isFinite(v) && v >= 0 && v < 1;
  if (!inUnitOpen(opts.acceptThreshold)) throw new RangeError(`acceptThreshold must be in (0,1]: ${opts.acceptThreshold}`);
  if (!inUnitOpen(opts.producerWordThreshold)) throw new RangeError(`producerWordThreshold must be in (0,1]: ${opts.producerWordThreshold}`);
  if (!inUnitOpen(opts.residueMatchThreshold)) throw new RangeError(`residueMatchThreshold must be in (0,1]: ${opts.residueMatchThreshold}`);
  if (!inUnitClosed(opts.marginFloor)) throw new RangeError(`marginFloor must be in [0,1): ${opts.marginFloor}`);
  if (!inUnitClosed(opts.ambiguityMargin)) throw new RangeError(`ambiguityMargin must be in [0,1): ${opts.ambiguityMargin}`);
}

/** Fold to the ASCII domain the catalog lives in: ligature expansion (œ/æ,
 * matching src/domains/identity/normalize.ts), then NFKD-decompose and strip
 * combining marks. SPEC-19/21 make this a precondition of ANY trigram
 * comparison against the catalog. */
export function foldAccents(s: string): string {
  return s
    .replace(/œ/g, "oe")
    .replace(/Œ/g, "Oe")
    .replace(/æ/g, "ae")
    .replace(/Æ/g, "Ae")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
}

// Mirror of the spike-1 Python norm() (composed with the œ/æ pre-fold): fold,
// lower, apostrophe/hyphen to space, non-alphanumeric to space, collapse.
// NOT the same contract as normalizeProducerOrCuvee in
// src/domains/identity/normalize.ts — that one builds an order-insensitive
// dedup key (words sorted), which destroys the spans trigram matching
// depends on. Keep them separate.
function norm(s: string): string {
  return foldAccents(s)
    .toLowerCase()
    .replace(/['-]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** pg_trgm's trigram set: per word, pad "  word " and take all 3-grams. */
function trigramSet(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of norm(s).match(/[a-z0-9]+/g) ?? []) {
    const p = `  ${w} `;
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function similarity(a: string, b: string): number {
  return jaccard(trigramSet(a), trigramSet(b));
}

interface SpanIndex {
  words: string[];
  wordTris: Set<string>[];
  /** trigram set per contiguous word-span, keyed "start:width" */
  bySpan: Map<string, Set<string>>;
}

function buildSpans(transcript: string, maxWidth: number): SpanIndex {
  const words = norm(transcript).split(" ").filter(Boolean).slice(0, MAX_TRANSCRIPT_WORDS);
  const bySpan = new Map<string, Set<string>>();
  const cap = Math.min(maxWidth, words.length);
  for (let width = 1; width <= cap; width++) {
    for (let i = 0; i + width <= words.length; i++) {
      bySpan.set(`${i}:${width}`, trigramSet(words.slice(i, i + width).join(" ")));
    }
  }
  const wordTris = words.map((w) => trigramSet(w));
  return { words, wordTris, bySpan };
}

function bestSpanAgainst(index: SpanIndex, targetTris: Set<string>, targetWords: number): number {
  // Same width policy as the pinned Python: widths 1..target_words+2, bounded
  // by transcript length (short/joined STT output must still be scoreable).
  let best = 0;
  const cap = Math.min(targetWords + 2, index.words.length);
  for (let width = 1; width <= cap; width++) {
    for (let i = 0; i + width <= index.words.length; i++) {
      const s = jaccard(targetTris, index.bySpan.get(`${i}:${width}`)!);
      if (s > best) best = s;
    }
  }
  return best;
}

export function bestSpanSimilarity(target: string, transcript: string): number {
  const targetWords = norm(target).split(" ").filter(Boolean).length;
  const index = buildSpans(transcript, targetWords + 2);
  return bestSpanAgainst(index, trigramSet(target), targetWords);
}

// Winery-form and wine-style words that carry no producer identity on their
// own; corroboration from these alone would let any "Domaine …" transcript
// corroborate any "Domaine …" producer, and a "… Reserve" cuvée word must
// never act as producer evidence (audit counterexample).
const GENERIC_PRODUCER_WORDS = new Set([
  "domaine", "chateau", "bodega", "bodegas", "weingut", "cantina", "tenuta",
  "azienda", "agricola", "maison", "winery", "cellars", "estate", "vineyard",
  "vineyards", "wines", "les", "des", "dei", "della", "delle",
  "reserve", "reserva", "riserva", "gran", "grand", "premier", "cru",
  "vieilles", "vignes", "cuvee", "blanc", "rouge", "rosso", "bianco", "tinto",
  "brut", "sec", "demi", "vintage", "old", "vine",
]);

// Carrier/function words a spoken request wraps around a wine name. A residue
// check must not treat "how many … are left" as an unexplained name. English
// carrier vocabulary only — non-English junk deliberately stays name-like
// (vetoing it converts errors into abstentions, the NFR direction). Fitted on
// the tuning fixture; revisited under SPEC-21's sealed eval.
const CARRIER_WORDS = new Set(
  (
    "the a an of from for to in on at by with and or is are was were be been being " +
    "do does did done have has had we i you it they he she this that these those " +
    "there here what which who whom whose how when where why not no yes out up down " +
    "left right many much more most some any few all both each every still just also " +
    "again too very please thank thanks can could would should will shall may might " +
    "must get got give bring add count check need want like open another one two " +
    "three four five six seven eight nine ten glass glasses bottle bottles case cases " +
    "list menu table guest guests cellar safe room tonight today buy sell pour taste"
  ).split(" "),
);

// English producer-attribution markers: "the X from <producer>", "by <producer>".
const ATTRIBUTION_WORDS = new Set(["from", "by"]);

/** words per producer-row, normalized once */
function rowWordsOf(c: WineCandidate): string[] {
  return norm(`${c.producer} ${c.displayName}`).split(" ").filter(Boolean);
}

/** Producer-level document frequency: for each word, the number of DISTINCT
 * producers whose row text contains it. */
function producerDf(candidates: readonly WineCandidate[]): Map<string, number> {
  const byWord = new Map<string, Set<string>>();
  for (const c of candidates) {
    const pkey = norm(c.producer);
    for (const w of new Set(rowWordsOf(c))) {
      let s = byWord.get(w);
      if (!s) byWord.set(w, (s = new Set()));
      s.add(pkey);
    }
  }
  const df = new Map<string, number>();
  for (const [w, s] of byWord) df.set(w, s.size);
  return df;
}

function informativeProducerWords(producer: string, df: Map<string, number>): string[] {
  return norm(producer)
    .split(" ")
    .filter(
      (w) =>
        w.length >= 3 &&
        !GENERIC_PRODUCER_WORDS.has(w) &&
        !CARRIER_WORDS.has(w) &&
        (df.get(w) ?? 0) < PRODUCER_DF_CAP,
    );
}

export function resolveWineName(
  transcript: string,
  candidates: readonly WineCandidate[],
  options?: ResolveOptions,
): ResolveOutcome {
  const opts = { ...DEFAULTS, ...options };
  validateOptions(opts);

  const df = producerDf(candidates);
  const rowWords = candidates.map(rowWordsOf);
  const maxCandidateWords = rowWords.reduce((m, ws) => Math.max(m, ws.length), 0);
  const index = buildSpans(transcript, maxCandidateWords + 2);
  if (index.words.length === 0) {
    return { kind: "abstain", reason: "empty_transcript" };
  }

  const scored: ScoredCandidate[] = candidates.map((candidate, i) => {
    const rowText = rowWords[i].join(" ");
    let producerScore = 0;
    for (const pw of informativeProducerWords(candidate.producer, df)) {
      const pt = trigramSet(pw);
      for (const wt of index.wordTris) {
        const s = jaccard(pt, wt);
        if (s > producerScore) producerScore = s;
      }
    }
    return {
      candidate,
      score: bestSpanAgainst(index, trigramSet(rowText), rowWords[i].length),
      producerScore,
    };
  });
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < opts.acceptThreshold) {
    return { kind: "abstain", reason: "below_threshold", best: top };
  }
  const runnerUp = scored[1];
  const margin = top.score - (runnerUp?.score ?? 0);
  const topRowWords = rowWordsOf(top.candidate);
  const topRowTris = topRowWords.map((w) => trigramSet(w));

  const explainedAt = (wordTris: Set<string>, bar: number): boolean =>
    topRowTris.some((rt) => jaccard(wordTris, rt) >= bar);

  // Rule 2 — attribution contradiction: "from/by <name>" whose name-words
  // (first 2 content words in the following window) all fail the strict bar
  // against the winner's row.
  let contradicted = false;
  for (let i = 0; i < index.words.length && !contradicted; i++) {
    if (!ATTRIBUTION_WORDS.has(index.words[i])) continue;
    const followers: number[] = [];
    for (let j = i + 1; j < Math.min(i + 4, index.words.length) && followers.length < 2; j++) {
      const w = index.words[j];
      if (w.length >= 3 && !CARRIER_WORDS.has(w) && !/^\d+$/.test(w)) followers.push(j);
    }
    if (followers.length > 0 && !followers.some((j) => explainedAt(index.wordTris[j], opts.producerWordThreshold))) {
      contradicted = true;
    }
  }

  // Rule 4 — same-producer subset ambiguity: the utterance cannot have
  // distinguished a bottling whose row words are contained in its sibling's.
  const subsetAmbiguous = (): boolean => {
    if (!runnerUp || runnerUp.score < opts.acceptThreshold) return false;
    if (norm(top.candidate.producer) !== norm(runnerUp.candidate.producer)) return false;
    const r2 = new Set(rowWordsOf(runnerUp.candidate));
    return topRowWords.every((w) => r2.has(w));
  };

  if (top.producerScore >= opts.producerWordThreshold && !contradicted) {
    if (subsetAmbiguous()) return { kind: "ambiguous", candidates: [top, runnerUp!] };
    if (
      runnerUp &&
      runnerUp.score >= opts.acceptThreshold &&
      margin <= opts.ambiguityMargin &&
      runnerUp.producerScore >= opts.producerWordThreshold
    ) {
      return { kind: "ambiguous", candidates: [top, runnerUp] };
    }
    return { kind: "resolved", match: top, margin, runnerUp };
  }
  if (contradicted) {
    return { kind: "abstain", reason: "contradicted", best: top };
  }

  // Rule 5 — uncorroborated arm: residue-free + distinctive evidence + margin.
  const hasResidue = index.words.some((w, i) => {
    if (w.length < 4 || CARRIER_WORDS.has(w) || /^\d+$/.test(w)) return false;
    return !explainedAt(index.wordTris[i], opts.residueMatchThreshold);
  });
  const hasDistinctiveEvidence = topRowWords.some((rw) => {
    if (rw.length < 3 || GENERIC_PRODUCER_WORDS.has(rw) || CARRIER_WORDS.has(rw)) return false;
    if ((df.get(rw) ?? 0) >= PRODUCER_DF_CAP) return false;
    const rt = trigramSet(rw);
    return index.wordTris.some((wt) => jaccard(wt, rt) >= opts.producerWordThreshold);
  });
  if (!hasResidue && hasDistinctiveEvidence && margin >= opts.marginFloor) {
    if (subsetAmbiguous()) return { kind: "ambiguous", candidates: [top, runnerUp!] };
    return { kind: "resolved", match: top, margin, runnerUp };
  }
  return { kind: "abstain", reason: "no_corroboration", best: top };
}
