// Measures what the two DETERMINISTIC parsers — parseSearchQuery (GET
// /api/search) and parseAssistantQuery (GET /api/assistant) — recover from a
// corpus of realistic queries, against a fixed "expected" struct per query.
// This is read-only measurement: it calls no model and writes nothing.
//
// docs/plans/2026-09-01-tier-2-struct-compile-ops-spec.md §6 decision 4 asks
// for exactly this before deciding whether tier 2 ships: "do steps 1-2,
// measure what still misses, and decide tier 2 against that evidence". This
// module is the measuring instrument; scripts/measure-deterministic-misses.ts
// is what runs it over the corpus and writes the evidence out.
//
// WHY BOTH PARSERS PER CASE: the two entry points answer the same kind of
// question with different reach. parseSearchQuery matches against the GLOBAL
// wine-gazetteer (every country/region it lists, regardless of what any one
// tenant holds); parseAssistantQuery matches country/region/grape only
// against THIS TENANT's own DISTINCT values. A fact this tenant cannot name
// (their cellar holds no Chile) can still be genuinely deterministic — the
// search gazetteer knows the word "Chile" whether or not this cellar has one
// — so a field counts as recovered if EITHER parser produces it. That is the
// "combined deterministic lane" the ops spec is measuring, not either parser
// graded alone (each parser's own correctness is query-parse.test.ts's and
// assistant-query.test.ts's job).

import { parseSearchQuery, type ParsedSearchQuery } from "@/lib/unified-search/query-parse";
import { COLOUR_INDEX, BODY_INDEX } from "@/lib/unified-search/wine-gazetteer";
import { parseAssistantQuery, type AssistantQuery, type AssistantVocabulary } from "./assistant-query";
import { TYPE_PHRASES, BODY_PHRASES } from "./assistant-lexicon";

/** The facts a corpus case says a good deterministic parse should produce.
 *  Field names mirror AssistantQuery, which is the wider of the two
 *  contracts (query-parse has no grape/pairing/price/blend). */
export interface ExpectedFields {
  type?: string;
  body?: string;
  blend?: boolean;
  pairing?: string[];
  country?: string;
  region?: string;
  grape?: string;
  vintages?: number[];
  priceMin?: number;
  priceMax?: number;
  /** Facts the query rules out, "field: Value" — e.g. "grape: Malbec". A
   *  parser is WRONG if it asserts one of these positively. */
  negated?: string[];
  /** Why this case cannot be a clean structured answer, if it can't be one:
   *  a comparison against another wine, an occasion with no stated facet, an
   *  open question, or prose outside the fixed phrase lists ("paraphrase"). */
  unanswerable?: "occasion" | "comparative" | "open-question" | "paraphrase-only";
}

export interface MissCorpusCase {
  id: string;
  lens: string;
  query: string;
  meaning: string;
  expected: ExpectedFields;
  /** Set only when a case classifies "wrong" and the underlying parser bug
   *  cannot be fixed safely in this slice. Keeps the wrong-count ratchet
   *  honest about a known, deliberately-deferred defect rather than hiding
   *  it by editing the case away. The reason, not a boolean, so the report
   *  can say why. */
  knownWrong?: string;
}

export type Classification = "wrong" | "tier3" | "answered" | "partial" | "tier2" | "missed";

export interface MeasureResult {
  id: string;
  searchIntent: ParsedSearchQuery;
  assistantQuery: AssistantQuery;
  /** Expected fields no parser produced. */
  missing: string[];
  /** Expected fields a parser produced with a CONTRADICTING value, or a
   *  negated fact a parser asserted positively — human-readable, one per
   *  contradiction. */
  wrong: string[];
  /** Expected fields at least one parser produced with the expected value. */
  matched: string[];
  classification: Classification;
  /** Content words parseAssistantQuery could not place anywhere. */
  unrecognized: string[];
}

const fold = (s: string): string => s.trim().toLowerCase();

/** Every expected key that is a concrete fact to look for, i.e. not the two
 *  bookkeeping keys `negated` and `unanswerable`. */
const CONCRETE_KEYS = [
  "type",
  "body",
  "blend",
  "pairing",
  "country",
  "region",
  "grape",
  "vintages",
  "priceMin",
  "priceMax",
] as const satisfies ReadonlyArray<keyof ExpectedFields>;

type FieldOutcome = "matched" | "wrong" | "missing";

