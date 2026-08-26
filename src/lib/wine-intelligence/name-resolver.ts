// Server-side wine-name resolution for the voice paths (SPEC-19/20/21
// precursor; VWP-FR-024..026). Resolves a raw STT transcript against a
// bounded candidate list (a venue inventory / catalog slice) and returns
// resolved / ambiguous / abstain — never a bare-threshold accept.
//
// Every rule here is forced by a measured spike finding
// (docs/plans/2026-08-25-spike-01-stt-vendor-eval.md, -spike-09-), and the
// design iterations that produced the final rule are logged in the
// terroir-overnight goal run (2026-08-25):
//
//   1. ACCENT FOLDING both sides: live pg_trgm scores
//      similarity('côte-rôtie','cote rotie') = 0.294 — BELOW match_lwin's 0.3
//      threshold — and the catalog is 99.75% ASCII while AssemblyAI emits
//      accented transcripts.
//   2. PRODUCER CORROBORATION, word-level + document-frequency-filtered.
//      Bare similarity thresholds misidentify across producers at 31–50% on
//      the open catalog (shared appellation vocabulary dominates the trigram
//      mass). Span-trigram corroboration at 0.30 accepts near-namesakes
//      (measured: 'santi' corroborates 'Fanti' at 0.333), so corroboration is
//      word-to-word at >= 0.5 against the producer's INFORMATIVE words:
//      generic winery words are excluded, and so is any producer word common
//      across the candidate list (df cap) — without the df filter, DRC's
//      producer word 'romanee' corroborates ANY "Vosne-Romanée …" query at
//      1.0, the exact confident-wrong failure the abstain-over-misidentify
//      NFR forbids. The df-cap device follows spike-1's resolver replay
//      (DF_CAP: high-frequency tokens don't nominate candidates).
//   3. UNCORROBORATED ("margin") ARM = residue veto. A top candidate whose
//      producer is never spoken may still be accepted (the guest named only
//      the cuvée: "the Musigny Grand Cru") — but ONLY when the transcript
//      contains no unexplained name-like residue: a word of length >= 4,
//      not a carrier/function word, not a number, matching NO word of the
//      winning row at >= 0.3. Measured motivation: the out-of-inventory
//      false accepts ("Brunello di Montalcino from Biondi-Santi" -> Fanti's
//      Brunello at 0.59, "Trockenbeerenauslese from Dönnhoff" -> J.J. Prüm's
//      TBA) all carry exactly such residue ('biondi', 'donnhoff'), while the
//      legitimate cuvée-only accepts have every wine word explained by the
//      winning row. STT-garbled residue also vetoes — that converts
//      would-be-resolutions into abstentions, never into wrong wines, which
//      is the NFR's stated preference. Measured on the spike-9 replay
//      (shipping STT config): 85.4% resolve, 100% out-of-inventory
//      abstention, 0 wrong-wine resolutions, 0 garbage accepts.
//
// similarity()/bestSpanSimilarity() are numerically pinned to the spike-1
// Python implementation — itself validated byte-exact (max |delta| 0.000000,
// 203 pairs) against live Postgres 16 pg_trgm, the operator match_lwin (0078)
// uses — via fixtures/trgm-parity-vectors.json golden vectors. Do not "fix"
// their behavior without regenerating the vectors against live pg_trgm.
//
// This module is deliberately unwired: no route imports it yet. It becomes
// the resolution core of SPEC-20's constrained retrieval tool at ticket time;
// thresholds are revisited under SPEC-21's full eval before any demo line is
// rehearsed.

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
  /** word-level producer corroboration score (see producerCorroboration) */
  producerScore: number;
}

export type ResolveOutcome =
  | { kind: "resolved"; match: ScoredCandidate; margin: number; runnerUp?: ScoredCandidate }
  | { kind: "ambiguous"; candidates: ScoredCandidate[] }
  | {
      kind: "abstain";
      reason: "empty_transcript" | "below_threshold" | "no_corroboration";
      /** the losing best candidate, surfaced for UX correction-search */
      best?: ScoredCandidate;
    };

export interface ResolveOptions {
  /** primary accept threshold — match_lwin's 0.30 (0078) */
  acceptThreshold?: number;
  /** word-level producer corroboration threshold */
  producerWordThreshold?: number;
  /** minimum top1–top2 margin for the uncorroborated (residue-vetoed) arm */
  marginFloor?: number;
  /** a transcript word explains itself by matching a row word at this sim */
  residueMatchThreshold?: number;
  /** margin at/below which two corroborated candidates are indistinguishable */
  ambiguityMargin?: number;
}

const DEFAULTS: Required<ResolveOptions> = {
  acceptThreshold: 0.3,
  producerWordThreshold: 0.5,
  marginFloor: 0.02,
  residueMatchThreshold: 0.3,
  ambiguityMargin: 0.01,
};

