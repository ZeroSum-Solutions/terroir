// Deterministic facet-filter intent parser for the voice cellar control
// (SPEC-19 fallback path; VWP voice-intake precursor). When resolveWineName
// (./name-resolver.ts) abstains on a facet-only utterance like "pull up any
// wines from California", this module matches the transcript against the
// RESTAURANT'S OWN facet vocabulary — never free text — and returns a filter
// payload compatible with the cellar's URL-state facets (src/lib/cellar-facets
// /url-state.ts). No LLM, no free-form value acceptance: every emitted
// country/region/varietal is a value that was already in the tenant's own
// vocabulary (SPEC-20 EV-VWP-20.2's identity principle, extended to facets).
//
// Precedence lives in the caller (handler.ts): this module only runs after
// resolveWineName has already abstained with reason "below_threshold" or
// "no_corroboration" — a genuinely wrong/adversarial wine-name utterance
// ("contradicted") must stay an abstention, not get reinterpreted as a
// filter here.

import { bestSpanSimilarity, foldAccents } from "./name-resolver";
import type { CellarUrlFilter } from "@/lib/cellar-facets/url-state";

/** The tenant's own DISTINCT facet values for the current cellar — never
 * arbitrary transcript text. */
export interface FacetVocabulary {
  country: readonly string[];
  region: readonly string[];
  varietal: readonly string[];
}

export type VoiceStatusFilter = Exclude<CellarUrlFilter, "all">;

export interface VoiceFilterPayload {
  country?: string;
  region?: string;
  varietal?: string;
  filter?: VoiceStatusFilter;
  search?: string;
}

// Same accept bar as name-resolver's acceptThreshold (0078's production
// threshold, match_lwin) — no laxer bar for facets than for wine names.
const ACCEPT_THRESHOLD = 0.3;

// Mirror of name-resolver's norm(): fold, lower, apostrophe/hyphen to space,
// non-alphanumeric to space, collapse. Kept as a local copy (not exported
// from name-resolver.ts) since this module's normalization needs — word
// splitting for the status/search heuristics below — are its own concern.
function normalize(s: string): string {
  return foldAccents(s)
    .toLowerCase()
    .replace(/['-]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Status keywords: CELLAR_FILTERS is a small, fixed 5-value vocabulary, so a
// static phrase table (not per-tenant data) is enough. Matched by phrase
// containment on the normalized, space-padded transcript.
const STATUS_PHRASES: ReadonlyArray<{ filter: VoiceStatusFilter; phrases: readonly string[] }> = [
  {
    filter: "drink-now",
    phrases: ["drink now", "ready to drink", "drink soon", "past peak", "closing window"],
  },
  { filter: "hold", phrases: ["not ready", "still aging", "hold off", "needs more time"] },
  { filter: "out", phrases: ["out of stock", "eighty sixed", "86d", "sold out", "we re out"] },
  { filter: "low", phrases: ["low stock", "running low", "getting low", "low on"] },
  { filter: "open", phrases: ["open bottle", "open bottles", "already open", "opened bottle"] },
];

// Command/grammar words a spoken filter request wraps around the useful
// content ("pull up any wines from California" -> residue "california").
// Deliberately small and English-only, same NFR direction as name-resolver's
// CARRIER_WORDS: under-stripping only costs a missed search fallback (safe),
// over-stripping risks manufacturing a phrase that was never really there
// (unsafe) — so this list stays tight and the length/tightness gate below,
// not brute-force stripping, is what rejects full sentences.
const FILLER_WORDS = new Set([
  "a", "an", "the", "of", "for", "to", "in", "on", "at", "by", "with", "and", "or",
  "from", "please", "show", "me", "us", "pull", "up", "find", "get", "bring",
  "any", "some", "all", "list", "give", "have", "got", "want", "need",
  "wine", "wines", "bottle", "bottles", "cellar", "tonight", "today",
]);

// A "tight noun phrase" fallback only fires on short utterances that reduce
// to a short substantive residue — a full sentence with a few content words
// (e.g. "what is the weather tomorrow") must not collapse into a plausible-
// looking search term.
const MAX_FALLBACK_TRANSCRIPT_WORDS = 8;
const MAX_RESIDUE_WORDS = 3;
const MIN_RESIDUE_WORD_LENGTH = 3;

/** Picks the tenant's vocabulary value that best explains the transcript, if
 * any clears the accept threshold. Ties (e.g. "Napa" vs "Napa Valley" both
 * matching exactly) prefer the more specific — longer — value. */
function bestVocabMatch(vocabulary: readonly string[], transcript: string): string | undefined {
  let winner: { value: string; score: number; words: number } | undefined;
  for (const raw of vocabulary) {
    const value = raw.trim();
    if (!value) continue;
    const score = bestSpanSimilarity(value, transcript);
    if (score < ACCEPT_THRESHOLD) continue;
    const words = normalize(value).split(" ").filter(Boolean).length;
    if (!winner || score > winner.score || (score === winner.score && words > winner.words)) {
      winner = { value, score, words };
    }
  }
  return winner?.value;
}

function matchStatus(normalizedTranscript: string): VoiceStatusFilter | undefined {
  const padded = ` ${normalizedTranscript} `;
  for (const { filter, phrases } of STATUS_PHRASES) {
    if (phrases.some((phrase) => padded.includes(` ${phrase} `))) return filter;
  }
  return undefined;
}

function extractTightPhrase(normalizedTranscript: string): string | undefined {
  const words = normalizedTranscript.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > MAX_FALLBACK_TRANSCRIPT_WORDS) return undefined;
  const residue = words.filter((word) => !FILLER_WORDS.has(word) && !/^\d+$/.test(word));
  if (residue.length === 0 || residue.length > MAX_RESIDUE_WORDS) return undefined;
  if (residue.some((word) => word.length < MIN_RESIDUE_WORD_LENGTH)) return undefined;
  return residue.join(" ");
}

/**
 * Parses a voice transcript into a cellar filter payload, or null when
 * nothing in the tenant's facet vocabulary (or the fixed status vocabulary)
 * matches and no tight fallback phrase applies. Never guesses: a stretch
 * match is null, not a partial payload.
 */
export function resolveVoiceFilterIntent(
  transcript: string,
  vocabulary: FacetVocabulary,
): VoiceFilterPayload | null {
  const normalized = normalize(transcript);
  if (!normalized) return null;

  const payload: VoiceFilterPayload = {};
  const country = bestVocabMatch(vocabulary.country, transcript);
  if (country) payload.country = country;
  const region = bestVocabMatch(vocabulary.region, transcript);
  if (region) payload.region = region;
  const varietal = bestVocabMatch(vocabulary.varietal, transcript);
  if (varietal) payload.varietal = varietal;
  const status = matchStatus(normalized);
  if (status) payload.filter = status;

  if (Object.keys(payload).length > 0) return payload;

  const phrase = extractTightPhrase(normalized);
  return phrase ? { search: phrase } : null;
}
