# D-006b Amendment — Ratifying Constrained NL Compile, Conversation Mode, and Embeddings

**Date:** 2026-08-31 · **Status:** RATIFIED by product owner (Devin), 2026-08-31
**Amends:** D-006b in `2026-08-28-camera-first-decisions-recorded.md`
**Parent plan:** `2026-08-31-unified-search-companion-and-canonical-facts.md` (v2.1)

---

## What D-006b said

> Defer embeddings, vector indexes, open-ended chat, and multi-turn conversational
> search from v1. Ship D-006a typed search and preserve the existing single-turn
> deterministic voice resolver. Extending that resolver with additional whitelisted
> filters is allowed only when it emits the same structured query contract; it must not
> generate SQL or ungrounded prose.

## What this amendment ratifies

Three capabilities, ratified **together** (per the 2026-08-31 dual audit, which found
that tier 2 is an external-provider dependency and must not slip in under the
deterministic lane's letter):

1. **Tier 2 — LLM struct compile.** When the deterministic parser leaves content words
   unrecognized, an LLM may compile the query text into the same whitelisted
   `AssistantQuery` contract. It never generates SQL, never generates prose, and never
   receives cellar rows or tenant identity.
2. **Tier 3 — conversation mode.** Open questions and multi-turn follow-ups receive a
   companion answer under the D2 grounding contract (below).
3. **Embeddings.** A vector index over canonical wine facts (never cellar rows, never
   tenant identity) for long-tail retrieval and the recommendation engine's embedding
   term.

## Binding terms

**Tier-2 ops spec:**
- Deterministic parser always runs first; the LLM sees only queries the parser could
  not fully place.
- Hard timeout ~2s; on provider error/timeout, fall back to parser-only results —
  search never breaks because a provider did.
- Per-tenant rate limit; monthly spend ceiling with alerting; provider retention of
  query text limited to the call itself.

**D2 grounding contract (tier 3):**
- Any wine presented as buyable/pourable/in-cellar must be a real row (cellar or
  canonical catalogue) and renders as a result card, never inline prose.
- General knowledge is permitted but visually marked as not-from-your-data; cited
  inline where a source exists.
- The failure mode D-006b guarded against — a fabricated wine on a checkable screen —
  remains the design invariant.

**Embedding terms:**
- Input scope: canonical wine facts only. No cellar rows, no tenant identity, no
  natural-language queries containing tenant data.
- No embedding of ODbL-partition values until the §6.2 legal review confirms the
  export does not constitute redistribution of the derived database.
- Provider selection and DPA recorded before the first production embedding run.

**What D-006b still forbids (unchanged):**
- Generated SQL.
- Ungrounded prose presented as data.
- A parallel semantic result model — tiers 2/3 and embeddings feed the one D-006a
  query/result contract and the one palette surface.

## Ledger process

Recording this amendment does not itself authorise implementation. Feature assertions
for tiers 2/3 and embeddings enter `app_spec.txt` `<core_features>` and
`docs/feature-ledger.json` **on the landing branch of the phase that builds each**
(P1: tier 2; P3: tier 3 + embeddings), with `scripts/verify-feature-ledger.mjs`
constants updated in the same commit so the gate stays green at every SHA. Natural-
language telemetry follows D-010 redaction.
