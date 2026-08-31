# Unified Search + Companion, Canonical Facts Layer, Recommendations, and Product Tiers

**Date:** 2026-08-31 · **Revision:** v2.1 (audit amendments + owner rulings recorded)
**Status:** DRAFT — grilled and decided with Devin (10-question session); audited by
GPT-5.6 Sol (xhigh) and Grok 4.6 (verbatim reports:
`2026-08-31-unified-search-audit-record.md`); the six consensus amendments folded in;
**§6.2/§6.3 owner rulings recorded 2026-08-31** (ODbL segregated partition · Wine
Images 126K interim acceptance · Wine-Searcher trial until P4). Remaining before P1
code: legal review of the segregation posture, the D-006b amendment (§6.1), and the
normal spec/ledger process.
**Supersedes in part:** the three-surface search split (global-search.tsx / scan
WineSearchPanel / assistant-panel.tsx). Amends D-006b (see §6.1).

**v2 changes (from the audit):** new P0 identity+rights spine phase; §6.2 rewritten as a
pre-schema architecture gate with an ODbL compliance-mode decision; crowd-fill reframed
from "ownership" to a contributor license grant; D-006b amendment ratifies tiers 2+3
together before P1; Free-tier companion quota + tenant-kind × plan × feature matrix +
Enterprise phase; D5–D7 split into named workstreams with a provisional-identity rule
and a stated eval objective.

---

## 0. Problem statement

Terroir currently ships **three search surfaces** backed by **three different corpora**:

| Surface | Backend | Corpus |
|---|---|---|
| Header "Search all wines…" (`src/app/(app)/global-search.tsx`) | `GET /api/wines/search` | `wines` (tenant cellar only) |
| Scan page panel (`src/app/(app)/scan/views/wine-search-panel.tsx`) | + `GET /api/wines/lwin-search` | `lwin_catalog` (211k rows, 8 text cols, no vintage/image) |
| AI companion dialog (`src/app/(app)/assistant-panel.tsx`) | `GET/POST /api/assistant` | `xwines_catalog` (type, body, acidity, abv, grapes[], harmonize[], vintages[]) |

Devin's direction: **one box that does everything** — instant lookup, filtered search, and
conversational companion — plus a database where **every wine is as fully described as
possible**, a **recommendation system**, and a product that serves personas from weekend
drinker to 40k-bottle enterprise, with referral commerce and subscription revenue.

Known live bugs this plan fixes in passing:
- Neither search pass matches **region or varietal**, though both placeholders promise it
  (`search_wines_fuzzy` scores over `producer || name` only).
- A vintage token in the query ("Savart 2019") **hurts** the match instead of ranking the
  bottling first.
- `AssistantQuery` has no vintage field even though `xwines_catalog.vintages` exists; no
  demonym mapping (Italian→Italy); `country`/`region` are scalar, not lists; no notion of
  soft preference ("I love…") vs hard filter.

---

## 1. The one box (kills all three surfaces — at parity, not before; see P1)

### D1 — Three-tier query engine
1. **Tier 1 — trigram lookup** ("savart", "chablis"): existing ILIKE + `search_wines_fuzzy`
   path plus the catalogue index (§3). No model call, no added latency.
2. **Tier 2 — struct compile**: when the deterministic parser leaves content words
   unrecognized, an LLM compiles the text into the **same whitelisted `AssistantQuery`
   contract** — never SQL, never prose, never sees cellar rows. Parser runs first, always.
   **Tier-2 ops spec (audit A4):** deterministic fallback to parser-only results on
   provider error or timeout (hard budget ~2s), per-tenant rate limit, monthly spend
   ceiling with alerting, no retention of query text by the provider beyond the call.
3. **Tier 3 — conversation**: open questions and multi-turn follow-ups get a companion
   answer (see D2 grounding rules).

Tiers 2 AND 3 both overturn D-006b's deferral and are **ratified together in one
amendment before P1 code lands** (§6.1) — tier 2 is an external provider dependency and
does not slip in under the deterministic lane's letter.

Deterministic parser extensions (regardless of tiers): `vintage?: number | {min,max}`,
`country?: string[]`, `region?: string[]`, DEMONYM map, preference-vs-filter flag,
pairing/vintage-token stripping before name match. **Scoped honestly (audit, Grok
MINOR): this is an NLP contract with its own test corpus and acceptance bar, not a bug
fix** — budgeted as a P1 workstream, with only the region/varietal matching repair
labeled a bug fix.

