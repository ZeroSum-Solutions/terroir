# Tier-2 Struct Compile — Operational Spec

**Date:** 2026-09-01 · **Status:** DRAFT — open decisions in §6 are Devin's
**Annexes:** `2026-08-31-d006b-amendment-unified-search.md` (RATIFIED 2026-08-31)
**Parent plan:** `2026-08-31-unified-search-companion-and-canonical-facts.md` (v2.1) D1

---

## 0. What this is, and what it is not

The D-006b amendment is already ratified. It lifted the deferral on tier-2 struct
compile, tier-3 conversation and embeddings, and it states their binding terms
**qualitatively** — "hard timeout ~2s", "per-tenant rate limit", "monthly spend ceiling
with alerting". Those are commitments, not numbers, and no build can be gated on them
as written.

This annex turns each term into a number or a mechanism. **It re-ratifies nothing** and
changes no term the amendment set; where it proposes a value the amendment left open, it
is marked as an open decision in §6 rather than assumed.

---

## 1. What changed since the amendment was written

Measured on `main` at `4af8001a`, 2026-09-01. Two facts move the scope materially.

**The companion makes no model call today.** `/api/assistant` is entirely
deterministic: `parseAssistantQuery` produces a whitelisted struct and every field
returned is a column read from a row. Nothing has crossed the external-provider
boundary yet, so tier 2 is a genuinely new dependency and the amendment's gating of it
as one was correct.

**Two deterministic parsers now cover more than the plan assumed.** `query-parse.ts`
(slice 3a) reads vintage, country, region and colour as filters plus body as a
preference, with demonyms. `assistant-query.ts` reads type, body, blend, pairing,
country, region, grape, vintages and price ranges. Between them the deterministic lane
already answers a large share of what D1 imagined tier 2 doing — including price and
pairing, which this session's earlier summary wrongly assigned to tier 2.

---

## 2. What tier 2 is actually for

Measured against both parsers. Every row below is a real probe result, not a
hypothetical.

| Query | Deterministic result | Verdict |
|---|---|---|
| `something under $40 for fish` | assistant: `priceMax 40`, `pairing [Rich Fish, Lean Fish]`, nothing unrecognised | **Already answered.** Not tier-2 work. |
| `an elegant italian red under 60 for lamb` | assistant misses `italian` and `elegant` | **Cheap deterministic fix** — see §2.1 |
| `a gift for my dad who likes bold reds` | assistant misses `reds` (plural) | **Cheap deterministic fix** — see §2.1 |
| `a red that isn't cabernet` | assistant returns `type: Red`, drops the negation | **Correctness bug** — see §2.2 |
| `a zippy food-friendly white` | `zippy`, `food-friendly` unrecognised | **Tier 2.** Paraphrase outside the fixed phrase lists. |
| `cheaper than the pol roger` | nothing understood | **Tier 2/3.** Comparative against another wine. |
| `something for a dinner party` | nothing understood | **Tier 3.** Occasion, not a filter. |
| `what should I open tonight` | nothing understood | **Tier 3.** Open question. |

So tier 2's residual job is narrower than D1 implies: **paraphrase and synonym outside
the fixed phrase lists, and multi-constraint prose the phrase matchers miss.** Occasion
and comparative queries are tier 3. Two rows above should never reach a provider at all.

### 2.1 Two gaps that are deterministic work, not provider work

The assistant parser's vocabulary is built from the tenant's own cellar `DISTINCT`
values, so it knows `Italy` but not `italian`, and `red` but not `reds`. The search
gazetteer already carries both — demonyms and plurals — because slice 3a had to. **These
should be shared before any model call is considered**: spending a provider call to
recover "italian" when a lookup table in the same repo already resolves it is paying for
capability we own. Sequence this ahead of tier 2; it also shrinks tier 2's traffic.

### 2.2 Negation is a live correctness bug, not a missing capability

`a red that isn't cabernet` currently returns `type: Red` with the negation silently
dropped, so the reader is shown reds **including** Cabernet — the opposite of the
constraint they typed, presented with no notice. This is precisely the confident-wrong-
answer class the program exists to remove, and it ships today.

It does not need tier 2. The honest minimum is to detect a negation token and report it
as unrecognised, so the panel's existing "I did not understand X" notice fires instead
of the parser affirming the inverse. Excluding on it properly is a follow-up. **Raise
this as its own defect; do not let it wait on the provider lane.**

---

## 3. Binding terms, made operational

### 3.1 Provider, model and call configuration

`src/lib/ai/anthropic-client.ts` already exists — a module-scoped Anthropic singleton
keyed on `ANTHROPIC_API_KEY`, `maxRetries: 2`, `timeout: 100_000`, used today only for
invoice extraction.

**Tier 2 must not reuse that client's configuration.** Its 100-second ceiling is fifty
times the tier-2 budget; a shared client would let a slow compile hold a search request
open long past the point where falling back to parser-only results was the right answer.
Tier 2 gets its own client instance (or per-call override) with the §3.3 budget.

Model recommendation: **Haiku 4.5**. A struct compile of a ≤300-character query against
a fixed whitelist is a cheap mechanical classification, which is that lane's purpose;
Sonnet 5 is the escalation if the §5 acceptance bar is missed. Open decision — §6.

### 3.2 The tenant-data constraint — and the conflict it creates

The amendment's term is absolute: tier 2 "never receives cellar rows or tenant
identity."

**Compiling against the assistant's own vocabulary would violate that term.**
`AssistantVocabulary` is built from the tenant's `DISTINCT` country / region / grape
values, so shipping it in a prompt as the enum list would disclose a projection of the
cellar — which countries, regions and grapes this tenant holds. That is tenant data
even though it contains no rows.

