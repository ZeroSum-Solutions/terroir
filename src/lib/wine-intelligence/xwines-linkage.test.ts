// WS-IDENT linkage decision rule — the executable form of
// docs/plans/2026-08-31-ws-ident-identity-policy.md §2–§3, §5–§6.
//
// The floors themselves are xwines-profile.ts's measured constants and are
// deliberately imported, not restated. What THIS module adds — and what these
// tests pin — is the batch-only lifecycle around the floors:
//
// - the ambiguity guard, review margin and tombstone rules (§3, §5);
// - the token-equality guard, forced by the first negative-pair QA run (§4:
//   floors alone auto-accepted qualifier siblings wholesale — "Malbec
//   Reserva" → "Gran Reserva Malbec" at blend 0.900 — because producer 1.0
//   contributes 0.6 outright);
// - the tail-accounting guard, forced by eyeballing the first full run's
//   accepts: display_name's trailing segment is usually a REGION (droppable:
//   "Okanagan Valley") but sometimes a cru/designation that IS label identity
//   ("Chablis, Fourchaume"; "Chianti Classico, Bellavista Gran Selezione").
//   The two are indistinguishable from LWIN alone, so the dropped tail must
//   be accounted for on the CANDIDATE side — in its name, or in its own
//   region/country metadata — before a bare-name match may auto-accept.
import { describe, expect, it } from "vitest";
import {
  XWINES_NAME_FLOOR,
  XWINES_PRODUCER_FLOOR,
  XWINES_SCORE_FLOOR,
} from "./xwines-profile";
import {
  LINKAGE_RULE_VERSION,
  XWINES_AMBIGUITY_GAP,
  XWINES_REVIEW_MARGIN,
  buildLwinLinkageQuery,
  decideLinkage,
  tailAccounted,
  type LinkageCandidate,
} from "./xwines-linkage";

const QUERY = { cuvee: "Koonunga Hill", tail: null };

/** A candidate comfortably clearing every floor, token-equal to QUERY.cuvee. */
function passing(wineId: number, score = XWINES_SCORE_FLOOR + 0.2, name = "Koonunga Hill"): LinkageCandidate {
  return {
    wineId,
    name,
    regionName: null,
    country: null,
    score,
    producerScore: XWINES_PRODUCER_FLOOR + 0.1,
    nameScore: XWINES_NAME_FLOOR + 0.1,
  };
}