/** A scalar fact (string/number/boolean): matched if any candidate equals
 *  the expected value; wrong if none match but at least one candidate was
 *  produced (a parser asserted something else); missing if none were
 *  produced at all. */
function evaluateScalar(
  candidates: ReadonlyArray<string | number | boolean | undefined>,
  expected: string | number | boolean,
): FieldOutcome {
  const present = candidates.filter((v): v is string | number | boolean => v != null && v !== "");
  if (present.length === 0) return "missing";
  const isMatch = (v: string | number | boolean) =>
    typeof v === "string" && typeof expected === "string" ? fold(v) === fold(expected) : v === expected;
  return present.some(isMatch) ? "matched" : "wrong";
}

/** Pairing: matched on non-empty intersection — the ops task specifies this
 *  rule explicitly ("compared as a set intersection being non-empty"), so a
 *  query that names two foods and gets only one back still counts as
 *  answered. Wrong only when the parser named a pairing set that shares
 *  NOTHING with the expected one — a genuinely different answer, not an
 *  incomplete one. */
function evaluatePairing(produced: readonly string[], expected: readonly string[]): FieldOutcome {
  if (produced.length === 0) return "missing";
  const expectedSet = new Set(expected.map(fold));
  const overlaps = produced.some((p) => expectedSet.has(fold(p)));
  return overlaps ? "matched" : "wrong";
}

/** Vintages: matched only on EXACT set equality, deliberately NOT the same
 *  non-empty-intersection rule as pairing. "2018 to 2020" is read today as
 *  the two literal years typed (2018, 2020) — parseVintages has no notion
 *  of a range, so the implied 2019 is silently absent. Treating {2018,2020}
 *  as a match for {2018,2019,2020} would hide that real gap behind a green
 *  "answered" case instead of surfacing it as the range-support gap it is.
 *  A partial, non-empty overlap is MISSING (an honest incompleteness); a
 *  fully disjoint, non-empty result is WRONG (a different year altogether,
 *  which is a genuine contradiction). */
function evaluateVintages(produced: readonly number[], expected: readonly number[]): FieldOutcome {
  if (produced.length === 0) return "missing";
  const producedSet = new Set(produced);
  const expectedSet = new Set(expected);
  const exact = producedSet.size === expectedSet.size && [...producedSet].every((v) => expectedSet.has(v));
  if (exact) return "matched";
  const overlaps = produced.some((v) => expectedSet.has(v));
  return overlaps ? "missing" : "wrong";
}

// query-parse's "colours" and the assistant's "type" are two DIFFERENT
// fixed vocabularies for the same idea — colours has no "Dessert/Port",
// type has no "Fortified" — and likewise for body's "Very light-bodied"
// (assistant only). A parser cannot be WRONG for failing to say a word that
// is not even in its output vocabulary; that is a taxonomy gap, not a
// contradiction. So a candidate is only compared against an expected value
// when that value is a member of the vocabulary it could have come from —
// computed here from the same phrase tables the parsers themselves match
// against, so this can never drift from what they actually can emit.
const ASSISTANT_TYPE_VALUES: ReadonlySet<string> = new Set(TYPE_PHRASES.map((p) => p.value));
const SEARCH_TYPE_VALUES: ReadonlySet<string> = new Set([...COLOUR_INDEX.values()].map((e) => e.canonical));
const ASSISTANT_BODY_VALUES: ReadonlySet<string> = new Set(BODY_PHRASES.map((p) => p.value));
const SEARCH_BODY_VALUES: ReadonlySet<string> = new Set([...BODY_INDEX.values()].map((e) => e.canonical));

/** All candidate values a field could have been recovered as, drawn from
 *  whichever parser(s) carry that concept — and, for "type"/"body", only
 *  from a parser whose own fixed vocabulary could produce `expected` at
 *  all (see the block comment above). */
function candidatesFor(
  key: (typeof CONCRETE_KEYS)[number],
  expected: string | number | boolean,
  search: ParsedSearchQuery,
  assistant: AssistantQuery,
): ReadonlyArray<string | number | boolean | undefined> {
  switch (key) {
    case "country":
      return [assistant.country, ...search.filters.countries];
    case "region":
      return [assistant.region, ...search.filters.regions];
    case "type":
      return [
        ...(ASSISTANT_TYPE_VALUES.has(expected as string) ? [assistant.type] : []),
        ...(SEARCH_TYPE_VALUES.has(expected as string) ? search.filters.colours : []),
      ];
    case "body":
      return [
        ...(ASSISTANT_BODY_VALUES.has(expected as string) ? [assistant.body] : []),
        ...(SEARCH_BODY_VALUES.has(expected as string) ? search.preferences.body : []),
      ];
    case "grape":
      return [assistant.grape];
    case "blend":
      return [assistant.blend];
    case "priceMin":
      return [assistant.priceMin];
    case "priceMax":
      return [assistant.priceMax];
    default:
      return [];
  }
}