**Resolution: compile against a GLOBAL vocabulary, validate against the tenant's.** The
prompt carries the corpus-wide and gazetteer vocabulary only. The returned struct is
then intersected with the tenant vocabulary locally, in our process. A value the tenant
does not hold simply drops out and is reported as not-found, which is the existing
behaviour for `a red from Narnia`. Nothing tenant-specific crosses the boundary, and the
term holds.

This is a design constraint, not a preference. It must be a test, not a comment.

### 3.3 Timeout and fallback

- Hard per-call budget: **2,000 ms**, measured from request dispatch to parsed struct.
- `maxRetries: 0` for tier 2. A retry cannot fit inside the budget, and the fallback is
  strictly better than a slow success.
- On timeout, provider error, malformed output, or schema-validation failure: **return
  parser-only results.** Never an error to the reader, never an empty page attributable
  to the provider. Report the degradation to Sentry exactly as the search route already
  reports its own (`reportDegradation`), so a provider outage is visible without being
  user-facing.
- Tier 2 runs **after** the deterministic parser and only on queries it could not place.
  It never runs on a query the parser fully understood.

### 3.4 Rate limit, spend ceiling and kill switch

No rate-limiting infrastructure exists in `src/lib` today; this is new build, and the
estimate below is why it is small.

Order-of-magnitude cost, arithmetic shown so it can be corrected rather than trusted: a
compile carries roughly 600 input and 100 output tokens. At Haiku-class pricing that is
on the order of **$0.001 per call**, so ~10,000 calls/month lands near **$10–15**. The
ceiling exists to bound a runaway loop or abuse, not to ration normal use. *Confirm
current list pricing before adopting these figures — they are an estimate, not a quote.*

Proposed mechanism, all three open decisions in §6:
- **Per-tenant daily quota**, counted in Postgres (one row per tenant per day). Not
  in-memory: a container restart must not reset a spend guard.
- **Monthly account ceiling** with alerting at 50% and 90%, and a hard stop that
  degrades to parser-only rather than erroring.
- **Kill switch**: an env flag that disables tier 2 instantly across all tenants,
  mirroring the per-image kill switch §6.2 already requires. A capability with an
  external dependency needs an off switch that does not require a deploy.

Free-tier quota is D11's `tenant_kind × plan × feature` matrix and its unit-economics
note. **Tier-1 search is never metered** — that term is already binding.

### 3.5 The whitelist must not widen

Tier 2 emits the *same* `AssistantQuery` contract, which means the output is validated,
not trusted:

- The struct is parsed with a zod schema mirroring `AssistantQuery` exactly. Unknown
  keys are **dropped, not passed through** — a provider that invents `sweetness` must
  not create a filter dimension nobody reviewed.
- Enum-valued fields are checked against the global vocabulary before the tenant
  intersection in §3.2. A hallucinated region never becomes a predicate.
- No free-text field reaches a query. The compile output is structured values only.
- The amendment's standing prohibitions are unchanged and need a test each: no generated
  SQL, no prose presented as data, no parallel result model.

### 3.6 Telemetry

Natural-language telemetry follows D-010 redaction. Log the **compiled struct** and the
outcome (hit / miss / fallback / timeout), not the raw query text; raw text is
tenant-adjacent and its retention has no stated purpose here. Provider-side retention is
limited to the call itself, per the amendment.

---

## 4. Prerequisites, in order

1. Share the search gazetteer's demonyms and plurals with the assistant parser (§2.1).
2. Fix the negation bug (§2.2).
3. Confirm the §6 decisions.
4. Build the quota/ceiling/kill-switch mechanism (§3.4) — **before** the first provider
   call, not alongside it.
5. Then tier 2.

Steps 1 and 2 are worth doing regardless of whether tier 2 is ever built.

---

## 5. Acceptance bar

Follows the slice-3a precedent — a parser with a corpus and a stated bar, not a vibe:

- A fixture corpus (`fixtures/tier2-compile-cases.json`) of queries the deterministic
  parser cannot place, each with the struct it should compile to and a `why`.
- **Precision over recall.** A compile that emits the wrong constraint is worse than one
  that emits nothing, because nothing routes to the companion and the wrong constraint
  produces a confident wrong page. Bar: no case may compile to a constraint the query
  does not support; unplaceable input must return empty, not a guess.
- A property test that no output can widen the whitelist (§3.5).
- A test that no tenant-derived value appears in any prompt (§3.2).
- Fallback tests: timeout, provider error, malformed JSON, schema violation — each
  returns parser-only results and reports the degradation.

---

## 6. Open decisions — Devin's

1. **Model lane.** Haiku 4.5 recommended (§3.1); Sonnet 5 if the bar is missed.
2. **Per-tenant daily quota.** A number. Depends on D11's plan matrix; a starting value
   can be set now and revised there.
3. **Monthly account ceiling and alert thresholds.** Recommendation: a ceiling
   comfortably above the §3.4 estimate, alerting at 50% and 90%.
4. **Whether tier 2 ships at all in P1**, given §2 — the residual job is paraphrase and
   multi-constraint prose, and §2.1/§2.2 recover part of that deterministically for no
   provider cost. A defensible answer is to do steps 1–2, measure what still misses, and
   decide tier 2 against that evidence rather than against the original plan's estimate.

---

## 7. Ledger

Unchanged from the amendment: recording this does not authorise implementation. Feature
assertions enter `app_spec.txt` `<core_features>` and `docs/feature-ledger.json` on the
landing branch of the phase that builds each capability, with
`scripts/verify-feature-ledger.mjs` constants updated in the same commit so the gate is
green at every SHA. `docs/feature-ledger.json` is never hand-edited (AGENTS #5).
