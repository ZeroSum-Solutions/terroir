# Audit Record — Unified Search + Canonical Facts Plan

**Date:** 2026-08-31 · **Plan audited:** docs/plans/2026-08-31-unified-search-companion-and-canonical-facts.md (DRAFT)
**Auditors:** GPT-5.6 Sol (Codex lane, reasoning xhigh) · Grok 4.6 (x-ai/grok-4.6 via OpenRouter, $0.04)
Both received the identical adversarial brief. Verbatim reports below; synthesis lives with the plan's next revision.

---

## GPT-5.6 Sol

Two load-bearing defects are already clear: P1 promises a merged experience before the canonical linkage exists, and §6 leaves rights decisions open even though P2 would combine and persist licensed data. I’m validating only the licensing mechanics from primary license/official sources; the rest of the audit stays grounded in the supplied plan.
web search: 
web search: site:opendatacommons.org licenses odbl 1.0 derivative database share alike official ...
The plan is not execution-ready. Its main dependency—the licensed, correctly linked canonical data spine—is scheduled after features that already require it.

## CRITICAL

1. **P1 cannot ship as specified before P2.** D3/D4 promise one merged ranking, canonical-ID deduplication, catalogue detail pages backed by canonical facts, provenance, images, and catalogue actions. But D5–D7—the linkage, facts model, resolved view, and provenance—do not exist until P2. P1 must either retain separate corpora behind a temporary contract or move the D7 identity/index slice ahead of the palette. Deleting two existing surfaces in P1 compounds the migration risk.