### D2 — Grounding contract for conversation mode
- Any wine presented as **buyable/pourable/in-cellar must be a real row** (cellar,
  canonical catalogue) and renders as a result card, never inline prose.
- **General knowledge is allowed but visually marked** as not-from-your-data; where a
  source exists (critic review, enrichment record, Wine-Searcher) it is **cited inline**.
- Discovery/recommendation of wines the tenant does not own is in scope (that is half the
  point). The failure mode being designed against is unchanged from D-006b's rationale: a
  fake wine on a checkable screen.

### D3 — Form factor: command palette that grows
One header field opens a ⌘K-style overlay. Typing → instant ranked results. Recognized
constraints render as **removable chips**. Conversational phrasing expands the same
surface into answer + cards + follow-up input. Plus the five Sol additions (adopted all):
1. **Availability-first rows** — qty · bin · service status lead every cellar row; cellar
   vs catalogue visually separated; a discoverable wine must never look pullable.
2. **Shortlist tray** — pin 2–5 wines across searches; survives interruptions at service.
3. **Persona-aware ranking, visibly controllable** — restaurant boosts available-now /
   price-band / enough-for-the-table; collector boosts drink windows / collection gaps.
   Compact scope controls: (Available now)(My cellar)(Catalogue/All).
   **Authority order when signals conflict (audit, Sol MINOR): explicit user-selected
   scope > user role > plan tier > tenant_kind default.** Who may pull/consume/override
   facts/publish crowd corrections is role-gated per the D11 matrix.
4. **Task-specific row actions** — catalogue: *Add to cellar*; owned: *Pull bottle* /
   *Shortlist* / *Mark consumed*. Quick-add captures qty, format, bin, cost inline.
5. **Interpretation chips** — ambiguous terms ("Italian" = origin? cuisine?) show the
   chosen reading as a tappable chip with one-tap alternatives; clarifying question only
   when interpretations would materially change the ranking.

### D4 — Behavior spec (all 18 items, carried from the grill)
Input: single header field via app shell; 2-char min; ~200ms debounce; abort-on-keystroke;
fuzzy/typo/accent tolerant both corpora; **region + varietal matching (bug fix)**;
vintage-token strip + rank; `/` focus, Esc clear, ↑↓ move, Enter open (deleting the scan
panel un-shadows `/` on /scan). Scope: default searches everything merged+ranked; single
"My cellar" narrowing chip (no radiogroup); cellar ≥ catalogue at equal score; dedupe on
lwin/canonical id **where the P0 linkage provides one; unlinked rows are never presented
as deduplicated**. Results: WineThumb (initials fallback) + name + producer·vintage·
region·country; provenance badge; cellar rows add qty/bin/86'd/window; recents chips
(port wine-search-recents.ts); empty state routes to scanner **for cellar-scope misses;
catalogue-scope misses offer "ask the companion" instead** (audit, Grok MINOR); "See
all" → /cellar?q=. Actions: click/Enter opens wine; inline add with pending/added/error;
catalogue add = find-or-create. **Provisional-identity rule (audit A6, Sol MINOR): a
row created with placeholder identity (producer "Unknown") is marked provisional,
excluded from canonical promotion and linkage, and surfaced for later resolution** —
never silently folded into the graph.

Clicking a catalogue wine: **add-to-cellar-first is NOT required** — catalogue rows get a
detail view rendered from canonical facts (§2); add is one action on it. Enrichment is
queued on create (fixes blank-label-until-manual-batch). Until P2 lands, the catalogue
detail view renders what the interim contract can honestly show (identity + any linked
X-Wines features), with unknowns visibly unknown.

---

## 2. Canonical facts layer

**Audit A6: D5–D7 are several projects, not one phase.** Named workstreams, each with
its own acceptance bar (sequenced in §7):

- **WS-IDENT** — entity resolution: identity policy + linkage (was "D7 bullet"; see D7).
- **WS-FACTS** — facts schema + overrides + resolution view (D5).
- **WS-PROV** — per-field provenance/licensing model: provenance is **per value**, not
  per row — a `(field, value, source_id, confidence, licensed_at)` structure the license
  registry can gate at read time (D6; audit, Sol MAJOR 5).
- **WS-MIGRATE** — reversible production migration of every reader off `wines.*`
  enrichment columns, with backfill conflict adjudication. **Tenant→global promotion
  rule (audit, Grok MAJOR): a tenant's existing enrichment values backfill canonical
  only through the same review queue as crowd-fill — never automatically.**
