// Pure helpers for the WS-IDENT batch run and its QA harness
// (docs/plans/2026-08-31-ws-ident-identity-policy.md §2 step 1, §4).
//
// The seed pass is an EXACT join on identity-normalized (producer, cuvée) —
// the same normalization that defines canonical_wines' identity key, so what
// joins here is precisely what the spine itself would call the same wine. A
// normalized key claimed by more than one corpus row is never resolved by
// picking one; the caller falls through to the trigram pass, whose ambiguity
// guard routes the near-tie to review.
//
// Everything here is deterministic on purpose: an interrupted run resumed
// later, or a re-run at the same rule version, must decide and sample
// identically. Sampling uses a seeded PRNG, never Math.random.
import { normalizeProducerOrCuvee } from "@/domains/identity/normalize";

/** Normalized join key, or null when either side normalizes to nothing. */
export function exactKey(producer: string, cuvee: string): string | null {
  const p = normalizeProducerOrCuvee(producer);
  const c = normalizeProducerOrCuvee(cuvee);
  if (p === "" || c === "") return null;
  return `${p}|${c}`;
}

export type XwinesExactRow = {
  wineId: number;
  wineryName: string | null;
  name: string;
};

/** All corpus rows per normalized key — duplicates kept so lookups can refuse them. */
export function buildXwinesExactIndex(rows: readonly XwinesExactRow[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const row of rows) {
    if (row.wineryName === null) continue;
    const key = exactKey(row.wineryName, row.name);
    if (key === null) continue;
    const existing = index.get(key);
    if (existing) existing.push(row.wineId);
    else index.set(key, [row.wineId]);
  }
  return index;
}

/**
 * Try each producer form in order (display-segment honorific form first, then
 * the bare producer column) against the index. The first key present decides:
 * a unique claim links, a contested one is "ambiguous" and must go to the
 * scored pass — an exact join that guessed between siblings would be a false
 * merge wearing the costume of certainty.
 */
export function lookupExact(
  index: ReadonlyMap<string, number[]>,
  producerCandidates: readonly string[],
  cuvee: string,
): { wineId: number } | "ambiguous" | null {
  for (const producer of producerCandidates) {
    const key = exactKey(producer, cuvee);
    if (key === null) continue;
    const ids = index.get(key);
    if (!ids) continue;
    return ids.length === 1 ? { wineId: ids[0] } : "ambiguous";
  }
  return null;
}

// The colour vocabulary the corpus's own naming uses for splits of one cuvée
// (identity policy §1: colour is part of label identity; §4 names the
// Rouge/Blanc/Rosé triplet as the first negative class).
const COLOUR_TOKENS = new Set([
  "rouge", "blanc", "rose", // fr (rosé folds to "rose")
  "red", "white",
  "tinto", "blanco", "rosado", // es
  "rosso", "bianco", "rosato", // it
]);

/**
 * Classify a same-winery name pair for the §4 negative set.
 *
 * "colour": the names are the same cuvée once colour tokens are removed, and
 * their colour tokens differ (one side may have none — "Côtes-du-Rhône" vs
 * "Côtes-du-Rhône Rosé" is still the colour class). "qualifier": one name's
 * tokens are a strict subset of the other's — Riserva/normale and
 * village/vineyard-designate both take this shape. Null: not a risk-class
 * pair. Symmetric in its arguments.
 */
export function classifySiblingPair(nameA: string, nameB: string): "colour" | "qualifier" | null {
  const tokensA = normalizeProducerOrCuvee(nameA).split(" ").filter(Boolean);
  const tokensB = normalizeProducerOrCuvee(nameB).split(" ").filter(Boolean);
  if (tokensA.length === 0 || tokensB.length === 0) return null;

  const colourA = new Set(tokensA.filter((t) => COLOUR_TOKENS.has(t)));
  const colourB = new Set(tokensB.filter((t) => COLOUR_TOKENS.has(t)));
  const baseA = tokensA.filter((t) => !COLOUR_TOKENS.has(t)).join(" ");
  const baseB = tokensB.filter((t) => !COLOUR_TOKENS.has(t)).join(" ");
  const coloursDiffer =
    colourA.size !== colourB.size ||
    [...colourA].some((t) => !colourB.has(t));
  if (baseA === baseB && coloursDiffer) return "colour";

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const aInB = tokensA.every((t) => setB.has(t));
  const bInA = tokensB.every((t) => setA.has(t));
  if (aInB !== bInA) return "qualifier"; // strict subset one way only

  return null;
}

/**
 * Coverage-report band for a blended score (§4). The lowest edge is the
 * acceptance floor, so "<0.65" can only hold review rows.
 */
export function scoreBandLabel(score: number): string {
  if (score < 0.65) return "<0.65";
  if (score < 0.75) return "0.65–0.75";
  if (score < 0.85) return "0.75–0.85";
  if (score < 0.95) return "0.85–0.95";
  return "0.95–1.00";
}

// mulberry32 — tiny deterministic PRNG; quality is irrelevant here, stability
// across runs is the requirement.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Deterministic stratified sample of `n` items (§4's 200-link positive
 * review): proportional allocation by largest remainder, every non-empty
 * stratum kept represented while `n` allows, per-stratum order shuffled by a
 * PRNG seeded from `seed` + the stratum name. Returns the whole population
 * when it is smaller than `n`.
 */
export function stratifiedSample<T>(
  items: readonly T[],
  stratumOf: (item: T) => string,
  n: number,
  seed: number,
): T[] {
  if (items.length <= n) return [...items];

  const strata = new Map<string, T[]>();
  for (const item of items) {
    const key = stratumOf(item);
    const bucket = strata.get(key);
    if (bucket) bucket.push(item);
    else strata.set(key, [item]);
  }

  const names = [...strata.keys()].sort();
  // Floor of the proportional share, at least 1 while n covers the strata.
  const quotas = new Map<string, number>();
  const guaranteed = names.length <= n ? 1 : 0;
  let allocated = 0;
  const remainders: Array<{ name: string; remainder: number }> = [];
  for (const name of names) {
    const share = (strata.get(name)!.length / items.length) * n;
    const quota = Math.max(guaranteed, Math.min(Math.floor(share), strata.get(name)!.length));
    quotas.set(name, quota);
    allocated += quota;
    remainders.push({ name, remainder: share - Math.floor(share) });
  }
  remainders.sort((a, b) => b.remainder - a.remainder || (a.name < b.name ? -1 : 1));
  for (const { name } of remainders) {
    if (allocated >= n) break;
    const size = strata.get(name)!.length;
    const quota = quotas.get(name)!;
    if (quota < size) {
      quotas.set(name, quota + 1);
      allocated += 1;
    }
  }

  const sample: T[] = [];
  for (const name of names) {
    const rand = mulberry32((seed ^ hashString(name)) >>> 0);
    const take = Math.min(quotas.get(name)!, n - sample.length);
    sample.push(...shuffled(strata.get(name)!, rand).slice(0, take));
  }
  return sample;
}