describe("decideLinkage", () => {
  it("abstains on an empty candidate list", () => {
    expect(decideLinkage(QUERY, [])).toEqual({ status: "abstained", reason: "no-candidates" });
  });

  it("accepts a sole floor-clearing candidate whose name is the same tokens in another costume", () => {
    const only = passing(7, 0.9, "Hill Koonunga");
    const decision = decideLinkage(QUERY, [only]);
    expect(decision).toEqual({ status: "accepted", candidate: only, secondScore: null });
  });

  it("accepts the top candidate when the runner-up sits exactly the ambiguity gap behind", () => {
    const best = passing(1, 0.9);
    const runnerUp = passing(2, 0.9 - XWINES_AMBIGUITY_GAP);
    const decision = decideLinkage(QUERY, [best, runnerUp]);
    expect(decision).toEqual({
      status: "accepted",
      candidate: best,
      secondScore: runnerUp.score,
    });
  });

  it("sends a floor-clearing top candidate to review when the runner-up is within the gap", () => {
    const best = passing(1, 0.9);
    const nearTie = passing(2, 0.9 - XWINES_AMBIGUITY_GAP + 0.001);
    const decision = decideLinkage(QUERY, [best, nearTie]);
    expect(decision).toEqual({
      status: "review",
      candidate: best,
      reason: "ambiguous",
      secondScore: nearTie.score,
    });
  });

  it("sends a walked-past acceptance to review — a floor-failing leader outscoring it is a near-tie", () => {
    const failingLeader: LinkageCandidate = {
      ...passing(10, 0.744, "Koonunga Hill Rose"),
      nameScore: XWINES_NAME_FLOOR - 0.2,
      producerScore: 1,
    };
    const clearingRunnerUp = passing(11, 0.738);
    const decision = decideLinkage(QUERY, [failingLeader, clearingRunnerUp]);
    expect(decision).toEqual({
      status: "review",
      candidate: clearingRunnerUp,
      reason: "ambiguous",
      secondScore: failingLeader.score,
    });
  });

  it("accepts a walked-past runner-up when the floor-failing leader is not near-tied", () => {
    const failingLeader: LinkageCandidate = {
      ...passing(10, 0.95),
      producerScore: XWINES_PRODUCER_FLOOR - 0.3,
      nameScore: 1,
    };
    const clearingRunnerUp = passing(11, 0.7);
    const decision = decideLinkage(QUERY, [failingLeader, clearingRunnerUp]);
    expect(decision).toEqual({
      status: "accepted",
      candidate: clearingRunnerUp,
      secondScore: failingLeader.score,
    });
  });

  it("reviews a floor-clearing candidate whose name adds tokens — the Gran Reserva class", () => {
    const superset: LinkageCandidate = {
      ...passing(3, 0.9, "Gran Koonunga Hill"),
      producerScore: 1,
      nameScore: 0.75,
    };
    const decision = decideLinkage(QUERY, [superset]);
    expect(decision).toEqual({
      status: "review",
      candidate: superset,
      reason: "name-mismatch",
      secondScore: null,
    });
  });

  it("reviews a floor-clearing candidate whose name drops tokens — the Riserva/normale class", () => {
    const subset: LinkageCandidate = {
      ...passing(3, 0.88, "Koonunga"),
      producerScore: 1,
      nameScore: 0.7,
    };
    const decision = decideLinkage(QUERY, [subset]);
    expect(decision).toEqual({
      status: "review",
      candidate: subset,
      reason: "name-mismatch",
      secondScore: null,
    });
  });

  it("abstains on a two-sided token difference — different wine, showing nothing is correct", () => {
    const swapped: LinkageCandidate = {
      ...passing(3, 0.9, "Koonunga Ridge"),
      producerScore: 1,
      nameScore: 0.8,
    };
    expect(decideLinkage(QUERY, [swapped])).toEqual({
      status: "abstained",
      reason: "name-mismatch",
    });
  });

  it("accepts when the candidate's own name carries the dropped tail — the corpus named the designation", () => {
    const query = { cuvee: "Estate Perigee", tail: "Seven Hills Vineyard" };
    const full = passing(4, 0.9, "Estate Perigee (Seven Hills Vineyard)");
    const decision = decideLinkage(query, [full]);
    expect(decision).toEqual({ status: "accepted", candidate: full, secondScore: null });
  });

  it("accepts a bare-name candidate whose own geography accounts for the dropped tail", () => {
    const query = { cuvee: "Pinot Gris", tail: "Okanagan Valley" };
    const regional: LinkageCandidate = {
      ...passing(5, 0.9, "Pinot Gris"),
      regionName: "Okanagan Valley",
      country: "Canada",
    };
    const decision = decideLinkage(query, [regional]);
    expect(decision).toEqual({ status: "accepted", candidate: regional, secondScore: null });
  });

  it("reviews a bare-name candidate when nothing accounts for the dropped tail — the Fourchaume class", () => {
    // "Domaine Chatelain, Chablis, Fourchaume": the tail is a premier cru,
    // part of label identity. Linking it to the producer's plain "Chablis"
    // is the village-vs-designate false merge §4 names; a human decides.
    const query = { cuvee: "Chablis", tail: "Fourchaume" };
    const village: LinkageCandidate = {
      ...passing(6, 0.94, "Chablis"),
      regionName: "Chablis",
      country: "France",
    };
    const decision = decideLinkage(query, [village]);
    expect(decision).toEqual({
      status: "review",
      candidate: village,
      reason: "name-mismatch",
      secondScore: null,
    });
  });

  it("sends the best candidate to review when it misses one floor by less than the margin", () => {
    const nearMiss: LinkageCandidate = {
      ...passing(3),
      score: XWINES_SCORE_FLOOR + 0.1,
      producerScore: XWINES_PRODUCER_FLOOR + 0.1,
      nameScore: XWINES_NAME_FLOOR - XWINES_REVIEW_MARGIN + 0.001,
    };
    const decision = decideLinkage(QUERY, [nearMiss]);
    expect(decision).toEqual({
      status: "review",
      candidate: nearMiss,
      reason: "near-floor",
      secondScore: null,
    });
  });

  it("abstains when every candidate misses a floor by the full margin or more", () => {
    const farMiss: LinkageCandidate = {
      ...passing(3),
      score: XWINES_SCORE_FLOOR + 0.1,
      producerScore: XWINES_PRODUCER_FLOOR + 0.1,
      nameScore: XWINES_NAME_FLOOR - XWINES_REVIEW_MARGIN,
    };
    expect(decideLinkage(QUERY, [farMiss])).toEqual({ status: "abstained", reason: "floor-miss" });
  });

  it("never auto-accepts a tombstoned pair", () => {
    const only = passing(7);
    const decision = decideLinkage(QUERY, [only], new Set([7]));
    expect(decision).toEqual({
      status: "review",
      candidate: only,
      reason: "tombstoned",
      secondScore: null,
    });
  });

  it("sends the row to review when any other candidate for it is tombstoned", () => {
    const wouldAccept = passing(1, 0.9);
    const tombstonedSibling = passing(2, 0.8);
    const decision = decideLinkage(QUERY, [wouldAccept, tombstonedSibling], new Set([2]));
    expect(decision).toEqual({
      status: "review",
      candidate: wouldAccept,
      reason: "tombstoned",
      secondScore: tombstonedSibling.score,
    });
  });

  it("orders candidates itself — unsorted input decides identically, score ties break on lower wineId", () => {
    const a = passing(20, 0.9);
    const b = passing(5, 0.9);
    const c = passing(30, 0.7);
    const sorted = decideLinkage(QUERY, [b, a, c]);
    const shuffled = decideLinkage(QUERY, [c, a, b]);
    expect(shuffled).toEqual(sorted);
    expect(sorted).toEqual({ status: "review", candidate: b, reason: "ambiguous", secondScore: a.score });
  });
});

