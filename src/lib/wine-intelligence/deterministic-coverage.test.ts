// The acceptance bar for the deterministic-miss-corpus slice
// (docs/plans/2026-09-01-tier-2-struct-compile-ops-spec.md §6 decision 4):
// run the whole corpus, prove nothing is a silent precision failure, and
// pin the per-class counts so a later slice cannot regress coverage without
// updating the ratchet on purpose.
import { describe, expect, it } from "vitest";
import corpus from "./fixtures/deterministic-miss-corpus.json";
import vocabularyFixture from "./fixtures/demo-tenant-vocabulary.json";
import baseline from "./fixtures/deterministic-coverage-baseline.json";
import { measureCase, type MissCorpusCase, type Classification } from "./deterministic-coverage";
import type { AssistantVocabulary } from "./assistant-query";

const vocabulary: AssistantVocabulary = vocabularyFixture.vocabulary;
const cases = corpus.cases as MissCorpusCase[];

describe("deterministic-miss-corpus — acceptance bar", () => {
  it("carries the exact case count the corpus was built with", () => {
    // A silent drop would hide coverage loss behind a smaller denominator.
    expect(cases).toHaveLength(180);
  });

  it("never lets an unexcused case classify as wrong", () => {
    // "wrong" is the precision failure the ops spec forbids: a parser
    // asserting a fact the query contradicts. A case may still classify
    // "wrong" here if — and only if — its own fixture entry carries a
    // `knownWrong` reason, which keeps the bar honest and visible instead
    // of quietly editing the case away (see that field's doc comment in
    // deterministic-coverage.ts).
    const unexcused = cases
      .map((c) => ({ case: c, result: measureCase(c, vocabulary) }))
      .filter(({ case: c, result }) => result.classification === "wrong" && !c.knownWrong);

    expect(
      unexcused.map(({ case: c, result }) => `${c.id} (${c.query}): ${result.wrong.join("; ")}`),
    ).toEqual([]);
  });

  it("does not let knownWrong excuse a case that actually classifies fine", () => {
    // The annotation is a promise about a specific, still-present defect.
    // If a later fix makes the case pass, the annotation is stale and
    // should be removed — silently keeping it would hide that the bar
    // tightened.
    const stale = cases.filter((c) => c.knownWrong && measureCase(c, vocabulary).classification !== "wrong");
    expect(stale.map((c) => c.id)).toEqual([]);
  });

  it("pins the per-class counts as a ratchet", () => {
    const counts: Record<Classification | "knownWrong", number> = {
      answered: 0,
      partial: 0,
      tier2: 0,
      tier3: 0,
      missed: 0,
      wrong: 0,
      knownWrong: 0,
    };
    for (const c of cases) {
      const result = measureCase(c, vocabulary);
      if (result.classification === "wrong" && c.knownWrong) {
        counts.knownWrong += 1;
      } else {
        counts[result.classification] += 1;
      }
    }

    // Precision floor: an unexcused "wrong" is always a hard failure, not a
    // ratchet — the test above already enforces it, and this is the same
    // rule stated as a number so the table below reads honestly.
    expect(counts.wrong).toBe(0);

    // answered may not go down: a later slice that recovers cheap fixes
    // must not accidentally regress ones already working.
    expect(counts.answered).toBeGreaterThanOrEqual(baseline.counts.answered);

    // missed + tier2 may not go up: those are the cases furthest from a
    // structured answer (nothing at all, or nothing but paraphrase). A
    // regression there is coverage quietly getting worse.
    expect(counts.missed + counts.tier2).toBeLessThanOrEqual(baseline.counts.missed + baseline.counts.tier2);

    // The baseline is read, not asserted equal — the next slice updates
    // fixtures/deterministic-coverage-baseline.json deliberately (see its
    // own comment) once it moves these numbers on purpose.
  });
});

describe("measureCase — the classifier itself", () => {
  const parse = (c: Partial<MissCorpusCase> & Pick<MissCorpusCase, "expected">) =>
    measureCase({ id: "t", lens: "test", query: "n/a", meaning: "n/a", ...c }, vocabulary);

  it("classifies tier3 for occasion/comparative/open-question regardless of any facet captured", () => {
    // Order matters (deterministic-coverage.ts's header): tier3 is checked
    // BEFORE answered/partial, so a captured facet does not upgrade an
    // occasion/comparative/open-question case — the real ask is
    // unanswerable deterministically either way.
    expect(
      measureCase(
        { id: "t", lens: "test", query: "what would pair with lamb", meaning: "m", expected: { unanswerable: "comparative", pairing: ["Lamb"] } },
        vocabulary,
      ).classification,
    ).toBe("tier3");
  });

  it("classifies answered only when every concrete field matched", () => {
    expect(parse({ query: "a Malbec from Mendoza", expected: { grape: "Malbec", region: "Mendoza" } }).classification).toBe(
      "answered",
    );
  });

  it("classifies partial when some but not all concrete fields matched", () => {
    const r = parse({ query: "a Chianti with mushrooms", expected: { region: "Chianti", pairing: ["Mushrooms"] } });
    expect(r.classification).toBe("partial");
    expect(r.missing).toContain("region");
    expect(r.matched).toContain("pairing");
  });

  it("classifies tier2 only when nothing at all was produced and the case is paraphrase-only", () => {
    const r = parse({ query: "something zippy and food-friendly", expected: { unanswerable: "paraphrase-only" } });
    expect(r.classification).toBe("tier2");
  });

  it("classifies missed when nothing was produced and there is no paraphrase annotation", () => {
    const r = parse({ query: "xyzzy plugh", expected: { grape: "Nonexistentgrapewordzzz" } });
    expect(r.classification).toBe("missed");
  });

  it("classifies wrong when a parser asserts a value that contradicts expected", () => {
    const r = parse({ query: "a red from France", expected: { country: "Italy" } });
    expect(r.classification).toBe("wrong");
    expect(r.wrong[0]).toContain("country");
  });

  it("classifies wrong when a negated fact is asserted positively", () => {
    const r = parse({ query: "a Malbec please", expected: { negated: ["grape: Malbec"] } });
    expect(r.classification).toBe("wrong");
    expect(r.wrong[0]).toContain("negated grape: Malbec");
  });

  it("matches pairing on a non-empty intersection, not exact equality", () => {
    const r = parse({ query: "goes with beef and mushrooms", expected: { pairing: ["Beef"] } });
    expect(r.matched).toContain("pairing");
  });

  it("does not credit a vintage field for an incomplete set — a range is not the same as its endpoints", () => {
    // "2018 to 2020" is read as the two literal years mentioned (2018,
    // 2020), not the implied range (2018, 2019, 2020) — parseVintages has
    // no range logic. Real, evidence-backed gap; this pins the classifier's
    // side of it rather than silently treating a subset as a match.
    const r = parse({ query: "a Burgundy Pinot Noir, 2018 to 2020", expected: { vintages: [2018, 2019, 2020] } });
    expect(r.matched).not.toContain("vintages");
    expect(r.wrong).toEqual([]);
    expect(r.missing).toContain("vintages");
  });

  it("returns the assistant parser's own unrecognized words", () => {
    const r = parse({ query: "a red from Narnia", expected: { type: "Red" } });
    expect(r.unrecognized).toContain("narnia");
  });

  it("is a pure function — the same case measures the same way twice", () => {
    const c: MissCorpusCase = { id: "t", lens: "test", query: "a Malbec from Mendoza", meaning: "m", expected: { grape: "Malbec" } };
    expect(measureCase(c, vocabulary)).toEqual(measureCase(c, vocabulary));
  });
});
