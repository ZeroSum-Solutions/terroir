# Risk-Acceptance Memo — Wine Images 126K, Interim Commercial Use

**Date:** 2026-08-31 · **Status:** ACCEPTED by product owner (Devin), 2026-08-31
**Decision:** `image_sources.commercial_use_allowed` for the Wine Images 126K source
(`packager-cc-by-4.0-scraped-content` registry row, per P4 §3.1/§6) flips to **true**,
for an **interim window only**, under the mitigations below.
**Parent:** `2026-08-31-unified-search-companion-and-canonical-facts.md` §6.2.2.

## The risk being accepted

The dataset card's CC BY 4.0 badge covers the *compilation* (IDs, structure), not the
~108k underlying photographs, which are retailer product photos scraped under a
research fair-use claim. A packager cannot grant rights over pixels it does not own.
Commercial display therefore carries takedown/complaint exposure from retailers or
photographers. P4's author explicitly declined to make this call; the product owner
now has, with eyes open: the images are the difference between a visually complete
catalogue and a mostly-blank one during the prototype/early-sales window.

## Mitigations (all three are conditions of the acceptance, not suggestions)

1. **Per-image kill switch.** Every served image resolves through the image-source
   registry at read time (WS-PROV). Disabling one image, or the whole source, is a
   data change — no deploy, effective immediately, cached copies purged. A takedown
   contact route (email + in-app) maps a complaint to its image id within one day.
2. **Sunset plan tied to replacement coverage.** Replacement lanes, in priority
   order: crowd-fill (contributor-licensed — the owned lane), Wine-Searcher label
   images (API-licensed, post-P4 tier), OFF photos (CC BY-SA, attributed), tenant
   uploads + Terroir renders. WS-PROV ships a standing metric — *% of served images
   from the 126K source* — reviewed at each phase gate; the source is retired
   (flag back to false) when replacement coverage crosses 80% of actively-served
   wines, or at first credible legal challenge, whichever comes first.
3. **Honest captioning stays.** The corpus-image kind rules (`corpus-image.ts`:
   label / producer / representative) apply unchanged — interim use does not loosen
   what an image claims to be.

## Rollback

Flip the registry row to `commercial_use_allowed = false`. Every consumer already
reads the registry per value, so rollback is one UPDATE plus cache purge. No schema,
no code.