describe("tailAccounted", () => {
  it("is satisfied by the candidate's region, tolerant of normalization", () => {
    expect(tailAccounted("Okanagan Valley", "Okanagan Valley", "Canada")).toBe(true);
    expect(tailAccounted("Cotes-du-Rhone", "Côtes du Rhône", "France")).toBe(true);
  });

  it("is satisfied by region and country together", () => {
    expect(tailAccounted("South Australia", "South Eastern Australia", "Australia")).toBe(true);
  });

  it("refuses a tail the candidate's geography does not carry", () => {
    expect(tailAccounted("Fourchaume", "Chablis", "France")).toBe(false);
    expect(tailAccounted("Bellavista Gran Selezione", "Chianti Classico", "Italy")).toBe(false);
  });
});

describe("buildLwinLinkageQuery", () => {
  it("splits producer segment from cuvée and carries the dropped trailing segment as the tail", () => {
    expect(
      buildLwinLinkageQuery("W.T. Vintners, Boushey Syrah, Yakima Valley", "W.T. Vintners"),
    ).toEqual({ producer: "W.T. Vintners", cuvee: "Boushey Syrah", tail: "Yakima Valley" });
  });

  it("queries with the display segment's honorific form of the producer", () => {
    expect(
      buildLwinLinkageQuery("Chateau Chante Alouette, Saint-Emilion Grand Cru", "Chante Alouette"),
    ).toEqual({ producer: "Chateau Chante Alouette", cuvee: "Saint-Emilion Grand Cru", tail: null });
  });

  it("keeps a lone remaining segment as the cuvée rather than treating it as region", () => {
    expect(
      buildLwinLinkageQuery("Domaine Baron de l'Ecluse, Cote de Brouilly", "Baron de l'Ecluse"),
    ).toEqual({ producer: "Domaine Baron de l'Ecluse", cuvee: "Cote de Brouilly", tail: null });
  });

  it("joins interior segments after the tail split", () => {
    expect(
      buildLwinLinkageQuery("Domaine Gachot Monot, Cremant de Bourgogne, Brut, Burgundy", "Gachot Monot"),
    ).toEqual({ producer: "Domaine Gachot Monot", cuvee: "Cremant de Bourgogne Brut", tail: "Burgundy" });
  });

  it("falls back to the producer column when the first segment is not the producer", () => {
    expect(buildLwinLinkageQuery("Special Cuvee, Napa Valley", "Weird Estate")).toEqual({
      producer: "Weird Estate",
      cuvee: "Special Cuvee",
      tail: "Napa Valley",
    });
  });

  it("returns null when no cuvée remains", () => {
    expect(buildLwinLinkageQuery("Chateau Margaux", "Margaux")).toBeNull();
  });

  it("returns null for a blank producer — provisional rows are excluded from linkage", () => {
    expect(buildLwinLinkageQuery("Somewine, Somewhere", "")).toBeNull();
    expect(buildLwinLinkageQuery("Somewine, Somewhere", null)).toBeNull();
  });
});

describe("LINKAGE_RULE_VERSION", () => {
  it("embeds the live floors and margins so a link row names the rule that made it", () => {
    expect(LINKAGE_RULE_VERSION).toContain(
      `${XWINES_SCORE_FLOOR}/${XWINES_PRODUCER_FLOOR}/${XWINES_NAME_FLOOR}`,
    );
    expect(LINKAGE_RULE_VERSION).toContain(String(XWINES_AMBIGUITY_GAP));
    expect(LINKAGE_RULE_VERSION).toContain(String(XWINES_REVIEW_MARGIN));
  });

  it("names the token-equality and tail-accounting tightenings so runs are distinguishable", () => {
    expect(LINKAGE_RULE_VERSION).toContain("token-equality");
    expect(LINKAGE_RULE_VERSION).toContain("tail-accounting");
  });
});