2. **Licensing is treated as a display gate when it is an architecture gate.** D5–D7 ingest and combine sources before §6.2 resolves whether the result is a derivative or collective database. Public use of an ODbL derivative can trigger share-alike and machine-readable-access obligations, potentially exposing the very catalogue described as a moat. This decision must precede schema design and ingestion, not merely “what’s displayed” in P2. [ODbL §§4.4–4.6](https://opendatacommons.org/licenses/odbl/1-0/)

3. **D6’s “Terroir owns crowd photos outright” is unsupported.** Uploading a photograph does not itself transfer ownership; D6/P4 omit contributor terms, signed assignment or license grant, takedowns, consent, retention, and moderation policy. The photographer is generally the initial owner. [U.S. Copyright Office](https://www.copyright.gov/engage/photographers/) This invalidates the stated licensing moat unless rights acquisition is designed explicitly.

## MAJOR

4. **P1 falsely claims “nothing external.”** Tier 2 in D1 requires an LLM provider, latency/cost limits, structured-output reliability, and the §6.3 budget gate. §6.1 says ratification is only “arguably” unnecessary; that is incompatible with the standing governance rule. Ratify Tier 2 before P1 and specify deterministic fallback, timeout, rate limit, retention, and spend ceiling.

5. **The canonical facts layer is several projects disguised as one phase.** D5–D7 comprise:

   - master-data/entity-resolution infrastructure;
   - a field-level provenance and licensing system;
   - conflict-resolution and override semantics;
   - a reversible production migration of every reader;
   - a pricing time-series pipeline;
   - enrichment orchestration and reconciliation;
   - an operational adjudication console.

   “Every field stores source + confidence” conflicts with the presented wide-row/JSONB schema unless provenance is modeled per value. Missing decisions include source precedence, freshness, deletion, conflicting arrays, vintage/format identity, merge/split rollback, and whether overrides may feed canonical data.

6. **D7 has no executable identity policy.** “One wine” is undefined across producer aliases, cuvée, appellation, vintage, bottle format, and label changes. Match-quality thresholds, abstention targets, human review capacity, and false-merge recovery are absent. Prior August 29 code-review evidence—not revalidated here—already found same-producer/wrong-cuvée false-match exposure and a likely live-scan performance problem.

7. **D8/D9 silently create a cross-tenant data product.** Collaborative scoring over holdings and pour events needs consent/contract basis, anonymization, minimum-cohort protection, opt-out, retention, and leakage testing. “Privacy-stated” is not a decision. The eval harness also lacks its objective: recommendation relevance, pours, purchases, discovery, or retention can demand different rankings.

8. **The economics are unproven and internally hazardous.** D11 gives Free users companion access while D1/D8 introduce variable LLM and embedding costs without quotas. D10 asserts “revenue from day one,” but §6.3 says useful Wine-Searcher coverage requires paid access and remains approximately 60%-limited. Missing: affiliate eligibility and attribution window, conversion assumptions, geographic coverage, caching/price-history rights, gross-margin model, abuse controls, and retailer-link fallback.

9. **P4 bundles three separate programs.** Billing/entitlements, enterprise SaaS capabilities (multi-location, API, SSO, SLA), and D6’s UGC moderation/trust system are not one phase. Marketplace checkout in D10 is another regulated commerce and retailer-operations program, not a routine v2 extension.

## MINOR

10. **D4’s `producer = "Unknown"` undermines D7.** Persisting placeholder identity during find-or-create will create duplicates and contaminate linkage unless records remain explicitly provisional and excluded from canonical promotion.

11. **Persona-aware ranking lacks authority rules.** D3/D11 do not decide whether tenant kind, plan, user role, or user-selected scope wins when they conflict, nor who may pull, consume, override facts, or publish crowd corrections.

**Single biggest failure mode:** Terroir ships the unified UX around a catalogue whose identity, rights, and provenance are not yet trustworthy. Every downstream promise—search quality, recommendations, details, referral commerce, and tiers—then amplifies bad or unusable canonical data.



---

## Grok 4.6

**CRITICAL**

**P1 ships “merged search” before the merge (D1, D3, D4 vs D7, P1–P2).**  
D1 Tier 1 is “existing path **plus the catalogue index (§3)**.” D3/D4 require one ranked list, cellar≥catalogue, **dedupe on lwin/canonical id**, catalogue detail from **canonical facts (§2)**, enrich-on-create. D7 (the “load-bearing work item”) and D5/D6 are **P2**. P1 still has three corpora and no stable identity. You either ship a fake merge (new bugs: double hits, wrong add-to-cellar, vintage tokens still fighting LWIN-without-vintage) or P1 silently includes D7.

**§6.2 is unresolved while D5–D8, D10, P2–P4 assume a displayable proprietary catalogue.**  
X-Wines **ODbL** + merged canonical **is a derived database** (share-alike). Images **commercial_use_allowed=false**. OFF is CC BY-SA. Facts layer “must read” the registry, but rulings are “still open.” P2 depends on those rulings; P3 recs/embeddings and P4 referral sit on the same substrate. Shipping P2 without a ruling is infringement or an empty facts UI. Opening/share-aliking the merge fights a paid catalogue, affiliate moat, and Enterprise API (D11).

**D7 entity resolution is a project, scheduled as a P2 bullet.**  
~211k LWIN × ~100k X-Wines, match-quality bar, sampled QA, `identity_status` lifecycle — not specified (threshold, unmatched rows, LWIN7 vs vintage, many-to-many). Every later surface (search dedupe, facts keys, recs, WS LWIN lookups) inherits identity errors.

---

**MAJOR**

**Governance vs P1 (D1, §6.1, P1).**  
Gates “block code.” Tier 2 LLM compile is in P1; §6.1 says the amendment should **ratify tier 2 and 3 explicitly**. P1 “amendment only if tier-3 rides along” conflicts with §6.1 and with D1’s three-tier engine.

**§1 “kills all three surfaces” vs P1 “delete 2 surfaces” vs companion in P3.**  
Which two die? Scan search dies in P1 before catalogue detail/facts (P2). Assistant lives until P3 while D4 already specifies one field and empty-state→scanner (wrong for catalogue-only misses).

**Wine-Searcher used as facts source before it is paid/capable (D6, D10, §6.3, P2 vs P4).**  
Cascade in P2 includes WS; production **$200–2k/mo**, trial 500 calls, **~60% LWIN ceiling**. D10 v1 referral and `purchase_links` need that coverage. P4 “revenue from day one” is holey and expensive relative to Free/Collector (D11).

**Monetization last; LLM on Free (D11, D1–D2, P3–P4, §6.3).**  
Free = search + **companion** + cellar. Companion/tier 2 are model calls; one tenant today (D8). P4 billing is a dependency, not a workstream. Unit economics: pay-per-query acquisition, recs with **w_cf≈0**, crowd-fill moat with no crowd.

**D5 identity fork + tenant→global leak.**  
`canonical_vintage_facts` keyed to **`wine_variants` or (canonical_id, vintage)** — undecided; `wine_variants` may be tenant-scoped. Backfill from `wines.*` into canonical can promote one tenant’s enrichment globally. Overrides vs crowd promote-to-everyone (D6) have no authority model.

**D6 crowd-fill vs P4 queue.**  
P2: “help us fill this.” P4: moderation, trust, rollback, photos. P2 affordance is a dead letter or unmoderated writes to the shared DB.

**D8 embeddings / collaborative vs licensing and privacy.**  
Embeddings need a **stated position** on sending facts (never cellar) to a vendor — not decided; may “convey” an ODbL derived DB. Cross-tenant co-occurrence over holdings/pours is a privacy/consent product, not a weight.

**D4 add/enrich-on-create in the P1 behavior spec; cascade is P2.**  
Find-or-create without canonical ids repeats today’s blank-label bug under a new UI.

**D11 tiers vs D3 restaurant UX.**  
Availability/86/bin/pull are default palette behavior; Pro is where “pours” are sold. Free restaurants get service UX; paying collectors pay for cellar caps. No matrix: `tenant_kind` × plan × feature (D-001 vs D11). Enterprise SSO/API/SLA have **no phase**.

---

**MINOR**

- D2 discovery-in-scope vs D4 “See all” → `/cellar?q=` and empty→scanner.  
- D3 interpretation chips + shortlist-at-service = a workflow product, listed as “Sol additions.”  
- D10 v1 links still need age-gate/tied-house review; v2 shipping matrix is a company.  
- Parser (demonyms, preference vs filter, vintage ranges) is an NLP contract, not a “bug fix” (P1).  
- `market_prices` time series is a market-data product hiding in D5.

---

**Missing decisions (assumed away)**  
Match bar and unmatched-row policy (D7); wine vs vintage grain; LLM/embed vendor + DPA + EU; ODbL compliance mode (open merge / don’t merge / attribution-only UX); image fair-use yes/no; Free cellar cap and overage; restaurant-on-Free; who moderates UGC with one tenant; WS affiliate vs API legal; whether Enterprise API distributes the derived DB; ranking calibration across unequal corpora; tier-2 latency/cost/fallback; override roles.

---

**Biggest failure mode**  
The product is a **single canonical graph** (search, grounding, recs, where-to-buy). **You are not legally cleared to build or show it (§6.2), and you scheduled the identity merge (D7) after the UI that requires it (P1).** Everything else (tiers, referral, companion) is decoration on that crack.