- **WS-PRICE** — `market_prices` time series pipeline (its own data product; freshness,
  caching rights, retention).
- **WS-ENRICH** — enrichment orchestration + reconciliation (cascade execution,
  enrich-on-create queue, re-enrichment).
- **WS-ADJUDICATE** — the review/moderation console (shared by crowd-fill and backfill).

### D5 — Facts move to the canonical layer, with tenant overrides
- New `canonical_wine_facts` (keyed to existing `canonical_wines`): images (bottle +
  label, distinct), grapes[] with %, acidity, body, abv, pairings[], appellation/vineyard,
  summary, bottles_produced, purchase_links jsonb, …
- New `canonical_vintage_facts` — **grain decision (audit, Grok MAJOR): keyed to
  `(canonical_wine_id, vintage)`, NOT to `wine_variants`** — variants are tenant-scoped
  bottlings; vintage facts are global. `wine_variants` continues to reference the pair.
- `market_prices` as a **time series** (WS-PRICE), not three columns on `wines`.
- `wines` (tenant) keeps only tenant-owned state: qty/bin/86'd/pricing targets/overrides.
- **`wine_fact_overrides`** per restaurant; UI shows "Rating 94 (your override, was 91)".
  Resolution view = canonical overlaid by override; every screen reads the view.
  **Overrides never feed canonical** except via the review queue, as an ordinary
  crowd-fill submission (audit, Sol MAJOR 5).

### D6 — Source cascade + per-value provenance + crowd-fill
Fill order: X-Wines join → LWIN → rule engine → Wine-Searcher → LLM inference (marked,
low-confidence). **Every value stores source + confidence + license linkage** (WS-PROV).
Unknown renders as visibly unknown with a "help us fill this" affordance — **which ships
in the same phase as the review queue it feeds (audit A3); until WS-ADJUDICATE exists,
the affordance does not render.**

**Crowd-fill rights (audit A3 — replaces v1's "owns outright" claim, which was legally
unsupported):** contributors (somm photographs a label, corrects a fact) grant Terroir a
**perpetual, irrevocable, sublicensable license** via contributor terms accepted at
upload — the photographer retains copyright. Terms include takedown process, consent,
attribution policy, and moderation/rollback. Crowd content is the one image class whose
license Terroir fully controls — still the licensing strategy, stated correctly.

---

## 3. One merged canonical catalogue

### D7 — Search index over `canonical_wines` (WS-IDENT is P0)
Cross-link LWIN (identity/coverage) and X-Wines (features) into ONE entry per wine using
the existing `lwin7` / `xwines_wine_id` keys. One search list; one rec substrate; one
facts anchor.

**Executable identity policy required before linkage runs (audit A1/A6, Sol MAJOR 6):**
- Definition of "one wine" across producer aliases, cuvée, appellation, label changes;
  vintage and format live at the variant/vintage-facts grain, never the wine grain.
- Match-quality bar: acceptance threshold, **abstention target** (unlinked is a valid,
  visible outcome — never force-linked), sampled QA protocol, human review capacity.
- False-merge recovery: merge/split with lineage, reversible.
- `identity_status` lifecycle drives what search may claim (deduped vs candidate).
- **Known prior evidence (2026-08-29 pre-merge review, not yet revalidated):**
  `match_xwines` has same-producer/wrong-cuvée false-match exposure and `lower(...)`
  predicates unmatched by raw-column trigram indexes — both must be resolved or
  explicitly waived as part of WS-IDENT's acceptance.

---

## 4. Recommendations

### D8 — Hybrid engine, honestly phased
`score = w_c·content + w_cf·collaborative + w_e·embedding` — but **w_cf starts ≈ 0**
(one real tenant today) and earns weight as tenants accrue; embeddings require the D-006b
amendment (§6.1) and the cross-tenant/provider data terms below. An **offline eval
harness** is a deliverable, not an afterthought — **with a stated objective (audit, Sol
MAJOR 7): v1 optimizes accepted-recommendation rate (click-through to a wine detail or
add/shortlist from a rec), evaluated offline against held-out pour/reorder events.**
Changing the objective is a recorded decision, not a tuning knob.
- Content: similarity over canonical feature vector (grapes, region, body, acidity, price
  band, pairings, window). Explainable — every match states its reason.
- Collaborative: co-occurrence over holdings + pour_events. **This is a cross-tenant
  data product (audit A5/Sol 7): requires a consent/contract basis in the tenant terms,
  anonymization + minimum-cohort thresholds before any signal is used, tenant opt-out,
  retention limits, and leakage testing. These terms are a P3 entry gate.**