/** NFKD-decompose and strip combining marks. Exported because SPEC-19/21 make
 * accent folding a precondition of ANY trigram comparison against the
 * catalog. */
export function foldAccents(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}+/gu, "");
}

// Mirror of the spike-1 Python norm(): fold, lower, apostrophe/hyphen to
// space, non-alphanumeric to space, collapse. NOT the same contract as
// normalizeProducerOrCuvee in src/domains/identity/normalize.ts — that one
// builds an order-insensitive dedup key (words sorted), which destroys the
// spans trigram matching depends on. Keep them separate.
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
  const words = norm(transcript).split(" ").filter(Boolean);
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

// Producer words that carry no identity on their own; corroboration from
// these alone would let any "Domaine …" transcript corroborate any
// "Domaine …" producer.
const GENERIC_PRODUCER_WORDS = new Set([
  "domaine", "chateau", "bodega", "bodegas", "weingut", "cantina", "tenuta",
  "azienda", "agricola", "maison", "winery", "cellars", "estate", "vineyard",
  "vineyards", "wines", "les", "des", "dei", "della", "delle",
]);

// Carrier/function words a spoken request wraps around a wine name. A residue
// check must not treat "how many … are left" as an unexplained name. English
// carrier vocabulary only — non-English junk deliberately stays name-like
// (vetoing it converts errors into abstentions, the NFR direction). Revisited
// under SPEC-21's full eval.
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

/** Max word-to-word trigram similarity between the producer's informative
 * words and the transcript's words. Informative = length >= 3, not a generic
 * winery word, and rarer than the df cap across the candidate list (a
 * producer word shared by many rows is appellation vocabulary, not identity —
 * 'romanee' must never corroborate DRC on a "Vosne-Romanée" query). Producers
 * with no informative word simply cannot corroborate (their wines resolve via
 * the residue-vetoed arm). */
function producerCorroboration(index: SpanIndex, producer: string, df: Map<string, number>, dfCap: number): number {
  const words = norm(producer)
    .split(" ")
    .filter((w) => w.length >= 3 && !GENERIC_PRODUCER_WORDS.has(w) && (df.get(w) ?? 0) <= dfCap);
  let best = 0;
  for (const pw of words) {
    const pt = trigramSet(pw);
    for (const wt of index.wordTris) {
      const s = jaccard(pt, wt);
      if (s > best) best = s;
    }
  }
  return best;
}

export function resolveWineName(
  transcript: string,
  candidates: readonly WineCandidate[],
  options?: ResolveOptions,
): ResolveOutcome {
  const opts = { ...DEFAULTS, ...options };

  const rowTexts = candidates.map((c) => norm(`${c.producer} ${c.displayName}`));
  const df = new Map<string, number>();
  for (const rt of rowTexts) {
    for (const w of new Set(rt.split(" ").filter(Boolean))) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const dfCap = Math.max(2, Math.ceil(0.02 * candidates.length));

  const maxCandidateWords = rowTexts.reduce((m, rt) => Math.max(m, rt.split(" ").filter(Boolean).length), 0);
  const index = buildSpans(transcript, maxCandidateWords + 2);
  if (index.words.length === 0) {
    return { kind: "abstain", reason: "empty_transcript" };
  }

  const scored: ScoredCandidate[] = candidates.map((candidate, i) => {
    const rowWords = rowTexts[i].split(" ").filter(Boolean).length;
    return {
      candidate,
      score: bestSpanAgainst(index, trigramSet(rowTexts[i]), rowWords),
      producerScore: producerCorroboration(index, candidate.producer, df, dfCap),
    };
  });
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < opts.acceptThreshold) {
    return { kind: "abstain", reason: "below_threshold", best: top };
  }
  const runnerUp = scored[1];
  const margin = top.score - (runnerUp?.score ?? 0);

  if (top.producerScore >= opts.producerWordThreshold) {
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

  // Uncorroborated arm: accept only a residue-free transcript with a real lead.
  const rowWordSet = norm(`${top.candidate.producer} ${top.candidate.displayName}`)
    .split(" ")
    .filter(Boolean)
    .map((w) => trigramSet(w));
  const hasResidue = index.words.some((w, i) => {
    if (w.length < 4 || CARRIER_WORDS.has(w) || /^\d+$/.test(w)) return false;
    const wt = index.wordTris[i];
    return !rowWordSet.some((rw) => jaccard(wt, rw) >= opts.residueMatchThreshold);
  });
  if (!hasResidue && margin >= opts.marginFloor) {
    return { kind: "resolved", match: top, margin, runnerUp };
  }
  return { kind: "abstain", reason: "no_corroboration", best: top };
}