/** Parses one "field: Value" negation entry from a corpus fixture. */
function parseNegatedEntry(entry: string): { field: string; value: string } {
  const [field, ...rest] = entry.split(":");
  return { field: (field ?? "").trim(), value: rest.join(":").trim() };
}

/** Whether a negated fact was asserted positively somewhere in the combined
 *  output — the precision failure the ops spec forbids (§2.2). */
function negationViolated(
  field: string,
  value: string,
  search: ParsedSearchQuery,
  assistant: AssistantQuery,
): boolean {
  const key = field as (typeof CONCRETE_KEYS)[number];
  if (key === "pairing") {
    return [...(assistant.pairing ?? [])].some((v) => fold(v) === fold(value));
  }
  if (key === "vintages") {
    const year = Number(value);
    return (assistant.vintages ?? []).includes(year) || search.filters.vintages.includes(year);
  }
  const candidates = candidatesFor(key, value, search, assistant);
  return candidates.some((v) => typeof v === "string" && fold(v) === fold(value));
}

export function measureCase(testCase: MissCorpusCase, vocabulary: AssistantVocabulary): MeasureResult {
  const searchIntent = parseSearchQuery(testCase.query);
  const assistantQuery = parseAssistantQuery(testCase.query, vocabulary);
  const expected = testCase.expected;

  const matched: string[] = [];
  const missing: string[] = [];
  const wrong: string[] = [];

  for (const key of CONCRETE_KEYS) {
    const expectedValue = expected[key];
    if (expectedValue === undefined) continue;

    let outcome: FieldOutcome;
    if (key === "pairing") {
      outcome = evaluatePairing(assistantQuery.pairing ?? [], expected.pairing ?? []);
    } else if (key === "vintages") {
      const produced = [...(assistantQuery.vintages ?? []), ...searchIntent.filters.vintages];
      outcome = evaluateVintages(produced, expected.vintages ?? []);
    } else {
      outcome = evaluateScalar(
        candidatesFor(key, expectedValue as string | number | boolean, searchIntent, assistantQuery),
        expectedValue as string | number | boolean,
      );
    }

    if (outcome === "matched") matched.push(key);
    else if (outcome === "wrong") wrong.push(`${key}: expected ${JSON.stringify(expectedValue)}`);
    else missing.push(key);
  }

  for (const entry of expected.negated ?? []) {
    const { field, value } = parseNegatedEntry(entry);
    if (negationViolated(field, value, searchIntent, assistantQuery)) {
      wrong.push(`negated ${entry} was asserted positively`);
    }
  }

  const concreteCount = CONCRETE_KEYS.filter((k) => expected[k] !== undefined).length;
  // A case with no concrete fields but a `negated` list DOES have something
  // to check — that the ruled-out fact stayed unset — and the loop above
  // already confirmed it did (else this would have classified "wrong"
  // already). Without this, a pure-negation case ("no Chardonnay please",
  // nothing else asked) would vacuously fail the "answered" check below
  // (0 concrete fields to match) and read as "missed" despite the parser
  // doing exactly what was asked.
  const hasCheckableContent = concreteCount > 0 || (expected.negated?.length ?? 0) > 0;

  let classification: Classification;
  if (wrong.length > 0) {
    classification = "wrong";
  } else if (
    expected.unanswerable === "occasion" ||
    expected.unanswerable === "comparative" ||
    expected.unanswerable === "open-question"
  ) {
    classification = "tier3";
  } else if (hasCheckableContent && matched.length === concreteCount) {
    classification = "answered";
  } else if (matched.length > 0) {
    classification = "partial";
  } else if (expected.unanswerable === "paraphrase-only") {
    classification = "tier2";
  } else {
    classification = "missed";
  }

  return {
    id: testCase.id,
    searchIntent,
    assistantQuery,
    missing,
    wrong,
    matched,
    classification,
    unrecognized: assistantQuery.unrecognized,
  };
}