- Embedding: vector over tasting notes + facts for the long tail. **Provider terms:
  wine facts only, never cellar rows or tenant identity; and no embedding of
  ODbL-derived field values until §6.2's compliance mode confirms it does not
  constitute redistribution of the derived database.**

### D9 — Taste signal: implicit + explicit
Strongest first: explicit favourite/rating (new, lightweight UI on wine pages) →
reordered-after-sellout → pour velocity → held-in-cellar (weak prior). Explicit always
outranks inference; a somm can correct a wrong inference by rating.

---

## 5. Product: personas, tiers, commerce

### D10 — Commerce: referral → marketplace → (maybe) distribution
- **v1 Referral:** "Where to buy" renders licensed-retailer links (Wine-Searcher affiliate
  feeds) — no alcohol license held, revenue via referral fees, fills the where-to-buy
  fact. **Honesty amendments (audit, both MAJOR): revenue is gated on the Wine-Searcher
  production tier and capped by the ~60% LWIN-match ceiling — "revenue from day one"
  is struck; a coverage/margin model is a P4 entry artifact. Referral links get an
  age-gate/tied-house legal review before shipping (audit, Grok MINOR).**
- **v2 Marketplace:** in-app checkout, licensed retailers fulfill, commission take.
  Requires retailer onboarding, Stripe Connect, state-shipping matrix — **a separate
  regulated-commerce program, not a routine extension (audit, Sol MAJOR 9).**
- **v3 Distribution:** own licenses/inventory — a separate, explicit company decision.

### D11 — Two tenant kinds × graduated plans
D-001's `tenant_kind` (restaurant | personal) stands. Personas are **plan tiers**, not
different apps. Onboarding asks two questions (for yourself or a business? roughly how
many bottles?) and routes:
- **Free** — search/discover + small cellar (acquisition funnel). **Companion quota
  (audit A5): tier-2/3 model calls capped (e.g. N companion queries/day, exact N set by
  the unit-economics note below); tier-1 search is never metered.**
- **Collector** ($9–15/mo) — unlimited cellar, windows, analytics, higher quota
- **Pro** ($99+/mo) — team, lists, pours, invoices, pricing, service features
- **Enterprise** (custom) — multi-location, API, SSO, SLA — **now phased (P5, §7);
  "Enterprise has no phase" was an audit finding, not a plan.**

**Required artifact before P4 (audit A5, Grok MAJOR): the `tenant_kind` × plan ×
feature matrix** — resolving, among others: what a restaurant on Free gets (service UX
like pull/86/bin is Pro-gated; Free restaurants get search + cellar view), cellar-cap
overage behavior, and a **unit-economics note** (model cost per companion query ×
quota × conversion assumptions) that sets the Free quota and prices.

One codebase; ranking/defaults may read tenant_kind + tier; navigation does not fork.

---

## 6. Governance gates (block code, not planning)

### 6.1 D-006b formal amendment — before P1
Tier-2 struct compile AND tier-3 conversation AND embeddings overturn the deferral
recorded in `docs/plans/2026-08-28-camera-first-decisions-recorded.md`. **One amendment
ratifies all three explicitly** through the `app_spec.txt` + feature-ledger process
before P1 code lands (audit A4 removed v1's "tier 2 arguably fits" hedge — tier 2 is an
external provider dependency and is gated like one). The amendment carries the tier-2
ops spec (D1) and the D2 grounding contract as its terms.

### 6.2 Licensing — a PRE-SCHEMA ARCHITECTURE gate (audit A2; was a display gate in v1)
**The merge itself — not the display — creates the licensing exposure.** Combining
X-Wines-derived values into `canonical_wine_facts` plausibly creates an ODbL
**derivative database**; public use can trigger share-alike and machine-readable-access
obligations (ODbL §§4.4–4.6) — which would force opening the very catalogue positioned
as the moat, and constrain the Enterprise API (D11) and any embedding export (D8).

**Rulings — decided by Devin 2026-08-31 (modal session):**
1. **ODbL compliance mode: (a) SEGREGATED PARTITION.** X-Wines-derived values live in a
   registry-tagged, attributed, share-alike-scoped partition; the app reads only the
   resolved facts view, so proprietary/licensed/crowd values replace X-Wines values
   over time with **no schema change and no functionality change** — the ODbL share of
   served values trends to zero, at which point the partition (and obligation) is
   dropped. This mode dictates the WS-PROV schema. **Legal review still passes over the
   collective-vs-derivative posture before ingestion (remaining P0 gate).**
