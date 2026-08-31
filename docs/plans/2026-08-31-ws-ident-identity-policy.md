# WS-IDENT — Executable Identity Policy for the Canonical Catalogue Linkage

**Date:** 2026-08-31 · **Status:** RATIFIED by product owner (Devin), 2026-08-31
**Phase:** P0 of `2026-08-31-unified-search-companion-and-canonical-facts.md` (v2.1)
**Builds on (verified in repo):** `canonical_wines` (+ `identity_status` in
`lwin_verified | operator_confirmed | unverified`, lwin7-only-when-verified invariant),
`match_xwines` top-N RPC (0134) with lower-expression trgm indexes (0133), client
acceptance floors in `src/lib/wine-intelligence/xwines-profile.ts`, `lwin_catalog`
(211k), `xwines_catalog` (100,646).

**Audit note:** the 2026-08-29 pre-merge findings (lower() vs raw indexes; limit-1
starving the client floors) are RESOLVED by 0133/0134 — verified in-repo 2026-08-31.
The remaining named risk, same-producer/wrong-cuvée false matches, is addressed by the
negative-pair QA set below.

---

## 1. What "one wine" is

A **canonical wine** is (producer, cuvée) at the *label identity* level:
- **Producer aliases** (accents, "Dom./Domaine", "Ch./Château", négociant renames)
  resolve to one producer identity via the normalization already in
  `producer_norm`/`cuvee_norm` + fold-accents; alias pairs discovered during linkage
  are recorded, not special-cased inline.
- **Vintage and format are NEVER wine-grain.** They live at
  `(canonical_wine_id, vintage)` (vintage facts) and `wine_variants` (bottling).
- **Label changes / renamed cuvées** are the same wine when the producer treats them
  as continuous (a lineage link), distinct wines otherwise. Default on uncertainty:
  distinct — a false split is recoverable; a false merge poisons facts and recs.
- **Colour splits within a cuvée name** (Rouge/Blanc/Rosé of "Côtes-du-Rhône") are
  distinct canonical wines. The E. Guigal case in 0134's commentary is the canonical
  example: colour is part of label identity.

## 2. The linkage job (LWIN ↔ X-Wines → canonical)

Batch process, idempotent, resumable, run offline — never at request time:
1. Seed pass: exact joins on normalized (producer, cuvée) after accent-fold.
2. Trigram pass: `match_xwines`-style scoring (0.6 producer / 0.4 name weighting,
   deterministic tie-break) for the remainder, top-5 candidates each.
3. Acceptance: the client floors (blended, producer, name — xwines-profile.ts) are
   the SINGLE acceptance rule, applied in the batch exactly as at read time. One rule,
   two call sites, one implementation.

## 3. Match bar, abstention, and lifecycle

- **Auto-accept:** passes all floors AND no second candidate within 0.03 blended
  score (ambiguity guard — near-ties go to review, not to whichever sorted first).
- **Review queue:** passes floors but ambiguous, or within 0.05 below a floor.
- **Abstain:** everything else. **Abstention is a valid, permanent, visible outcome**
  — an unlinked row searches fine as identity-only; it is never force-linked to hit a
  coverage number.
- Lifecycle stays the existing enum: auto-accepted links hold `unverified` until QA
  sampling covers their stratum; operator review promotes to `operator_confirmed`;
  `lwin_verified` keeps its existing meaning (LWIN identity proven), untouched by
  X-Wines linkage.
- **Search may claim dedupe only over accepted links.** Candidate/abstained rows
  render as separate results — honest duplication over silent false merges.

## 4. QA protocol (the bar the job must clear before P1 consumes it)

- **Positive sample:** 200 random accepted links, stratified by score band and
  country; ≥98% correct on manual review, else thresholds tighten and the job reruns.
- **Negative-pair set:** ≥100 same-producer/wrong-cuvée pairs (the Aug-29 risk class:
  Rouge/Blanc/Rosé triplets, Riserva/normale, vineyard-designate vs village) that MUST
  abstain or reject; any acceptance is a release blocker.
- **Coverage report:** accepted / review / abstained counts by country + score
  histogram, committed with the run (`docs/plans/ws-ident-runs/`). Silent truncation
  is forbidden — what was dropped is stated.

## 5. False-merge recovery

- Every accepted link records provenance: run id, score vector, rule version.
- **Split:** unlink + tombstone the pair (never re-auto-linked; review only).
  Facts sourced through the bad link are invalidated by provenance cascade (WS-PROV
  makes this a query, not a hunt).
- **Merge of two canonicals:** allowed only via operator review; keeps a redirect row
  so tenant references never dangle.

## 6. Provisional identities (from D4)

Rows created with placeholder identity (`producer = "Unknown"`) are marked
provisional, excluded from linkage input and canonical promotion, and queued for
resolution. They can match TO existing canonicals later; they never seed new ones.
