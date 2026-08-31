// WS-IDENT batch linkage decision rule — the executable form of
// docs/plans/2026-08-31-ws-ident-identity-policy.md §2–§3, §5–§6.
//
// The three floors are xwines-profile.ts's measured constants, imported so the
// batch and the read-time enrichment path can never drift apart. This module
// adds the batch lifecycle AROUND the floors:
//
// - the ambiguity guard: a candidate is auto-accepted only when no OTHER
//   candidate's blended score sits within XWINES_AMBIGUITY_GAP of it. Near
//   ties go to review, not to whichever sorted first — the colour-triplet
//   case (Rosé 0.744 / Rouge 0.738 / Blanc 0.733, 0134's own example) is a
//   review row, never an auto-link.
// - the token-equality guard (§4 tightening, measured 2026-08-31): the first
//   negative-pair QA run showed the floors alone auto-accept qualifier
//   siblings wholesale — "Malbec Reserva" → "Gran Reserva Malbec" at blend
//   0.900, "Trocken" → "Halbtrocken" at 0.950 — because a producer score of
//   1.0 contributes 0.6 outright, so ANY name over the 0.64 floor blends past
//   0.85. LWIN and X-Wines are both curated catalogues; between them a token
//   present on one side and absent on the other is a different bottling far
//   more often than a typo. Auto-accept therefore also requires normalized
//   name token-set EQUALITY. A one-sided difference (added/dropped qualifier)
//   is a grain question a human can settle — review. A two-sided difference
//   ("Blanc de Noirs" vs "Blanc de Blancs") is a different wine — abstain,
//   because showing nothing is the correct output for a wine the corpus does
//   not hold.
// - the review margin: a best candidate missing a floor by less than
//   XWINES_REVIEW_MARGIN queues for a human rather than silently dropping.
// - tombstones: a pair a human has split is never auto-accepted again (§5),
//   and any tombstone among a row's candidates sends the whole row to review.
import { normalizeProducerOrCuvee } from "@/domains/identity/normalize";
import {
  XWINES_NAME_FLOOR,
  XWINES_PRODUCER_FLOOR,
  XWINES_SCORE_FLOOR,
} from "./xwines-profile";

/**
 * Auto-accept requires no second candidate within this blended-score distance
 * (identity policy §3). At-gap is acceptable; strictly inside it is a near-tie.
 */
export const XWINES_AMBIGUITY_GAP = 0.03;
/** A floor missed by less than this queues for review instead of abstaining (§3). */
export const XWINES_REVIEW_MARGIN = 0.05;

/**
 * Written onto every run so a link row names the exact rule that made it (§5).
 * Derived from the live constants — it cannot drift from what actually ran.
 * /2: token-equality guard added after the first negative QA run (§4).
 * /3: tail-accounting guard added after eyeballing the first full run — a
 *     dropped display tail that is a cru/designation, not a region, must be
 *     accounted for by the candidate before a bare-name match auto-accepts.
 */
export const LINKAGE_RULE_VERSION =
  `lwin-xwines-linkage/3 token-equality tail-accounting ` +
  `floors=${XWINES_SCORE_FLOOR}/${XWINES_PRODUCER_FLOOR}/${XWINES_NAME_FLOOR} ` +
  `gap=${XWINES_AMBIGUITY_GAP} margin=${XWINES_REVIEW_MARGIN}`;

/** The (cuvée, dropped-tail) pair buildLwinLinkageQuery produced for one row. */
export type LinkageQuery = {
  cuvee: string;
  /** The trailing display segment dropped from the query text, or null. */
  tail: string | null;
};

/** One match_xwines candidate row, in this module's vocabulary. */
export type LinkageCandidate = {
  wineId: number;
  /** The corpus's name for the wine — the token-equality guard reads it. */
  name: string;
  /** The corpus's own geography — what a dropped region tail is checked against. */
  regionName: string | null;
  country: string | null;
  score: number;
  producerScore: number;
  nameScore: number;
};

