# Terroir — Decision record for the field-walk PRD's six gates

**Status:** DECIDED — by delegation, not by Devin
**Date:** 2026-08-30
**Decides:** §6 of `docs/plans/2026-08-30-terroir-product-prd.md`
**Authority:** Devin, 2026-08-30: *"i will not be around so do not stop … you can't stop to ask
me for any direction or to unblock anything or for my opinion at all."*

---

## 0. How to read this

The PRD deliberately refused to guess six product decisions. Devin then explicitly delegated
them rather than answer them. Each decision below is therefore **reversible by construction**:
where a gate had a cheap answer and an expensive answer, this record takes the cheap one and
records what the expensive one would cost, so changing our mind later is a step forward rather
than a rewrite.

Every decision states: **the call**, **why**, and **what it would take to reverse**.

---

## D1 — SCAN-03: migration sources (decides §6.1)

**The call.** v1 is **export-file ingestion**, not credentialed API pulls. Ship a source-aware
importer with named presets for **Binwise**, **Bevrly** (the "Beverly" heard in the walk — see
the correction below), **CellarTracker**, **Vivino**, and a **generic** fallback. Each preset is
a column-mapping profile over the CSV/XLSX path that already exists.

**Why.** Credentialed pulls are blocked on procurement, not on code — Toast needs a developer
account and partner credentials, and Binwise/BevSpot need commercial agreements. None of that
can be obtained unattended overnight. Export-file ingestion covers the same user story
("migrate my collection over seamlessly") for 100% of the named sources today, because all of
them export CSV/XLSX.

### D1 correction, 2026-08-30 — "Beverly" is **Bevrly**, not BevSpot

The PRD guessed BevSpot "with low confidence." That guess was wrong, and the evidence was
already inside this repository:

1. `docs/evals/README.md:3` reads *"`top10-evals.yaml` is the merge-gate contract for the
   **Bevrly-response build**."* Terroir was, in part, built as a response to a product called
   Bevrly. This is not a stray typo — it is a named build target.
2. Bevrly is real, and is exactly the right category: **Bevrly Inventory Scanner**, a restaurant
   beverage-inventory app built around barcode-scanning hardware that "centralizes inventory
   **and locations**" — <https://apps.apple.com/ca/app/bevrly-inventory-scanner/id6740220524>.

"Beverly" → "Bevrly" is a far better fit than "Beverly" → "BevSpot", and it is corroborated by
our own repo rather than inferred from a phoneme.

**Consequence.** The preset is named `bevrly`. A `bevspot` preset is kept alongside it — BevSpot
is also a real product in this space and a restaurant may genuinely use it — but `bevrly` is the
one the field note meant.

**What is still unverified:** Bevrly's actual export column names. No schema for them has been
confirmed, so that mapping profile is marked best-effort in code, and the generic auto-detect
path is what actually carries a user whose columns don't match. A preset that silently mismaps
columns is worse than no preset. The same caveat applies to any vendor whose real export headers
could not be verified.

*Credit where due: this correction came out of the documentation-staleness audit, which flagged
the lone "Bevrly" string as worth one minute of Devin's recall before D1 was treated as settled.
It was worth rather more than a minute.*

**Reversal cost.** Low. The preset layer sits above the importer; an API-pull source becomes a
new *fetcher* feeding the same mapping profile.

---

## D2 — SCAN-07: how literally to take Vivino's architecture (decides §6.2)

**The call.** Adopt reading **(a), visual-match-first**, as the target architecture — and note
that building the label-embedding corpus is a Tier 3 epic that no unattended run delivers. What
ships now is the half of (a) that is buildable without a corpus licence:

- typo-tolerant **text** matching (D3), which Vivino demonstrably has and we demonstrably lack;
- a **cache** on the recognition path so a repeated bottle is not a repeated cold LLM call.

**Why.** The PRD's own recommendation was (a), and its reasoning holds: a cold LLM call does not
reliably hit ~2s p50. But committing to (a) and *only then* discovering we cannot license a
corpus would be the expensive order. Text matching and caching are strictly required under both
readings, so they are the correct thing to build before the corpus question is answered.

**Reversal cost.** None — nothing built here is discarded under either reading.

---

## D3 — SCAN-06: the Frédéric Savart miss (decides §6.3)

**The call.** Split as the PRD proposed, and build only the buildable half:

1. **Fuzzy text matching — BUILD NOW.** Typo-tolerant search over the wine corpus, so
   "Fredric savart" finds Frédéric Savart. This is independent of image recognition and is a
   demonstrated gap against the reference (`vivino-search-results-fuzzy.png`).
2. **Corpus coverage — NOT BUILDABLE UNATTENDED.** Licensing a grower-champagne /
   small-domaine / natural-wine corpus is a commercial negotiation. Recorded as blocked on
   procurement, with the Savart bottle kept as a permanent regression fixture.

**Why.** The reproducible miss is a ~2,030-bottle grower cuvée. No amount of model quality finds
a wine that is not in the corpus. Pretending otherwise by tuning the recogniser would burn the
run on the wrong problem.

**Reversal cost.** n/a — this is a scope split, not a design choice.

---

## D4 — CELLAR-02: what is 3D cellar v1 (decides §6.4)

**The call.** **(c) — a 2D, photo-backed bin grid.** Real photographs of the user's actual
storage, mapped to bin positions, with wines assigned to those positions. No mesh, no LiDAR, no
photogrammetry in v1.

**Why.** The PRD recommended `(c) → (b) → (a)` and the reasoning is sound: (c) delivers the
value Devin actually described — *know what the bottle and the space look like*, and beat
Invintory's "ugly abstract mock-up" by using the real thing — in weeks rather than quarters.
Each later step is a superset. Photorealism is the north star; it is not v1.

Critically, (c) is also the only one of the three that an unattended run can make progress on
at all.

**Reversal cost.** Low. The bin-position data model is identical across (a)/(b)/(c); only the
renderer changes.

---

## D5 — Design authority for the visual rework (decides §6.5)

**The call.** Derive **strictly** from the committed contract. `DESIGN.md` (Nocturne) is
CI-enforced across palette, contrast, token sync, and typography. Every layout change in this
run:

- uses **only** tokens already in `DESIGN.md` — no new colours, no new type scales;
- **restructures** existing elements rather than inventing art direction;
- commissions **no** new imagery.

Where GLOBAL-03 asks for "hero imagery", this run uses imagery the product already owns —
bottle photography from `wines.hero_image_url` — and does not generate or source new art.

**Why.** The house rule is that visual identity is client-owned and never invented freehand, and
Devin owns this product. Restructuring a control stack into one row is an *organisation*
decision the PRD already specified in Devin's own words; choosing a new visual language is not,
and stays out of scope. This is the reading that satisfies both the "fix it, don't ask me"
instruction and the standing constraint.

**Reversal cost.** Low — a later art-direction pass replaces imagery without touching layout.

---

## D6 — SCAN-04: what does deleting an applied invoice do (decides §6.6)

**The call.** Three rules, together:

1. **Nothing vanishes on its own.** A scan that returns zero items, or fails, **stays in the
   ledger**, visible, with a stated reason. This is a display guarantee, not a delete policy.
2. **Delete is always explicit and confirmed.** The user chooses it; it is never automatic.
3. **Deleting an invoice whose lines were already applied to inventory REVERTS that
   inventory first**, through the import domain's existing revert path — never a second,
   parallel unwind. The confirmation states the bottle-count impact before the user commits.
   Deletion is audited.

**Why.** Devin asked for two things that sound contradictory — *entries must stay viewable* and
*there must be a delete option*. They are not contradictory: (1) governs what the system does
unasked, (3) governs what the user does deliberately. Soft-delete was rejected because it hides
a row the user explicitly asked to remove, which is its own confusion.

Refusing to delete an applied invoice (the PRD's cheapest option) was rejected as a dead end:
the user's real intent — "this scanned wrong, get rid of it" — is *most* common exactly when
the bad data already landed in inventory. A delete that refuses precisely when it is needed is
not a feature.

The safety requirement the PRD raised is met by reusing the existing revert path rather than
writing a new one, plus a confirmation that shows the impact.

**Reversal cost.** Medium — reverting a revert policy means a migration on the audit table.
This is the most consequential decision in this record and the one most worth Devin's review.

---

## 7. What remains genuinely blocked

These are not decisions. They are external dependencies, and no delegation unblocks them:

| Item | Blocked on | Not code |
|---|---|---|
| Toast / Binwise / BevSpot API pulls | partner credentials, developer accounts | procurement |
| Grower-champagne / small-domaine corpus coverage | a commercial data licence | procurement |
| New hero art direction | Devin's brief, per D5 | approval |

Recorded here so they are visible as costs rather than as silence.