2. **Wine Images 126K: ACCEPT FOR INTERIM USE.** `commercial_use_allowed` flips to
   `true` accompanied by (i) a written risk-acceptance memo, (ii) a sunset plan tied to
   replacement coverage (crowd-fill + Wine-Searcher labels + OFF + tenant uploads),
   (iii) a per-image kill switch so any takedown is instant and individual. Exposure
   window = until replacement coverage exists; the sunset metric ships with WS-PROV.
3. **X-Wines channel conflict** (CC0 GitHub vs ODbL Kaggle): governed as ODbL until
   resolved — subsumed by ruling 1 (segregation assumes the stricter reading).
4. OFF photos CC BY-SA attribution/share-alike obligations stated in WS-PROV.
The per-source license registry (P4) is the enforcement point; **the facts layer reads
it per value** (WS-PROV), and the search index excludes what the registry forbids.

### 6.3 Budget gates
- **Wine-Searcher — ruled 2026-08-31: TRIAL THROUGH P0–P3** (500 calls/mo covers dev,
  linkage-QA sampling, demos). The entry production tier (~$200/mo) is committed only as
  a **P4 entry gate**, justified by the coverage/margin model artifact; scale tiers only
  if referral revenue exceeds their own cost. (LWIN-keyed lookups cap coverage at ~60%
  at any tier.)
- LLM/embedding provider spend for tiers 2–3 and the rec engine — bounded by the D1
  spend ceiling and D11 quotas.

---

## 7. Phasing (resequenced per audit A1 — the spine ships before the UI that needs it)

| Phase | Ships | Entry gate |
|---|---|---|
| **P0 — Identity + rights spine** | §6.2 rulings **(recorded 2026-08-31: segregation / 126K interim / trial WS)**; WS-IDENT: identity policy, linkage job to its match bar, `identity_status` lifecycle, prior-evidence findings resolved; 126K risk memo + kill switch | legal review of the segregation posture (last open rights gate) |
| **P1 — Search merge** | Palette (D3/D4) against cellar + **interim two-corpus contract** (honest dedupe only where P0 linked; no fake-merge claims); parser workstream + region/varietal fix; tier-1+2 engine; **old surfaces deleted only at feature parity** (recents, add, `/`-focus, assistant entry point preserved until tier 3) | §6.1 amendment (tiers 2+3 ratified); P0 linkage available for dedupe |
| **P2 — Canonical facts** | WS-FACTS, WS-PROV, WS-MIGRATE, WS-ENRICH (+ WS-PRICE start); enrich-on-create; catalogue detail view; WS-ADJUDICATE + crowd-fill affordance + contributor terms (ship together) | P0 identity; §6.2 mode dictates schema |
| **P3 — Companion + recs** | Tier-3 conversation; content recs + eval harness (stated objective); taste signals (D8/D9) | §6.1 (already ratified); cross-tenant consent terms in tenant contract; embedding provider terms |
| **P4 — Product** | Referral links (post legal review), tiers + onboarding + feature matrix + unit-economics note, billing | P2 facts; Wine-Searcher tier decision; matrix artifact |
| **P5 — Enterprise** | Multi-location, API (§6.2-compliant), SSO, SLA | P4 billing; §6.2 mode (API must not redistribute a derived DB unlawfully) |

Each phase lands through the normal spec/ledger process; nothing in this document
authorizes implementation by itself.

---

## 8. Decision + audit provenance

Decisions D1–D11 made by Devin in a 10-question grill session, 2026-08-31, with
recommendations argued by Claude (Opus/Fable) and a form-factor review by GPT-5.6 Sol
(Codex default lane, high effort). **v2 amendments derive from the 2026-08-31 dual
audit — GPT-5.6 Sol (xhigh) and Grok 4.6 — recorded verbatim in
`2026-08-31-unified-search-audit-record.md`; consensus findings were folded in full,
single-model findings folded where marked.** Facts verified against the repo at time of
writing; file references: global-search.tsx, wine-search-panel.tsx, assistant-panel.tsx,
assistant-query.ts, wines/search route, lwin-search route, schema.snapshot.sql
(canonical_wines, wine_variants, lwin_catalog, xwines_catalog), wine-searcher.ts,
corpus-image.ts, P4 image-enrichment plan, camera-first decisions record, 2026-08-29
X-Wines pre-merge review (memory record; findings not revalidated).