export type LinkageDecision =
  | { status: "accepted"; candidate: LinkageCandidate; secondScore: number | null }
  | {
      status: "review";
      candidate: LinkageCandidate;
      reason: "ambiguous" | "near-floor" | "tombstoned" | "name-mismatch";
      secondScore: number | null;
    }
  | { status: "abstained"; reason: "no-candidates" | "floor-miss" | "name-mismatch" };

function clearsFloors(candidate: LinkageCandidate): boolean {
  return (
    candidate.score >= XWINES_SCORE_FLOOR &&
    candidate.producerScore >= XWINES_PRODUCER_FLOOR &&
    candidate.nameScore >= XWINES_NAME_FLOOR
  );
}

/** How far the candidate's worst axis sits below its floor; <= 0 means it clears. */
function worstFloorDeficit(candidate: LinkageCandidate): number {
  return Math.max(
    XWINES_SCORE_FLOOR - candidate.score,
    XWINES_PRODUCER_FLOOR - candidate.producerScore,
    XWINES_NAME_FLOOR - candidate.nameScore,
  );
}

function tokenSet(raw: string): Set<string> {
  return new Set(normalizeProducerOrCuvee(raw).split(" ").filter(Boolean));
}

type TokenRelation = "equal" | "subset" | "disjoint-ish";

function nameTokenRelation(cuvee: string, candidateName: string): TokenRelation {
  const query = tokenSet(cuvee);
  const cand = tokenSet(candidateName);
  const queryInCand = [...query].every((t) => cand.has(t));
  const candInQuery = [...cand].every((t) => query.has(t));
  if (queryInCand && candInQuery) return "equal";
  if (queryInCand || candInQuery) return "subset";
  return "disjoint-ish";
}

/**
 * Whether a dropped display tail is explained by the candidate's own
 * geography: every tail token appears in the candidate's region_name +
 * country after identity normalization. "Okanagan Valley" against region
 * "Okanagan Valley" is; "Fourchaume" against region "Chablis" is not — that
 * tail is a designation, and ignoring it would merge a cru into the village
 * bottling.
 */
export function tailAccounted(
  tail: string,
  regionName: string | null,
  country: string | null,
): boolean {
  const tailTokens = tokenSet(tail);
  if (tailTokens.size === 0) return true;
  const geo = tokenSet(`${regionName ?? ""} ${country ?? ""}`);
  return [...tailTokens].every((t) => geo.has(t));
}

/**
 * Decide one LWIN row's linkage outcome from its candidate set.
 *
 * Input order is not trusted: candidates are re-sorted by blended score with
 * 0127's `wine_id asc` tie-break, so the same set decides identically however
 * it arrives — a run resumed mid-way must not resolve differently.
 */
export function decideLinkage(
  query: LinkageQuery,
  candidates: readonly LinkageCandidate[],
  tombstonedWineIds?: ReadonlySet<number>,
): LinkageDecision {
  if (candidates.length === 0) return { status: "abstained", reason: "no-candidates" };

  const ordered = [...candidates].sort(
    (a, b) => b.score - a.score || a.wineId - b.wineId,
  );
  const hasTombstone =
    tombstonedWineIds !== undefined &&
    ordered.some((c) => tombstonedWineIds.has(c.wineId));

  // 0134 walk-past semantics: the first candidate clearing EVERY floor wins,
  // even when a floor-failing candidate outscored it on the blend.
  const pick = ordered.find(clearsFloors);
  if (pick) {
    const others = ordered.filter((c) => c !== pick);
    const secondScore = others.length > 0 ? others[0].score : null;
    if (hasTombstone) {
      return { status: "review", candidate: pick, reason: "tombstoned", secondScore };
    }
    // Symmetric distance, deliberately: a rejected candidate slightly ABOVE
    // the pick (the walked-past colour sibling) is as much a near-tie as one
    // slightly below. A candidate far above is not — its blend cleared the
    // pick's only because a floor the pick satisfies decisively rejected it.
    const nearTie = others.some(
      (c) => Math.abs(pick.score - c.score) < XWINES_AMBIGUITY_GAP,
    );
    if (nearTie) {
      return { status: "review", candidate: pick, reason: "ambiguous", secondScore };
    }
    // Full-form first: a candidate naming the designation itself is the
    // strongest identity claim available.
    if (
      query.tail !== null &&
      nameTokenRelation(`${query.cuvee} ${query.tail}`, pick.name) === "equal"
    ) {
      return { status: "accepted", candidate: pick, secondScore };
    }
    const relation = nameTokenRelation(query.cuvee, pick.name);
    if (relation === "equal") {
      if (query.tail === null || tailAccounted(query.tail, pick.regionName, pick.country)) {
        return { status: "accepted", candidate: pick, secondScore };
      }
      return { status: "review", candidate: pick, reason: "name-mismatch", secondScore };
    }
    if (relation === "subset") {
      return { status: "review", candidate: pick, reason: "name-mismatch", secondScore };
    }
    return { status: "abstained", reason: "name-mismatch" };
  }

  // Nothing clears the floors: the candidate CLOSEST to clearing them is the
  // one a reviewer should see, not the highest blend.
  const byDeficit = [...ordered].sort(
    (a, b) =>
      worstFloorDeficit(a) - worstFloorDeficit(b) ||
      b.score - a.score ||
      a.wineId - b.wineId,
  );
  const best = byDeficit[0];
  if (worstFloorDeficit(best) < XWINES_REVIEW_MARGIN) {
    const others = ordered.filter((c) => c !== best);
    const secondScore = others.length > 0 ? others[0].score : null;
    return {
      status: "review",
      candidate: best,
      reason: hasTombstone ? "tombstoned" : "near-floor",
      secondScore,
    };
  }
  return { status: "abstained", reason: "floor-miss" };
}

/**
 * Build the (producer, cuvée) query for one lwin_catalog row.
 *
 * `display_name` is "<producer with honorific>, <cuvée…>, <tail>" — the
 * producer column routinely lacks the honorific the corpus's winery_name
 * carries ("Chante Alouette" vs "Château Chante Alouette"), so when the first
 * segment token-contains the producer it is preferred as the producer query.
 * The trailing segment is USUALLY the region and is split off the query text
 * (keeping it would sink the name similarity of every honest regional match)
 * — but it is returned as `tail`, not discarded: sometimes it is a cru or
 * designation that IS label identity ("Chablis, Fourchaume"), and only the
 * candidate side can tell which (see tailAccounted). A lone remaining
 * segment is the cuvée, never a tail ("Cote de Brouilly").
 *
 * Returns null when there is nothing to match: a blank producer (provisional
 * rows are excluded from linkage input, §6) or no cuvée text at all. Null is
 * the caller's abstention, not an error.
 */
export function buildLwinLinkageQuery(
  displayName: string,
  producer: string | null,
): { producer: string; cuvee: string; tail: string | null } | null {
  const producerNorm = normalizeProducerOrCuvee(producer ?? "");
  if (producerNorm === "") return null;

  const segments = displayName
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (segments.length === 0) return null;

  const producerTokens = producerNorm.split(" ");
  const firstSegmentTokens = new Set(normalizeProducerOrCuvee(segments[0]).split(" "));
  const firstIsProducer = producerTokens.every((t) => firstSegmentTokens.has(t));

  let cuveeSegments = firstIsProducer ? segments.slice(1) : segments;
  let tail: string | null = null;
  if (cuveeSegments.length >= 2) {
    tail = cuveeSegments[cuveeSegments.length - 1];
    cuveeSegments = cuveeSegments.slice(0, -1);
  }
  const cuvee = cuveeSegments.join(" ").trim();
  if (cuvee === "") return null;

  return {
    producer: firstIsProducer ? segments[0] : (producer as string).trim(),
    cuvee,
    tail,
  };
}
