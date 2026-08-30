# P4 — Image Enrichment: Sourcing, Licensing, Caching, and Serving

> **STATUS CORRECTION (2026-08-29).** This document is no longer "design only," and
> it no longer describes what shipped. A **narrower** design landed instead, in
> migrations `0130`–`0134`: `0130_wine_image_storage.sql`,
> `0131_xwines_catalog.sql`, `0132_canonical_wines_xwines_link.sql`,
> `0133_xwines_catalog_lower_trgm_indexes.sql`, `0134_match_xwines_top_n.sql`, with
> `src/lib/wine-intelligence/xwines-profile.ts`. That is X-Wines catalogue linkage
> plus basic image storage — **not** the full derivative-pipeline, licensing, and
> caching design specified below, and **not** at the migration numbers this document
> and its amendments predict (`0112`–`0121`).
>
> Treat everything below as the **superseded original proposal**. The licensing and
> derivative-caching sections describe work that has not been built. Before acting on
> any part of it, diff it against what `0130`–`0134` actually did and cut a fresh
> spec for the remaining gap.

Status: superseded in part — see the correction above. Original status line follows.

Status: design only. No code, no migrations applied, no Supabase stack touched by this pass.

> **Amendments (2026-08-24, from `2026-08-24-visual-wine-platform-synthesis.md` v3, audit
> round 2):**
> 1. **Migration renumbering:** the new global `wine_editions` table (synthesis D1) takes
>    `0112`; P4's files are **renamed to `0113`–`0120` in the same commit that lands `0112`**
>    (round-3 correction: no standing "read +1" rule — one numbering scheme only). This
>    document's inline `0112`–`0119` references are updated when P4's tickets are cut from
>    the published migration manifest (0112–0121+; containers/slots/placements take 0121+).
> 2. **Cylinder unwarp** joins the derivative pipeline as a best-effort derivative (raw crop
>    always retained); the implementation lands first as a shared library in the Gate-0 scan
>    service and P4 reuses it at scale (synthesis D3).
> 3. **NOT amended:** `wine_images` keeps its `canonical_wine_id` + `(vintage, size_ml)`
>    value-tuple keying exactly as designed (P2 §10's zero-schema-change commitment).
>    A briefly proposed `wine_edition_id` re-key was withdrawn in synthesis v3; editions join
>    images at read time via the tuple. §12's `render_3d` extension point stays reserved but
>    is unused by the template-geometry 3D approach.

> **Migration-number reservation.** Confirmed by direct inspection, 2026-08-23:
> `terroir-vw` (branch `feat/visual-wine-prototype`, tip `d8086ce`) is the furthest-along
> lane and tops out at `0101_wine_identity_backfill.sql` (P2). `terroir-vw-p1` and
> `terroir-vw-audit` both top out at `0076_csv_import_batches.sql` — they have not merged
> P2 or P3. `terroir-af-b` (branch `fix/af01-cellar-sections-mobile` — round-3 correction:
> an earlier pass named a nonexistent `terroir-af-d`; verified directly via `git branch
> --show-current` and `ls supabase/migrations`) also has a full `supabase/` tree, topping
> out at the same `0076`. **P4 takes `0112`–`0125`, per the run's own instruction — this
> design uses `0112`–`0119` and leaves `0120`–`0125` unclaimed** rather than padding to
> fill the range. Re-verify `ls supabase/migrations/ | sort | tail` against every live
> worktree immediately before creating files; `terroir-vw` had five files locally modified
> and one new untracked file at read time (see §2.3 — another lane appears to be actively
> closing the D9 finding this design was briefed against), so treat this reservation as
> current as of this read, not as permanent.

## 0. What P4 is, and isn't

P4 is the sourcing → licensing → caching → serving pipeline for wine images: given a
resolved wine identity (P2's `canonical_wines`/`wine_variants`), acquire zero or more
images for it, record exactly where each one came from and under what legal terms, cache
the bytes in Terroir-controlled storage, and serve the best one back to a search result.

**Explicitly out of scope, named so nobody assumes it's covered:**

- **Bottle-photo identification** (OCR/barcode/embedding/FAISS matching a phone photo
  against the enriched reference set — the blueprint's Milestone 3). P4 produces the
  reference set; it does not consume it. `wine_images` is designed so a future
  `image_embeddings` table can key off `wine_images.id` with zero changes here (§11).
- **Fixing D9** (the forgeable `identity_status='lwin_verified'` claim on
  `canonical_wines`). That is P2/audit-lane territory. §3 states exactly how P4 behaves
  *given* that D9 may or may not be fixed, without depending on the fix landing.
- **Building the 3D bottle-render pipeline.** §11 confirms the schema can hold a render
  without a rewrite; it does not design the renderer, the template library, or the
  GLB/glTF export.
- **Raising the CSV import cap or changing import chunking.** That's P3's file
  (`2026-08-23-p3-chunked-import.md`). P4 assumes P3's chunked-apply model is in place
  and hangs its own trigger point off it (§8).

## 1. Hard dependency on P2, stated precisely

Every table in this design has a foreign key into `canonical_wines` or reads
`background_jobs` (0052/0075). **P4 cannot be applied before P2 (`0097`–`0100`) merges.**
This mirrors P3's own stated dependency on P1's manifest contract (`2026-08-23-p3-chunked-
import.md` §2.3/§7) — a real sequencing risk, not a data-quality edge case. Unlike P3's
P1 dependency, P2 is not vaporware: I read `0097`–`0100` end to end (they are real,
tested, three rounds of audit-fixed migrations with real `supabase/tests/*` pgTAP files
and real `src/domains/identity/*` code), so the interface this design consumes
(`canonical_wines(id, producer_norm, cuvee_norm, lwin7, identity_status)`,
`wine_variants(restaurant_id, canonical_wine_id, vintage, size_ml)`, `merge_canonical_wines`)
is verified against a live artifact, not a specification placed on someone else's future
work.

## 2. Where images attach, and why not where the blueprint's own sketch said

### 2.1 The blueprint's model vs. what P2 actually built

The blueprint (§5) sketches `wine_variants` as a **global** table —
`id, canonical_wine_id, vintage, size_ml, format, lwin11, lwin16, display_name` — no
`restaurant_id`. That sketch predates P2's actual implementation. The `wine_variants` P2
shipped (`0098_wine_variants.sql`) is **restaurant-scoped**:

```
create table public.wine_variants (
  id                uuid        primary key default gen_random_uuid(),
  restaurant_id     uuid        not null references public.restaurants(id) on delete cascade,
  canonical_wine_id uuid        not null references public.canonical_wines(id) on delete restrict,
  vintage           int,
  size_ml           int         not null default 750,
  ...
```

0098's own header explains why: "a global vintage+format catalog shared across tenants
would recreate exactly the cross-tenant-write risk C01/C05/C06 already demonstrate
elsewhere in this schema." Two restaurants that both carry a 2015 Château Margaux each
get their **own** `wine_variants` row (same `canonical_wine_id`, different `id`,
different `restaurant_id`).

This matters enormously for P4. If a `wine_images` row attached to `wine_variant_id`, it
would inherit that table's tenant-scoping — Restaurant B would need its **own** enrichment
job and its **own** cached image for the exact same real-world bottle Restaurant A already
enriched. That is precisely the failure mode 0097's own header rules out: "a later
image/enrichment pass (P4) can serve one cached asset to both [tenants]... without either
tenant's inventory ever becoming visible to the other."

### 2.2 The fix: vintage and size as plain columns on `wine_images`, scoped by `canonical_wine_id`

`canonical_wines` is the one identity table that is genuinely global (not restaurant-
scoped) in the shipped schema. `wine_images` attaches there, **not** to `wine_variants`,
and carries `vintage`/`size_ml` as its own plain nullable columns rather than joining
through a variant row:

```
wine_images.canonical_wine_id  -- required, global, shared across every tenant
wine_images.vintage            -- nullable; null follows the SAME "null = NV" convention
wine_images.size_ml            -- 0098 already uses for wine_variants.vintage
```

This is safe precisely because P2's own design principle already established it:
"vintage and bottle size are NEVER part of [`canonical_wines`] — they are `wine_variants`'
job... and are always exact keys, never fuzzy-matched" (0097 header). An exact key never
needs restaurant-scoping to be correct — two tenants' 2015/750ml Margaux is the *same*
exact key regardless of which tenant is asking, so storing it directly on the global
`wine_images` row loses nothing P2 was protecting against (P2's tenant-scoping concern is
about *contested writes* to a shared row, e.g. one tenant's fuzzy match corrupting
another's; `vintage`/`size_ml` here are never fuzzy-matched inputs, they're plain integers
supplied by whichever enrichment job created the row).

**Consequence, stated as a benefit, not a coincidence:** because `wine_images` never
references `wine_variants(id)` or `wines(id)` at all, `merge_wines` (0100's tenant-level
wine merge) needs **zero changes** for this design. Only `merge_canonical_wines` — the
global merge — needs to learn about `wine_images` (§9).

### 2.3 Identity mutability and trust (D9)

**What I verified live, 2026-08-23, in `terroir-vw`'s working tree (uncommitted at read
time):** a "P2 ROUND-4 FIX (D9...)" is in progress against `0097_canonical_wines.sql`,
tightening the `canonical_wines` INSERT policy so `identity_status='lwin_verified'`
requires the submitted `lwin7` to **corroborate** against `lwin_catalog` (similarity ≥ 0.3
producer / ≥ 0.21 name), not merely match the `^[0-9]{7}$` format check the round-1 policy
enforced. Before this fix, any authenticated tenant could INSERT directly into
`canonical_wines` (the table grants `insert` to `authenticated`) claiming
`identity_status='lwin_verified'` with an arbitrary well-formed `lwin7` — the corroboration
gate existed only inside `resolve_wine_variants_bulk`'s procedural body (0099 §2.5), never
as a constraint on the raw table, so the RPC path was safe and the direct-insert path was
not. **This diff is uncommitted in a worktree another lane is actively editing. P4's design
does not depend on it landing, and does not depend on it being correct if it does land** —
for the reason below.

**Why P4 is safe regardless: it never uses `lwin7` as an image-search key.** Every join
against the free datasets, every DDGS query, every OCR-agreement check in this design uses
`producer`/`cuvee` **text** and `vintage`/`size_ml` — the same fields a human would use to
check the picture looks right. `lwin7` never appears in a query string or a join predicate
anywhere in §6–§8. This means:

- A forged-but-plausible `lwin7` (0099's own worked example: `producer='Garbage',
  cuvee='X', lwin7=<a real wine's LWIN>`) produces a canonical row whose *text* is garbage.
  Image search on garbage text finds nothing — the row simply fails to enrich (stays with
  zero images), which is the safe failure mode, not "receives some other real wine's
  pictures."
- A forged `lwin7` that also has *plausible* producer/cuvee text (the corroboration gate's
  actual blind spot even after the round-4 fix — a 0.3/0.21 similarity threshold is fuzzy
  by construction) still only causes P4 to fetch images that match **the row's own
  submitted text**, which is a correctness problem for `canonical_wines`/P2 to solve, not
  one `wine_images` can detect or cause on its own.

**What P4 cannot design away, and does not pretend to:** `resolve_wine_variants_bulk`
never updates an existing `canonical_wines` row's text once created (0097: "this table is
append-mostly... No update/delete policy"). If a row's producer/cuvee text was captured
wrong at creation and later passes for a real, different wine's LWIN under the fuzzy gate,
every image P4 ever attaches to that `canonical_wine_id` will be internally consistent
(text matches images, images match text) and durably wrong, with no signal in this design
that would ever surface it. This is named again as the single biggest residual risk in the
report back — it is a P2-identity problem wearing an image-enrichment costume, and no
schema choice inside `wine_images` fixes it. The one mutation path that *can* fix a wrong
identity — `merge_canonical_wines` — is handled in §9, including the fact that its repoint
is a blind `UPDATE`, not a re-verification.

**Identity mutability, precisely defined for this schema:** `canonical_wines` rows are
never edited in place (no UPDATE policy, confirmed above). The only two things that can
happen to one after creation are (a) nothing, or (b) it is the *source* of a
`merge_canonical_wines` call, in which case it is deleted and every referrer — now
including `wine_images` — is repointed to the target. "Identity can be wrong or can be
repointed" in this codebase concretely means "can be merged away"; there is no in-place-
correction case to design for beyond that.

## 3. Verified sources and licences

**Round-2 correction, stated plainly: two of the "already established" facts did not hold
up under primary-source re-verification, and I re-verified them myself rather than
re-litigating the instruction that told me not to.** WineSensed's CC BY-NC-ND 4.0
ruling-out stands unchanged. Wine Images 126K and X-Wines both needed a harder look than I
originally gave them, and both surfaced real findings — §3.1 and §3.2 below.

| Source | Licence | Verified how | Use |
|---|---|---|---|
| Wine Images 126K (HF `cipher982/wine-images-126k`) | **Contested — see §3.1.** The dataset card's badge says CC BY 4.0, but the card's own text limits that claim to the compilation, not the photographs. | Read the full HF dataset card directly, 2026-08-23 (`huggingface.co/datasets/cipher982/wine-images-126k`). | Bulk local join (fast, no network) — **but reclassified `commercial_use_allowed=false` by default pending §3.1's decision**, not the safe CC BY 4.0 source this design previously treated it as. |
| X-Wines | **Conflicting across the two primary channels — see §3.2.** GitHub repo: CC0-1.0 (verified). Kaggle page (the exact page cited, hosting the Slim archive actually used): ODbL/DbCL. | Fetched the raw GitHub `LICENSE` file directly, and the Kaggle dataset page (crawl4ai hit a bot-challenge; fell back to `firecrawl-scrape.sh` per protocol), both 2026-08-23. | Bulk local join. **Governed by ODbL/DbCL (the more restrictive of the two) until the conflict is resolved**, per this round's standing instruction. |
| Open Food Facts product photos | **CC BY-SA 3.0** | Fetched directly, 2026-08-23, via `crawl4ai-scrape.sh https://world.openfoodfacts.org/legal`: *"The product photos are available under the Creative Commons Attribution ShareAlike licence"* (linked to `creativecommons.org/licenses/by-sa/3.0/deed.en` on that page — 3.0, not 4.0). Data itself is ODbL, a separate licence not relied on here (only the photos matter to this piece). | Bulk local join (barcode-keyed), tier 1. **Share-alike flagged**, not silently dropped — see 4.4. |
| WineSensed / "Learning to Taste" | CC BY-NC-ND 4.0 | Established by the parent run. **Ruled out**, no carve-out. | Not used anywhere in this design. |
| Free web image metasearch (DDGS) | **No blanket licence — each result belongs to its original page.** | N/A — this is a discovery mechanism, not a licensed corpus. | Tier-2 gap-fill only, tagged `unrated-web-source` (4.5–4.6). Free, no signup, no billed-API concern. |
| Brave Image Search | N/A (discovery, same as DDGS) | Pricing verified in the parent run: $5/1,000 requests, $5/mo free credit. | **Disabled by default.** Not on the approved metered-API list (DeepSeek, Moonshot/Kimi, Firecrawl, OpenRouter, Kie.ai, FAL, LangSmith). **Needs explicit approval + this cost before enabling.** |
| SerpApi Google Images | N/A (discovery) | Pricing verified in the parent run: 250 free searches/mo, then $275/mo for 30,000. | **Disabled by default.** Not on the approved list. **Needs explicit approval + this cost.** |
| InVintory Partner API | Unknown — vendor terms not published | Not independently verifiable without sandbox access (parent run's own finding, unchanged). | **Disabled by default.** Needs a business agreement before it can be a data source at all, separate from any per-call cost. |
| Terroir-internal (renders, tenant uploads) | Terroir/tenant-owned | N/A | Always allowed; no attribution owed. |

### 3.1 Wine Images 126K — the packager cannot grant what it doesn't own

I gave this source none of the scrutiny I gave Open Food Facts' share-alike nuance the
first time through, despite it being this design's single largest and most-relied-upon
source. Corrected: I read the full dataset card, not just its licence badge. Two passages
matter, quoted verbatim:

- *"Data Collection Notice: The underlying wine bottle images were collected from publicly
  available retailer websites for research purposes under fair use. This dataset
  compilation, stable ID system, and organized structure represent our original
  contribution covered by this license."*
- Under "Ethical Considerations": *"Commercial Use: Please respect original retailers'
  intellectual property"* and *"Attribution: Images represent retailer product
  photography."*

The packager's own text draws the exact line the CC BY 4.0 badge does not draw for a
casual reader: the licence covers *the compilation* — the stable-ID scheme, the linkage to
the companion text dataset, the organized structure — not the underlying photographs,
which are retailer product photography, scraped under a **research fair-use** claim. Fair
use for research does not transfer to a different party's **commercial** redistribution of
the same images; a packager cannot grant CC BY 4.0 over content it does not own the
copyright to, no matter what badge it selects on the upload form. This is not a
share-alike-style nuance (§4.4's OFF case, where the underlying grant is genuine and the
only question is what a derivative owes back) — it's a genuine question of whether a
grant exists at all over the actual pixels this design would display.

**What this means concretely, stated as a finding, not a workaround:** I do not treat
Wine Images 126K as commercially safe by default. §6 reassigns its `image_sources.
default_license_id` to a new registry row, `packager-cc-by-4.0-scraped-content`
(`commercial_use_allowed = false`, `requires_attribution = true`), rather than
`cc-by-4.0`. Architecturally nothing else changes — it is still a pre-downloaded, local,
no-network-call dataset (the "tier 1" framing below is about *speed*, not licence safety,
and those two axes are no longer the same for this source). **This is the single largest
sourcing decision in this design and I am not making it for Devin:** either the research-
fair-use-to-commercial-compilation argument is one Devin/legal is willing to accept
(in which case `commercial_use_allowed` gets flipped back per-source, a one-line data
change, §14.2), or this source's ~108,000 images carry the same real exposure as an
uncleared web-search hit and the "safe bulk tier" this design leaned on is smaller than
either the parent blueprint or my first pass assumed.

### 3.2 X-Wines — the two channels for the same artifact disagree

The parent run's brief told me this was pre-cleared; that instruction has been withdrawn
because it traced to an earlier lane's claim, not to verification of the channel this
design would actually pull from. Re-verified directly, 2026-08-23:

- **GitHub repo root** (`github.com/rogerioxavier/X-Wines`): `curl`'d the raw `LICENSE`
  file directly — it is the genuine, complete CC0 1.0 Universal legal text. The repo's own
  sidebar badge also reads "CC0-1.0 license."
- **Kaggle page** (`kaggle.com/datasets/rogerioxavier/x-wines-slim-version` — the exact URL
  both the parent blueprint and my original design cite, and the one hosting the Slim
  archive that was actually live-tested for its 1,007 JPEGs): crawl4ai returned a
  bot-challenge (`ERR bot-challenge/interstitial`), so I fell back to
  `firecrawl-scrape.sh` per the standing local-first-then-Firecrawl order. The page's own
  License section reads **"Database: Open Database, Contents: Database Contents"**,
  linking to `opendatacommons.org/licenses/dbcl/1.0/` — ODbL for the database structure,
  DbCL for the individual contents. Not CC0.

I found no statement on either channel reconciling the two — the GitHub README makes no
distinction between "the code" and "the redistributed dataset artifact," and Kaggle's
listing carries no note pointing back to the GitHub licence. This is a genuine,
unreconciled conflict between two primary sources for the same underlying dataset, by the
same author. Per this round's instruction, **the more restrictive licence governs until
someone resolves it**: ODbL/DbCL, which — unlike CC0 — carries share-alike and attribution
obligations for the database. §6 reassigns `x_wines`'s `default_license_id` to a new
`odbl-dbcl-1.0` row (`commercial_use_allowed = true`, `share_alike = true`,
`requires_attribution = true`) rather than `cc0-1.0`. Resolving which channel is
authoritative — asking the author, or establishing that the Kaggle upload was a
mis-selected default rather than a deliberate choice — is carried forward as an open
question (§14.2), not decided here.

### 3.3 What "tier 1 / tier 2" means, and why it is now a purely architectural distinction

Wine Images 126K, X-Wines, and Open Food Facts are all **pre-downloaded, locally-indexed
datasets** — joins against them are plain indexed Postgres queries, not live network
calls, so they carry no rate limit and no external-dependency risk at enrichment time (the
risk is entirely in the one-time download/indexing step, which is out of scope here — it's
a data-engineering task, not a schema concern). **DDGS is the only enabled source that is a
live network call per lookup**, which is why it is the only one that needs rate-limiting,
backoff, and the fault-injection tests in §12 — the other three simply cannot fail at
enrichment time the way a live API can (they can only be *absent*, i.e. no match, which is
a completely different and much easier failure mode: zero rows, not a hung connection).
**This is now explicitly a statement about speed and failure modes only, not about licence
safety** — §3.1 means one of the three "tier 1" sources carries real, undecided commercial
exposure despite being architecturally identical to the two that don't.

## 4. Licence and provenance data model

### 4.1 The non-negotiable columns

Every `wine_images` row carries, as first-class typed columns (§5): `source_id`,
`license_id`, `attribution_text`, `retrieval_url`, `retrieved_at`. A future audit answers
"may we use this commercially, and who must we credit" with:

```sql
select w.id, w.canonical_wine_id, w.retrieval_url, w.retrieved_at,
       l.name, l.commercial_use_allowed, l.requires_attribution, w.attribution_text
from public.wine_images w
join public.image_licenses l on l.id = w.license_id;
```

No join through `image_sources`, no reach into `score_components`/`derivatives` jsonb, no
external knowledge required. This is the one query the whole non-negotiable requirement
reduces to, and it works because `license_id`/`attribution_text` are per-row, not inherited
implicitly from the source.

### 4.2 `image_licenses` — a lookup table, deliberately not a CHECK enum

Onboarding a newly-cleared licence (a legal/business fact) should never require a schema
migration. `image_licenses` is a small, service-role-writable reference table (§6), seeded
with exactly the licences this design actually uses — including a seed row for the
**ruled-out** CC BY-NC-ND 4.0, so a future accidental re-introduction of WineSensed is
caught by `commercial_use_allowed=false` at the data layer, not just by someone remembering
this document.

### 4.3 `image_sources` — the adapter registry, `enabled`/`requires_approval` as first-class

Every source this design names is a row (§6), including the three disabled/unapproved
ones, each carrying its own `approval_note` with the exact cost quoted in §3. **Flipping a
source on is a data change (`update image_sources set enabled = true where id = ...`)
after approval, never a code change** — this is the concrete mechanism behind "anything
else is a flag, not a decision."

### 4.4 The Open Food Facts share-alike nuance, named rather than absorbed silently

CC BY-SA 3.0 requires that a *redistributed derivative* of the photo carry the same
licence. **Round-3 correction: an earlier draft of this section justified deferring the
question by claiming Terroir's derivatives "are served inside the authenticated app, not
republished as a standalone creative work." That claim was false the moment §5.3 was
written — §5.3 originally put every `commercial_use_allowed=true` source into a fully
public, unauthenticated Storage bucket, which is the opposite of "inside the authenticated
app." §5.3 is now corrected (single private, authenticated-only bucket for every
`wine_images` row, regardless of licence tier) specifically so this section's premise is
true, not just asserted.** With that fixed, the substantive question is narrower than
originally framed, and is restated accurately rather than left resting on a premise that
used to be wrong: a private, authenticated-only bucket means Terroir's own app is the only
path to the bytes today, but `attribution_text` still lives only in the `wine_images` row,
not in the image file or the HTTP response that serves it — so if a signed URL is ever
handed to something outside Terroir's own UI (a partner integration, an export, a future
public menu image feature), the credit the licence requires would not travel with it. I am
not qualified to close this as a pure engineering call, so it is carried forward as an open
question (§14.2 Q11) rather than silently assumed fine. The data model supports whatever
answer comes back: `image_licenses.share_alike`/`requires_attribution` are already
recorded and queryable per row, so a future "embed attribution in image metadata before
any public-facing serving path" policy, or a "never crop/derive a share-alike image, serve
the original only" policy, are both additive — not a schema change.

### 4.5 Web-search discovery is not a licence, and is modeled as one honestly

DDGS (and, if ever approved, Brave/SerpApi) returns links to images whose actual copyright
holder is whoever's page it came from. There is no blanket "web search licence." Every
candidate this tier produces is tagged `license_id = 'unrated-web-source'`
(`commercial_use_allowed = false`, `requires_attribution = true` — best-effort attribution
to the source domain is still captured, since *some* credit is better than none even
though it does not itself clear the rights question). This is the honest alternative to
either (a) silently treating a random Wine.com photo as if it carried a CC licence it does
not have, or (b) refusing to build the gap-fill tier the blueprint's own live testing
showed is necessary for tail-wine coverage. The schema tells the truth; what the *product*
does with an untrue-to-clear image is an open question (§14.1), not an engineering one.

### 4.6 What this section does NOT cover

It does not decide whether `unrated-web-source` images are shown to end users by default —
that is §14.1, an open question. It does not build a rights-clearance workflow (a human
reviewing and re-tagging a specific image as cleared) — the schema supports it (update
`license_id` on a row once cleared) but no UI/process is designed here. It does not vet
InVintory's actual terms — that requires the sandbox access the parent run already flagged
as unobtained.

### 4.7 Public-surface exposure — verified, and enforced, not assumed

Terroir has a public, unauthenticated read surface. `wine_lists`, `wine_list_sections`, and
`wine_list_items` all retain table-level anon SELECT, and `0029_public_restaurant_read.sql`
exposes restaurant names publicly. This is not a hypothetical: it was the subject of two
confirmed audit findings on exactly this surface (C05 — cross-tenant menu linkage causing
anonymous re-exposure of a withdrawn wine; C06 — anon base-table SELECT ignoring
hidden-item rules). I read `0081_anon_column_scoping.sql` directly (verified fix branch) to
settle what anon can actually see today: on `wines`, exactly `id, name, producer, vintage,
varietal, region, serving_temp_min, serving_temp_max, serving_temp_label, is_eightysixed`;
on `restaurants`, exactly `id, name, eightysix_strategy, logo_url`. No image column on
either table, and a pgTAP test in `supabase/tests/0074_public_api_grants.sql` scans
`pg_attribute` to prove no *other* column carries an anon grant — this is pinned, not
incidental.

**This design does not merely rely on that being true of other tables — it makes the same
guarantee true of `wine_images` itself, enforced.** §5.1's migration grants `select` on
`wine_images` to `authenticated` only. There is no anon grant anywhere in this design —
not table-level, not column-level — and §15 adds a `pg_attribute`-scanning pinning test in
`0081`'s own style so a future migration cannot open that surface by accident.

Two things follow. First, `0081`'s own discipline is followed exactly, not merely admired:
**never grant table-level SELECT and then try to claw back columns with a REVOKE layered on
top** — `0081`'s own header documents that this codebase already learned that pattern
restricts nothing. `wine_images` avoids the question entirely by never granting anon
anything in the first place. Second, this narrows §14.2 Q1: the public-redistribution half
of the licence risk (an `unrated-web-source` image reaching the open internet) is closed
**by construction** today, and stays closed unless a future migration deliberately adds an
anon grant here — which the pinning test forces to be a conscious, reviewed act, the moment
someone builds a public-menu image feature. What remains genuinely open is narrower: only
whether showing an uncleared image to a restaurant's own authenticated staff, inside the
app, is acceptable — §14.2 Q1 still names that, unresolved.

## 5. Core schema

### 5.1 `wine_images`

```sql
-- 0114_wine_images.sql
create table public.wine_images (
  id                       uuid        primary key default gen_random_uuid(),
  canonical_wine_id        uuid        not null references public.canonical_wines(id) on delete restrict,

  -- Exact identity scope, never fuzzy. vintage=null follows the SAME
  -- "null means NV" convention 0098 already established for
  -- wine_variants.vintage -- NOT "unknown".
  identity_scope           text        not null check (identity_scope in ('base_wine', 'exact_vintage', 'exact_variant')),
  vintage                  int         check (vintage is null or vintage between 1900 and extract(year from now())::int + 1),
  size_ml                  int         check (size_ml is null or size_ml > 0),
  constraint wine_images_scope_shape check (
    (identity_scope = 'base_wine'     and vintage is null and size_ml is null)
    or (identity_scope = 'exact_vintage' and size_ml is null)
    or (identity_scope = 'exact_variant' and size_ml is not null)
  ),

  asset_class              text        not null default 'photo' check (asset_class in ('photo', 'render_3d')),
  role                     text        not null check (role in ('bottle_full', 'label_front', 'label_back', 'detail', 'render_3d', 'fallback')),

  state                    text        not null default 'discovered' check (
    state in ('discovered', 'downloaded', 'verified', 'probable', 'unverified', 'rejected')
  ),
  selected                 boolean     not null default false,
  rejected_reason          text,

  -- Provenance -- see 4.1. All first-class columns, never buried in jsonb.
  source_id                text        not null references public.image_sources(id),
  source_item_external_id  text,
  retrieval_url            text        not null,
  source_page_url          text,
  query_used               text,
  retrieved_at             timestamptz not null,
  license_id               text        not null references public.image_licenses(id),
  attribution_text         text        not null default '',
  license_url              text,

  -- Cached bytes. storage_path is content-addressed (5.3) and deliberately
  -- does NOT encode canonical_wine_id, so merge_canonical_wines (9) never
  -- has to move a single storage object -- only repoint this row.
  storage_bucket           text,
  storage_path             text,
  derivatives              jsonb       not null default '[]'::jsonb,

  width                    int,
  height                   int,
  mime_type                text,
  byte_size                int,
  sha256                   text,
  phash                    text,

  ocr_text                 text,
  confidence_score         real,
  score_components         jsonb       not null default '{}'::jsonb,
  validator_version        text,

  discovered_by_job_id     uuid        references public.background_jobs(id) on delete set null,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.wine_images is
  'Attaches to canonical_wine_id (global), never to wine_variant_id or '
  'wines(id) (both tenant-scoped) -- see docs/plans/2026-08-23-p4-image-'
  'enrichment.md §2 for why. vintage/size_ml are plain exact-key columns '
  'here, not a join through wine_variants, precisely because they are '
  'never fuzzy-matched (0097''s own stated invariant) and therefore need '
  'no tenant-scoping to be correct.';

create trigger wine_images_set_updated_at
  before update on public.wine_images
  for each row execute function public.set_updated_at();

create index wine_images_canonical_wine_id_idx on public.wine_images (canonical_wine_id);
create index wine_images_state_idx on public.wine_images (state);
create index wine_images_source_id_idx on public.wine_images (source_id);
create index wine_images_sha256_idx on public.wine_images (sha256) where sha256 is not null;

-- Exactly one selected image per (identity, role). Coalesce sentinels are
-- out of any real vintage/size_ml range, matching the coalesce(vintage,0)
-- convention 0098 uses for its own identity index, adapted so the
-- sentinel can never collide with a real value.
create unique index wine_images_selected_scope_idx
  on public.wine_images (canonical_wine_id, coalesce(vintage, -999999), coalesce(size_ml, -1), role)
  where selected = true;

-- Enforces 4.1's non-negotiable requirement at the data layer, not just by
-- adapter-code convention: a licence that requires attribution cannot be
-- attached to a row with no attribution text.
create or replace function public.wine_images_require_attribution()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_requires boolean;
begin
  select requires_attribution into v_requires
  from public.image_licenses where id = new.license_id;

  if v_requires and coalesce(btrim(new.attribution_text), '') = '' then
    raise exception 'attribution_required: license % requires a non-empty attribution_text', new.license_id;
  end if;
  return new;
end;
$$;

create trigger wine_images_require_attribution
  before insert or update of license_id, attribution_text on public.wine_images
  for each row execute function public.wine_images_require_attribution();

alter table public.wine_images enable row level security;

-- Global read, same posture as canonical_wines itself: this is shared
-- cache content, not tenant data.
create policy "anyone authenticated can read wine_images"
  on public.wine_images for select to authenticated
  using (true);

-- No insert/update/delete policy for authenticated: every write comes
-- from the service-role enrichment worker (§8) or a future validated
-- upload API route running as service-role after its own authorization
-- check -- never a direct client insert with RLS as the boundary. A
-- tenant's browser has no legitimate reason to originate a wine_images
-- row synchronously.
grant select on table public.wine_images to authenticated;

-- Deliberately NO grant to anon -- not table-level, not column-level.
-- Verified against 0081_anon_column_scoping.sql (fix branch): Terroir's
-- public/unauthenticated menu surface (wine_lists, wine_list_sections,
-- wine_list_items, plus the 0081-pinned anon column set on wines/
-- restaurants) exposes zero image columns today. That is exactly why
-- this must be an explicit, enforced absence rather than an omission a
-- future migration could accidentally fill: the day someone builds a
-- public-menu image feature, adding anon access here must be a
-- conscious, reviewed act -- column-level only, per 0081's own
-- discipline (never grant table-level SELECT and then try to restrict
-- columns with a REVOKE on top; that pattern has already been shown to
-- restrict nothing in this codebase). Until that review happens,
-- wine_images -- including uncleared, commercial_use_allowed=false rows
-- -- must stay unreachable by anon. See design doc §4.7, and the pinning
-- test in §15 that fails the build if this ever changes silently.
```

**What this migration does NOT cover:** it does not add `image_embeddings` (P5's job, keys
off `wine_images.id`, purely additive later). It does not normalize `derivatives` into its
own table (§5.3 states the trade-off and migration path explicitly). It does not add a
`model_format`/3D-specific column (§11) — `asset_class='render_3d'` rows simply leave
`width`/`height`/`sha256`/`ocr_text` null, which the schema already allows.

### 5.2 `identity_scope` vs. the blueprint's four-value enum

The blueprint's own sketch (§5) proposes `identity_scope: exact_variant | exact_vintage |
base_wine | candidate`. I dropped `candidate` deliberately: it conflates *scope* (how
specific is the claimed identity) with *state* (how much do we trust it yet), which this
design already tracks separately as `state`. A row can be `identity_scope='exact_variant',
state='discovered'` — "we believe this is the 2015/750ml bottle, we haven't verified it
yet" — without needing a fifth combined value. This is a simplification from the
blueprint's sketch, named rather than silently diverged from.

### 5.3 Storage: content-addressed, one private bucket regardless of licence tier

**Round-3 correction: this section originally split storage into a public
`wine-images-cleared` bucket (for `commercial_use_allowed=true` sources) and a private
`wine-images-uncleared` bucket (for everything else), reasoning that public serving was
fine wherever the licence allowed redistribution.** That was internally inconsistent with
§4.4, which defers the CC-BY-SA/ODbL-DbCL question specifically on the premise that images
"are served inside the authenticated app" — untrue for anything in a public bucket, which
is reachable by anyone with the URL, unauthenticated, forever. Rather than let the
architecture silently resolve an open legal question in the more-exposed direction, this
design now uses **one bucket, private, for every `wine_images` row regardless of licence
tier**:

```sql
-- 0115_wine_images_storage.sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('wine-images', 'wine-images', false, 15728640, array['image/jpeg','image/png','image/webp']);

-- Private for every row, regardless of license_id/commercial_use_allowed --
-- see design doc §4.4/§5.3 for why the earlier public/private split was
-- withdrawn: it made §4.4's "served inside the authenticated app" premise
-- false for exactly the sources whose ShareAlike/attribution obligations
-- make that premise load-bearing. Gated to ANY authenticated user --
-- deliberately NOT restaurant-folder-scoped like invoice-images
-- (0009_invoice_image_storage.sql). That bucket's RLS keys on
-- (storage.foldername(name))[1] being the uploading restaurant, because
-- invoice images are one tenant's private document. Wine images are
-- shared identity content by design (§2) -- gating them per-restaurant
-- here would silently break the entire "one cached asset serves every
-- tenant" property for exactly the images that most need a fallback (the
-- tail wines DDGS had to find).
create policy "authenticated can read wine images"
  on storage.objects for select to authenticated
  using (bucket_id = 'wine-images');

-- No insert/update/delete policy for authenticated: only the service-role
-- enrichment worker writes objects (§8).
```

**The trade-off, named rather than hidden:** this gives up the free CDN-cacheable public
URL that a genuinely CC0/CC-BY-4.0/CC-BY-SA-3.0-cleared image could otherwise be served
from, for every image, including the ones with no real legal question at all. The app
reads via a signed URL (`createSignedUrl`, the same helper `src/adapters/storage/
supabase-storage.ts` already exposes) or an authenticated pass-through route, not a bare
public URL. **Production migration path, not a rewrite:** reintroducing a second, public
bucket for a specific `license_id` is a one-time data-move (copy the affected rows'
objects, flip `wine_images.storage_bucket` for those rows) once — and only once — the
attribution-delivery question §4.4 now names accurately is actually settled (e.g.
attribution embedded in the file's own metadata, so the credit travels with the bytes no
matter how they're accessed). Nothing about `wine_images`'s schema blocks that later split;
it is deferred, not designed away.

**Path convention:** `{sha256}/original.{ext}` and `{sha256}/{px}.webp`, content-addressed,
never `{canonical_wine_id}/...`. Two direct consequences: (1) the same external asset
re-discovered by two different jobs (e.g. two restaurants' imports both miss locally and
both hit DDGS, landing on the same retailer photo) uploads once, not twice — `sha256` on
the row plus a storage existence check before upload is free deduplication; (2)
`merge_canonical_wines` (§9) repointing a row's `canonical_wine_id` never touches storage
at all — it is a pure metadata `UPDATE`.

**Derivatives as JSONB, not a table — the explicit prototype/production trade-off.**
`wine_images.derivatives` holds `[{ "px": 160, "storage_path": "...", "width":..., "height":..., "byte_size":... }, ...]`.
This is a **prototype-grade choice**, made because every derivative for a row is always
generated together (accept → resize → done) and the only read pattern is "give me the best
derivative ≤N px for this image," which application code does once per row without a SQL
predicate on derivative shape. **Production migration path, additive, no data loss:** the
day a real query needs to filter on derivatives directly (e.g. "which images are missing a
320px webp," a backfill/consistency query), add `image_derivatives(image_id, px,
storage_path, width, height, byte_size)` and backfill it by unnesting the existing jsonb
arrays — a single `INSERT ... SELECT ... jsonb_to_recordset(...)` migration, not a rewrite.

## 6. Source and licence registries

```sql
-- 0112_image_licenses.sql
create table public.image_licenses (
  id                      text        primary key,
  name                    text        not null,
  spdx_or_reference       text,
  source_url              text,
  requires_attribution    boolean     not null,
  share_alike             boolean     not null default false,
  commercial_use_allowed  boolean     not null,
  notes                   text,
  created_at              timestamptz not null default now()
);

comment on table public.image_licenses is
  'Small, business-maintained registry of licence terms actually in use. '
  'Deliberately NOT a CHECK-constraint enum on wine_images: clearing a new '
  'licence/source is a legal fact, not a schema change, and gating it '
  'behind a migration would slow down a decision unrelated to code.';

alter table public.image_licenses enable row level security;
create policy "anyone authenticated can read image_licenses"
  on public.image_licenses for select to authenticated using (true);
-- No insert/update/delete policy for authenticated: a legal-status claim
-- must never be insertable by an ordinary authenticated request.
grant select on table public.image_licenses to authenticated;

insert into public.image_licenses
  (id, name, spdx_or_reference, source_url, requires_attribution, share_alike, commercial_use_allowed, notes)
values
  ('packager-cc-by-4.0-scraped-content', 'Packager-asserted CC BY 4.0 over scraped retailer photography', 'CC-BY-4.0 (contested)',
   'https://huggingface.co/datasets/cipher982/wine-images-126k', true, false, false,
   'Wine Images 126K. Re-verified 2026-08-23 by reading the full dataset card, not just its badge: the card itself states the CC BY 4.0 grant covers "this dataset compilation, stable ID system, and organized structure," and separately instructs users to "respect the intellectual property rights of the original wine bottle photography and retailer content" (the images were scraped "for research purposes under fair use"). A packager cannot grant a licence over content it does not own. commercial_use_allowed=false pending an explicit decision -- see design doc §3.1. Flip to true only if Devin/legal accepts the compilation argument for the underlying pixels, not just the metadata.'),
  ('odbl-dbcl-1.0', 'Open Database License / Database Contents License 1.0', 'ODbL-1.0 / DbCL-1.0',
   'https://opendatacommons.org/licenses/dbcl/1.0/', true, true, true,
   'X-Wines. The GitHub repo LICENSE file is genuine CC0-1.0 (verified by fetching it directly), but the Kaggle page hosting the Slim archive actually used -- the exact URL cited by the parent blueprint and this design -- declares this licence in its own listing, verified 2026-08-23. The two channels conflict and are not reconciled anywhere in either listing; per instruction, the more restrictive one governs (share-alike + attribution) until resolved. See design doc §3.2.'),
  ('cc-by-sa-3.0', 'Creative Commons Attribution-ShareAlike 3.0', 'CC-BY-SA-3.0',
   'https://creativecommons.org/licenses/by-sa/3.0/deed.en', true, true, true,
   'Open Food Facts product photos. Verified directly, 2026-08-23: https://world.openfoodfacts.org/legal. 3.0, not 4.0 -- see design doc §4.4 for the share-alike nuance.'),
  ('cc-by-nc-nd-4.0', 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0', 'CC-BY-NC-ND-4.0',
   'https://creativecommons.org/licenses/by-nc-nd/4.0/', true, false, false,
   'WineSensed / "Learning to Taste". RULED OUT for a commercial product. Row exists so an accidental future import is REJECTED by commercial_use_allowed=false, not silently accepted.'),
  ('internal-asset', 'Terroir-owned asset', null, null, false, false, true,
   '3D renders Terroir creates itself; tenant-uploaded photos the tenant has rights to. No external attribution owed.'),
  ('unrated-web-source', 'Unrated web-discovered image', null, null, true, false, false,
   'DDGS or any future paid web-image-search result. The original page/photographer owns the copyright; Terroir has not cleared it. See design doc §4.5/§14.1.')
on conflict (id) do nothing;
```

```sql
-- 0113_image_sources.sql
create table public.image_sources (
  id                 text        primary key,
  display_name       text        not null,
  adapter_kind       text        not null check (adapter_kind in ('bulk_dataset', 'web_search', 'live_vendor_api', 'internal')),
  default_license_id text        not null references public.image_licenses(id),
  enabled            boolean     not null default false,
  requires_approval  boolean     not null default false,
  approval_note      text,
  rate_limit_per_min integer,
  config             jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on column public.image_sources.enabled is
  'Flipping a source on/off is a data change, not a code change -- this '
  'IS the "anything else is a flag, not a decision" mechanism for §3''s '
  'unapproved sources.';

create trigger image_sources_set_updated_at
  before update on public.image_sources
  for each row execute function public.set_updated_at();

alter table public.image_sources enable row level security;
create policy "anyone authenticated can read image_sources"
  on public.image_sources for select to authenticated using (true);
grant select on table public.image_sources to authenticated;

insert into public.image_sources
  (id, display_name, adapter_kind, default_license_id, enabled, requires_approval, approval_note, rate_limit_per_min, config)
values
  ('wine_images_126k', 'Wine Images 126K (HuggingFace)', 'bulk_dataset', 'packager-cc-by-4.0-scraped-content', true, true,
   'Enabled for the fast local join (no network dependency, no cost) but its commercial_use_allowed=false by default -- see design doc §3.1. requires_approval marks the licence decision, not a cost decision: flip commercial_use_allowed on the licence row once Devin/legal decides, no code change needed.', null,
   '{"dataset": "cipher982/wine-images-126k", "join_key": "wine_name"}'),
  ('x_wines', 'X-Wines', 'bulk_dataset', 'odbl-dbcl-1.0', true, false,
   'Governed by ODbL/DbCL per the Kaggle listing for the archive actually used, pending resolution of the GitHub/Kaggle conflict -- see design doc §3.2.', null,
   '{"repo": "rogerioxavier/X-Wines", "join_key": "WineID"}'),
  ('open_food_facts', 'Open Food Facts (barcode-keyed bulk dump)', 'bulk_dataset', 'cc-by-sa-3.0', true, false, null, null,
   '{"join_key": "barcode_gtin"}'),
  ('ddgs_web_search', 'Free web image metasearch (DDGS)', 'web_search', 'unrated-web-source', true, false,
   'Free, no API key. Legal status of returned images is uncleared -- see design doc §4.5/§14.1.', 20, '{}'),
  ('brave_image_search', 'Brave Image Search API', 'web_search', 'unrated-web-source', false, true,
   'NOT on the approved metered-API list. $5/1,000 requests after a $5/mo free credit. Needs explicit approval before enabling.', null, '{}'),
  ('serpapi_google_images', 'SerpApi Google Images', 'web_search', 'unrated-web-source', false, true,
   'NOT on the approved metered-API list. 250 free searches/mo, then $275/mo for 30,000. Needs explicit approval before enabling.', null, '{}'),
  ('invintory_partner_api', 'InVintory Partner API', 'live_vendor_api', 'unrated-web-source', false, true,
   'Vendor catalogue/recognition API. Pricing and licence terms unpublished -- needs a business agreement and sandbox access before this row can be enabled.', null, '{}'),
  ('terroir_render', 'Terroir-generated 3D bottle render', 'internal', 'internal-asset', false, false,
   'Reserved id for the future 3D render pipeline -- see §11. Not built by this piece.', null, '{}'),
  ('tenant_upload', 'Tenant-supplied photo', 'internal', 'internal-asset', true, false, null, null, '{}')
on conflict (id) do nothing;
```

**What these two migrations do NOT cover:** they do not build the InVintory sandbox
integration, the Brave/SerpApi adapters, or any admin UI for editing these rows — flipping
`enabled`/inserting a newly-cleared licence is a manual `UPDATE`/`INSERT` today, an admin
surface is a later, separate, and much smaller piece of work if wanted.

## 7. Adapters, fixtures, fallback, observability

### 7.1 The interface every source implements

```ts
// src/adapters/image-sources/types.ts
export interface ImageSearchQuery {
  producerNorm: string;
  cuveeNorm: string;
  vintage: number | null;   // null = NV, matching the DB convention
  sizeMl: number | null;
  gtin?: string | null;
}

export interface ImageCandidate {
  externalId: string;
  retrievalUrl: string;
  sourcePageUrl: string | null;
  width?: number;
  height?: number;
  licenseId: string;         // usually image_sources.default_license_id, but a
                              // per-item override is legal (e.g. a future paid
                              // API that reports per-photo rights)
  attributionText: string;
  raw: unknown;               // adapter-specific payload for scoring, never persisted verbatim
}

export interface ImageSourceAdapter {
  sourceId: string;           // must match image_sources.id
  search(query: ImageSearchQuery): Promise<ImageCandidate[]>;
}
```

Every adapter's raw response is Zod-validated at the boundary before becoming an
`ImageCandidate[]` (the repo's own "Validate at boundaries" rule) — a malformed or
schema-drifted response is treated exactly like zero results, never partially trusted.

### 7.2 One adapter per source, one offline fixture per adapter

| Adapter | Fixture strategy | Failure modes modeled |
|---|---|---|
| `WineImages126kAdapter` | Local index built from a small committed sample slice (a few dozen rows spanning famous + obscure names), not the full 6 GB dataset. | Index/table missing → `ImageSourceUnavailableError`, treated as zero candidates. |
| `XWinesAdapter` | Same pattern, small committed slice. | Same. |
| `OpenFoodFactsAdapter` | Same pattern, keyed by a handful of real barcodes. | Same, plus "barcode not in dataset" (the common case, not an error). |
| `DdgsWebSearchAdapter` | Canned JSON fixtures keyed by exact query string: one hit case, one empty-results case, one HTTP-429 case, one malformed-JSON case, one timeout case. | All five are exercised by the fault-injection tests in §12. |

Every adapter test runs fully offline against its fixture — no network access required to
run the suite, satisfying the standing "adapter, fixture, fallback, observability" rule for
each of the four enabled sources plus the three disabled ones (which need no adapter code
at all yet — `enabled=false` means the enrichment loop never calls them, per §8).

### 7.3 Fallback behaviour per failure class

- **Local bulk-dataset adapter unavailable** (index/extension missing): logged, treated as
  zero candidates, enrichment proceeds to the next source in rank order. This can only
  happen from an operator/infra error (the data was never loaded), not from anything a
  request can trigger.
- **DDGS rate-limited (HTTP 429 or the library's own throttle exception):** recorded
  `outcome='rate_limited'` in `enrichment_source_attempts` (§7.4), the **job** — not just
  the request — is bumped via `run_after` using the existing `BASE_BACKOFF_MS`/
  `MAX_BACKOFF_MS` exponential backoff already defined for `invoice_extract`
  (`src/lib/jobs/constants.ts`), and re-queued rather than hot-looped.
- **DDGS timeout:** recorded `outcome='timeout'`, same backoff-and-requeue behaviour.
- **DDGS returns a malformed/unexpected shape:** Zod validation fails, recorded
  `outcome='invalid_response'`, treated as zero candidates (never partially parsed into a
  garbage `wine_images` row).
- **All sources exhausted, zero candidates found:** the job completes **successfully**
  (`status='succeeded'`, `result->>'candidates_found' = '0'`) — "no picture exists yet" is
  not the same failure class as "a dependency broke," and conflating them would corrupt an
  operator's "% wines still missing an image" coverage metric. No `wine_images` row is
  created. The display-resolution layer (§8.4) is responsible for the neutral placeholder;
  the database's fallback is "return nothing, honestly."

### 7.4 Observability

```sql
-- 0116_enrichment_source_attempts.sql
create table public.enrichment_source_attempts (
  id              uuid        primary key default gen_random_uuid(),
  job_id          uuid        not null references public.background_jobs(id) on delete cascade,
  source_id       text        not null references public.image_sources(id),
  attempted_at    timestamptz not null default now(),
  outcome         text        not null check (outcome in (
    'success', 'no_candidates', 'rate_limited', 'timeout', 'bot_blocked', 'invalid_response', 'error'
  )),
  http_status     int,
  latency_ms      int,
  candidate_count int         not null default 0,
  error_message   text,
  created_at      timestamptz not null default now()
);

create index enrichment_source_attempts_job_id_idx on public.enrichment_source_attempts (job_id);
create index enrichment_source_attempts_source_outcome_idx
  on public.enrichment_source_attempts (source_id, outcome, attempted_at desc);

alter table public.enrichment_source_attempts enable row level security;
create policy "anyone authenticated can read enrichment_source_attempts"
  on public.enrichment_source_attempts for select to authenticated using (true);
grant select on table public.enrichment_source_attempts to authenticated;
-- No insert policy for authenticated: written only by the service-role
-- enrichment worker, same posture as wine_images.
```

One row per source attempted, per job, always — success or failure. This is what makes
"how often is DDGS timing out" and "p50/p95 latency per source" answerable with a plain
`GROUP BY source_id, outcome` query, independent of whatever the job's own terminal status
ends up being.

**What this migration does NOT cover:** it does not build an operator dashboard against
this table — that's a UI piece, this is the data it would query.

## 8. Job architecture and the two-tier enrichment algorithm

### 8.1 `wine_enrichment` is already claimed — by an abandoned deployment, not a reservation

**This is a correction to the original design, not a refinement of it.** I originally read
`'wine_enrichment'` sitting unused in `background_jobs.job_type`'s CHECK constraint since
**0052**, plus 0075's own down-migration rehearsal using a control row of exactly
`job_type='wine_enrichment'`, and concluded the original schema author had reserved that
value for this piece — "completing a reservation, not inventing one." That conclusion was
built on checking only `invoice_extract`'s own Railway worker (confirmed not deployed
anywhere) and generalizing "no worker exists" from one data point. I never checked whether
`wine_enrichment` itself had a claimant. It does.

**Verified directly, 2026-08-22 per the runbook's own record:** `docs/runbooks/invoice-
extract-worker.md`'s "Railway deployment" section states the `terroir-worker` service
(project `industrious-courtesy`) has **zero deployments in production**, but **staging has
one active deployment** — from `integration/ter-020d25-on-d22`, an old branch abandoned
before merging to `main` (it doesn't share `main`'s migration history; its `0084_*`
migration doesn't fit `main`'s current sequence). That deployment's `pnpm worker` runs a
**generic multi-job-type framework** (`src/worker/{handlers,runtime,supabase-job-
store}.ts` — code that exists only on that abandoned branch, not on `main`) which claims
and processes exactly two job types today: **`wine_enrichment` and `wine_list_pdf`**. Not
`invoice_extract`.

**The consequence, stated plainly:** the first `job_type='wine_enrichment'` row enqueued
anywhere but a fully local stack is not landing in an empty, reserved slot — it risks
being claimed within seconds by unmaintained code nobody owns, running against a schema
that predates `canonical_wines`, `wine_variants`, and everything this piece builds. That
code cannot know about `wine_images`; at best it fails the job with a nonsensical error, at
worst it marks it "succeeded" having done nothing, and either way the job this design
actually needs processed is gone, consumed by a handler with no path back to retry it
under the right code.

**Fix: mint a new, verified-unclaimed job type instead of reusing the tainted one.** The
runbook's own list of what that abandoned framework claims is exact and closed —
`wine_enrichment` and `wine_list_pdf`, nothing else. This design's job type is
**`wine_image_enrichment`**, which collides with neither. `background_jobs.job_type`'s
existing CHECK constraint gains this one new value, via the same mechanical pattern 0075
already used to add `'invoice_extract'` — `'wine_enrichment'` is left exactly where it is
in the constraint (untouched, unused by this design, still a live landmine for anyone who
reaches for it next without reading this section first).

`background_jobs.restaurant_id` still needs the same real change regardless of the job
type's name: it is currently `not null`, and a `wine_image_enrichment` job's true subject
(`canonical_wine_id`) is global, not tenant-scoped — exactly the same shape problem
`identity_merge_log` already solved for canonical-level merges (`restaurant_id null ⇒
is_member(null) is false ⇒ invisible to every tenant's RLS, visible only to service_role`).
This design applies the identical, already-established idiom rather than inventing a new
one:

```sql
-- 0117_wine_image_enrichment_jobs.sql (part 1 of 4)
alter table public.background_jobs alter column restaurant_id drop not null;
alter table public.background_jobs
  drop constraint background_jobs_job_type_check;
alter table public.background_jobs
  add constraint background_jobs_job_type_check check (
    job_type in (
      'invoice_ocr', 'wine_enrichment', 'wine_list_pdf', 'cellar_health',
      'pricing_recommendations', 'invoice_extract', 'wine_image_enrichment'
    )
  );
alter table public.background_jobs
  add constraint background_jobs_global_only_for_enrichment
  check (restaurant_id is not null or job_type = 'wine_image_enrichment');
```

This is a scoped exception, not a blanket weakening: every other existing `job_type` keeps
its `NOT NULL` obligation enforced by the same constraint. The `down` file for this
migration must delete every `job_type='wine_image_enrichment'` row before restoring the
bare `NOT NULL` and the prior job-type vocabulary (a `wine_image_enrichment` row with a
null `restaurant_id` cannot exist under the restored constraint) — the identical
"deliberate, destructive rollback, not an oversight" policy 0075's own down-migration
already documents and rehearses for its own vocabulary additions. The down file does not,
and should not, remove `'wine_enrichment'` from the vocabulary — that value belongs to the
abandoned deployment's own (unrelated, unmanaged) rows, if any exist in whatever
environment this runs against, and is not this migration's to clean up.

### 8.2 Enqueue, claim, reclaim — mirroring 0075's shape exactly

```sql
-- 0117_wine_image_enrichment_jobs.sql (part 2 of 4) -- enqueue
create or replace function public.enqueue_wine_image_enrichment_job(
  p_restaurant_id     uuid,
  p_canonical_wine_id uuid,
  p_vintage           int,
  p_size_ml           int,
  p_role              text default 'bottle_full',
  p_max_attempts      int default 5
)
returns table (job_id uuid, created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_idempotency_key text;
  v_job_id          uuid;
begin
  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception 'forbidden: staff role required at the triggering restaurant';
  end if;

  if not exists (select 1 from public.canonical_wines where id = p_canonical_wine_id) then
    raise exception 'canonical_wine_not_found: %', p_canonical_wine_id;
  end if;

  -- Round-3 fix (Finding B). The two checks above verify WHO is calling
  -- (staff at p_restaurant_id) and THAT the identity exists at all -- they
  -- never verified WHAT the caller is claiming about their own data: that
  -- p_restaurant_id actually holds a wine_variants row for this exact
  -- (canonical_wine_id, vintage, size_ml). Without this, any staff member
  -- at any restaurant could enqueue enrichment against a vintage/size
  -- tuple belonging only to a different, uninvolved tenant -- and because
  -- wine_images is deliberately global (§2), the resulting row would be
  -- visible to that tenant too. Same shape as P2's C01/C05/C06: a caller
  -- identity check with no claim check. p_vintage/p_size_ml being null
  -- (a base_wine- or exact_vintage-scope request) relaxes the match on
  -- that field only -- the caller must still hold SOME wine_variants row
  -- for this canonical_wine_id, and if it names a vintage/size, must hold
  -- a row matching that exact field.
  if not exists (
    select 1 from public.wine_variants wv
    where wv.restaurant_id = p_restaurant_id
      and wv.canonical_wine_id = p_canonical_wine_id
      and (p_vintage is null or coalesce(wv.vintage, 0) = coalesce(p_vintage, 0))
      and (p_size_ml is null or wv.size_ml = p_size_ml)
  ) then
    raise exception 'forbidden: restaurant % holds no wine_variants row matching this identity', p_restaurant_id;
  end if;

  v_idempotency_key := p_canonical_wine_id::text || ':' ||
    coalesce(p_vintage::text, 'NV') || ':' || coalesce(p_size_ml::text, 'ANY') || ':' || p_role;

  insert into public.background_jobs (
    restaurant_id, job_type, status, subject_table, subject_id,
    idempotency_key, max_attempts, metadata
  ) values (
    null, 'wine_image_enrichment', 'queued', 'canonical_wines', p_canonical_wine_id,
    v_idempotency_key, p_max_attempts,
    jsonb_build_object(
      'canonical_wine_id', p_canonical_wine_id, 'vintage', p_vintage,
      'size_ml', p_size_ml, 'role', p_role, 'triggering_restaurant_id', p_restaurant_id
    )
  )
  on conflict (job_type, idempotency_key) do nothing
  returning id into v_job_id;

  if v_job_id is not null then
    return query select v_job_id, true;
    return;
  end if;

  select id into v_job_id from public.background_jobs
   where job_type = 'wine_image_enrichment' and idempotency_key = v_idempotency_key;

  return query select v_job_id, false;
end;
$$;

revoke all on function public.enqueue_wine_image_enrichment_job(uuid, uuid, int, int, text, int) from public;
grant execute on function public.enqueue_wine_image_enrichment_job(uuid, uuid, int, int, text, int) to authenticated;
```

`security definer` here is load-bearing for a specific reason: the base `background_jobs`
INSERT policy requires `is_member_with_role(restaurant_id, 'staff')`, which is `false` for
a `null` restaurant_id by construction — an ordinary authenticated INSERT could never
create a `wine_image_enrichment` row at all. This function runs as its (table-owning)
definer, which is exempt from RLS by Postgres's default (no `FORCE ROW LEVEL SECURITY` is
set anywhere in this schema), and does its **own** explicit `is_member_with_role` check on
the *triggering* restaurant in-body — the same pattern `merge_wines` (0100) already uses
for the identical reason. Being staff at some restaurant is necessary but was not, before
round 3, sufficient — the added `wine_variants` ownership check above is what actually
proves the caller's restaurant carries the identity it's asking to enrich, closing Finding
B (verified directly in the negative-case integration test at §15).

The idempotency key (`canonical_wine_id:vintage:size_ml:role`) reuses the **existing**
`background_jobs_idempotency_key_uniq (job_type, idempotency_key)` unique index from 0075
verbatim — no new index needed. This is the literal mechanism behind "query once per
identity": Restaurant A's and Restaurant B's imports of the same real-world wine both call
`enqueue_wine_image_enrichment_job` with the same `canonical_wine_id`; the second call's
INSERT hits the unique index, returns `created=false`, and the existing job's id — zero
duplicate work, verified directly in the "Cross-tenant sharing" integration test at §15 (a pre-existing broken cross-reference to a nonexistent §12.4, corrected here).

```sql
-- 0117_wine_image_enrichment_jobs.sql (part 3 of 4) -- claim + reclaim
create function public.claim_wine_image_enrichment_job(p_worker_id text)
returns setof public.background_jobs
language sql
as $$
  with claimable as (
    select id from public.background_jobs
    where job_type = 'wine_image_enrichment' and status = 'queued' and run_after <= now()
    order by run_after for update skip locked limit 1
  )
  update public.background_jobs b
  set status = 'processing', claimed_at = now(), claimed_by = p_worker_id, started_at = now()
  from claimable where b.id = claimable.id
  returning b.*;
$$;

revoke all on function public.claim_wine_image_enrichment_job(text) from public;
grant execute on function public.claim_wine_image_enrichment_job(text) to service_role;

create function public.reclaim_stuck_wine_image_enrichment_jobs(p_stuck_after_seconds integer)
returns setof public.background_jobs
language sql
as $$
  with stuck as (
    select id from public.background_jobs
    where job_type = 'wine_image_enrichment' and status = 'processing'
      and claimed_at < now() - make_interval(secs => p_stuck_after_seconds)
    for update skip locked
  )
  update public.background_jobs b
  set status = case when b.attempt_count + 1 >= b.max_attempts then 'dead' else 'queued' end,
      attempt_count = b.attempt_count + 1, claimed_at = null, claimed_by = null, run_after = now(),
      finished_at = case when b.attempt_count + 1 >= b.max_attempts then now() else null end,
      error_code = 'stuck_reclaimed',
      error_message = 'Reclaimed: claimed longer than the stuck threshold without completing.'
  from stuck where b.id = stuck.id
  returning b.*;
$$;

revoke all on function public.reclaim_stuck_wine_image_enrichment_jobs(integer) from public;
grant execute on function public.reclaim_stuck_wine_image_enrichment_jobs(integer) to service_role;
```

These two functions are, deliberately, near-byte-identical to `claim_invoice_extract_job`/
`reclaim_stuck_invoice_extract_jobs` (0075) with `job_type` swapped — the docs/runbooks/
invoice-extract-worker.md's own stated philosophy ("Deliberately not a generic job
platform... a future job type... gets its own runner logic; the schema... was designed to
be reusable, the code was not made generic speculatively") is honored exactly, not
reinterpreted. It is also, now, a second reason `wine_image_enrichment` is the right job
type to mint rather than reuse `wine_enrichment`: the abandoned deployment's own claim
logic (§8.1) is an exact-match `job_type = 'wine_enrichment'` query, verified from the
runbook's description of it, not a pattern or a join — a distinct string is a complete
mitigation against the specific, verified threat, not a partial one.

### 8.3 Execution: prototype-grade vs. production, stated honestly

**Verified directly, and corrected from the original design's overgeneralization:** the
`invoice_extract` worker (`src/worker/index.ts`, a standalone long-poll loop, `pnpm run
worker`) exists as code but its Railway deployment (`railway.worker.toml`) is **not
deployed anywhere** — confirmed independently here and already noted by P3
(`2026-08-23-p3-chunked-import.md` §0). The original design generalized this one data
point to "no worker exists" for the whole `terroir-worker` Railway service, which is
false — §8.1 establishes that a *different*, generic, abandoned-branch worker **is**
actively deployed on staging today. §8.1's job-type rename is what actually neutralizes
that risk; this subsection is now purely about which execution model to build for
`wine_image_enrichment` specifically, independent of whatever the abandoned deployment is
doing under its own, now-irrelevant, job-type name. Designing `wine_image_enrichment`
around a *third* persistent worker process (on top of the undeployed `invoice_extract` one
and the abandoned generic one) would add a real, currently-nonexistent piece of maintained
deployed infrastructure, which cuts directly against "prototype speed must be preserved."

**Prototype-grade (this design, day one):** a one-shot script,
`pnpm run enrich:batch [--limit=N]`, built on the exact same `claim`/`processOne`/`reclaim`
primitives as `src/lib/jobs/*`, that claims and runs jobs to exhaustion (empty queue) and
exits — no persistent process, no new Railway service, run manually by an operator
immediately after an import batch/session completes. This requires zero new deployed
infrastructure.

**Production migration path, no rewrite:** deploy the identical claim/process loop as its
own Railway worker (`railway.worker.enrichment.toml`, an exact structural mirror of the
existing `railway.worker.toml`) or wire a Vercel Cron job that invokes a
`POST /api/internal/enrich-batch` route on a schedule. The SQL functions, the adapters, and
the job rows are completely unchanged between these two execution modes — only the process
wrapper differs. This is a genuinely non-trivial infra decision, not a hidden default, and
is named again as an open question in §14.2.

### 8.4 The two-tier algorithm

**Tier 1 — synchronous local-dataset join, no queue, no network.** Immediately after
`resolve_wine_variants_bulk` (P2) resolves a batch of variants, the import-apply path runs
one additional set-based step per unique `(canonical_wine_id, vintage, size_ml)` in the
batch: an indexed lookup against the three pre-downloaded local datasets by
`producer_norm`/`cuvee_norm`/`vintage`/`size_ml` (or `gtin` for Open Food Facts). A hit
inserts a `wine_images` row directly — `state='probable'` on a text-only match, `'verified'`
if an independent OCR pass on the candidate image agrees with the same producer/cuvee text
— entirely within the request that applies the import chunk. This can run for the full
20,000-row file's worth of unique variants in well under a second of DB time (indexed
lookups against three local tables), so it never needs the job queue at all.

**Tier 2 — asynchronous gap-fill via DDGS, queued and rate-limited.** Only the variants
Tier 1 did not resolve get `enqueue_wine_image_enrichment_job` calls. This is the only tier that
touches an external network dependency, and it is exactly the queue/backoff/observability
machinery in §7–§8.2.

This split is the direct, concrete answer to "synchronous, queued, lazy, or batched": **it
is both, deliberately, split by which tier actually has a network dependency** — not a
single uniform choice imposed on every variant regardless of how cheap or expensive
resolving it actually is.

### 8.5 Tier 2 candidate verification and scoring — the gap this round closes

**This subsection did not exist before round 3.** §8.4 gave Tier 1 an explicit acceptance
rule ("`'probable'` on a text-only match, `'verified'` if an independent OCR pass agrees")
but said nothing about what happens to a Tier-2 (DDGS) candidate after
`DdgsWebSearchAdapter.search()` returns it — not whether it gets downloaded, not how (or
whether) it gets scored, not what makes it a hard rejection. The blueprint's own §4E names
exactly this step — "An explicit wrong vintage, different producer, or wrong nonstandard
size is a hard rejection" — as the single most emphasized correctness requirement in the
source document, reinforced by its own adversarial-review row about web search returning
"neighboring vintages, formats, and cuvées on the tail." §12's disposition table recorded
that as "Change made." It wasn't; this closes it.

**Step 1 — bounded download, not a blind accept.** For each Tier-2 job, take the top 3
candidates per deterministic query variant the adapter returns (blueprint §4D's quoted/
unquoted/ASCII-folded query forms — bounding at 3 keeps this cheap and rate-limit-friendly;
scoring is what decides which one wins, not query-result order). Download each candidate's
bytes to a temporary path — not yet a permanent `storage_path` — and run OCR (PaddleOCR,
per the blueprint's own recommendation; naming a library here is non-binding on the
builder, the interface this design cares about is "text extracted from the image," §7.1's
adapter shape doesn't change either way) against the downloaded bytes. Only after OCR does
a candidate get its first `wine_images` row — with `state` already resolved by steps 2–3
below, never left at `'discovered'`. **A Tier-2 job never persists a bare `'discovered'`
row**: that state exists in the enum for a future finer-grained pipeline (e.g. a separately
queued download step at higher scale, not built here), not for this design's synchronous
discover→download→score-within-one-job-attempt execution model.

**Step 2 — the hard-rejection gate, checked before any score is computed.** Extract, from
the OCR text and the candidate's source-page title/metadata together:

- `vintage_agreement`: `'agree'` (the requested vintage year — or, for an NV lookup, an
  explicit NV/non-vintage marker — appears in the extracted text), `'conflict'` (a
  *different* explicit year appears), or `'absent'` (no vintage information found at all).
- `size_agreement`: the same three-way outcome for the requested `size_ml`, mapped against
  the usual ml/format vocabulary (`750ml`, `Magnum`/`1.5L`, etc.).
- `producer_similarity` (0.0–1.0): trigram similarity between `producer_norm` and the best
  producer string the extraction found, reusing `match_lwin`'s own already-tuned producer
  floor (`0007_lwin_matching.sql`, `0.3` — the identical number 0099's own LWIN-corroboration
  gate reuses for the same reason: don't invent a second, uncalibrated threshold for the
  same kind of comparison this codebase already trusts).
- `cuvee_similarity` (0.0–1.0): the same comparison against `cuvee_norm`.

A candidate is **hard-rejected** — `state = 'rejected'`, `rejected_reason` set to exactly
one of `'vintage_conflict'`, `'size_conflict'`, or `'producer_mismatch'` — the moment any
of these hold: `vintage_agreement = 'conflict'`; `size_agreement = 'conflict'`; or
`producer_similarity < 0.3` while the extraction found *some* producer name (never reject
for producer mismatch when OCR simply found no text at all — that's a low-confidence
candidate, handled in step 3, not a conflict). **Low score alone is never a rejection
reason** — only an explicit, detected conflict is. This is deliberate and matches the
blueprint's own distinction: `'unverified'` "retain[s] the best candidate... but do not
index it as recognition truth" — retained, not discarded, for exactly the case where
nothing was strong enough to trust but nothing was positively wrong either. Rejected rows
are kept (not deleted) with their `rejected_reason` populated — audit trail, and the
`sha256`/`retrieval_url` on a rejected row lets a future job skip re-downloading and
re-scoring a URL already known to be a hard reject.

**Step 3 — scoring and state assignment for everything that survives the gate.**

```text
confidence_score =
    0.40 * producer_similarity
  + 0.35 * cuvee_similarity
  + 0.15 * (1.0 if vintage_agreement = 'agree' else 0.5 if vintage_agreement = 'absent' else 0.0)
  + 0.05 * (1.0 if size_agreement    = 'agree' else 0.5 if size_agreement    = 'absent' else 0.0)
  + 0.05 * (1.0 if image_quality_ok  else 0.0)
```

`image_quality_ok` is a minimal floor (both dimensions present and at least 300px on the
short side) — not a taste judgment, just "this isn't a broken or thumbnail-sized fetch."
`agreeing_channel_count` = the number of `{producer_similarity >= 0.8, cuvee_similarity >=
0.8, vintage_agreement = 'agree', size_agreement = 'agree'}` that hold. Every input to this
formula is stored in `score_components` (already a jsonb column, §5.1 — no schema change),
so a future re-scoring pass or a human review can see exactly why a number came out the way
it did, not just the number itself.

State assignment, directly from the blueprint's own thresholds (§4E), applied here for the
first time:

- **`'verified'`**: `confidence_score >= 0.90` **and** `agreeing_channel_count >= 2`. This
  is deliberately harder to reach than the raw score alone — a candidate that scores 0.91
  purely from strong producer/cuvee text similarity but with `vintage_agreement = 'absent'`
  and `size_agreement = 'absent'` does not qualify, because only one channel (cuvee, say)
  actually cleared its 0.8 bar; two independently-confirming signals are required, not one
  strong one.
- **`'probable'`**: `0.70 <= confidence_score < 0.90`, regardless of channel count.
- **`'unverified'`**: `confidence_score < 0.70`. Still stored, still has a real
  `storage_path` (it was downloaded and scored, just not trusted), and — settling the
  question this round's critique named explicitly — **is servable**, but only as the last
  rung before the neutral placeholder: `resolve_wine_images_bulk`'s existing state-rank
  ordering (§10, unchanged) already places `verified` above `probable` above `unverified`,
  so an `'unverified'` row only ever surfaces when nothing stronger exists for that
  scope/role — exactly the blueprint's own cascade (`exact vintage/format image → exact
  vintage image → base-wine label/bottle image → best unverified candidate → neutral
  fallback`). `'unverified'` governs *training/recognition* trust (a future P5 reference
  index should exclude it), never *display* eligibility — those are different questions,
  and conflating them is exactly what this section exists to stop doing implicitly.

**Selection.** Among every non-rejected candidate scored for one job, the highest-
`confidence_score` one is marked `selected = true` (ties broken by earliest
`retrieved_at`); the rest keep `selected = false` and remain queryable alternates —
nothing here changes the `wine_images_selected_scope_idx` partial unique index (§5.1),
since exactly one row per `(canonical_wine_id, vintage, size_ml, role)` still ends up
selected.

**Job outcome, and the distinction from §7.3's "zero candidates" case.** §7.3 already
covers *no source returning anything at all*. This section adds the sibling case —
candidates were returned and scored, but every one was hard-rejected. Both leave nothing
servable, but they are different facts an operator needs told apart: `background_jobs.
result` now carries `candidates_found` (unchanged from §7.3) alongside two new keys,
`accepted_count` and `rejected_count` (both computed from this job's own scoring pass, no
schema change — `result` is already a generic jsonb column). A job with
`candidates_found > 0, accepted_count = 0` succeeded at finding *something* but correctly
trusted none of it — a materially different signal from finding nothing to begin with, and
one worth being able to tell apart in a coverage report.

**Fault tolerance, briefly.** If a job dies after downloading a candidate (`state =
'downloaded'`, real `storage_path`) but before scoring it, the retry (§8.2's existing
backoff/requeue mechanism, unchanged) should look for this job's own `discovered_by_job_id`
rows already sitting in `'downloaded'` before fetching anything new, and score those first
— avoiding a wasted re-download on the identical retry loop this codebase already builds
for every other job type.

**What this section does NOT cover.** It does not build OCR, an embedding model, or any ML
component — PaddleOCR is named because the blueprint does, not because this design commits
a builder to it. It does not specify the exact trigram/similarity SQL call (`pg_trgm`'s
`similarity()`, already an enabled extension per `canonical_wines`' own trigram indexes,
0097, is the obvious reuse, but this is implementation detail, not a schema decision). It
does not change Tier 1's rule (§8.4) at all — Tier 1's local-dataset joins are a different,
lower-risk trust story precisely because the source datasets are pre-vetted bulk
collections, not open web search. And it does not resolve the *licence* question for a
Tier-2 image — a `'verified'`-state DDGS-sourced row is still `license_id =
'unrated-web-source'`, `commercial_use_allowed = false` (§4.5); correctness confidence and
licence clearance are orthogonal axes, and a high `confidence_score` says nothing about
whether Terroir has the right to show the image at all. Both gates apply independently to
every Tier-2 row.

## 9. Merge behaviour — extending `merge_canonical_wines`

0100's own comment on `merge_canonical_wines` is explicit: *"Every future migration adding
an FK to canonical_wines(id)/wine_variants(id) MUST extend this function... AND
supabase/tests/0100_merge_completeness.sql in the same migration."* `wine_images.
canonical_wine_id references canonical_wines(id) on delete restrict` is exactly such an FK.
**RESTRICT, not CASCADE or SET NULL** — matching 0098's own reasoning for
`wine_variants_canonical_wine_id_fkey` verbatim: force an explicit, guarded, logged path
for any identity-table mutation, rather than a silent destroy (CASCADE) or a silent,
unlogged detach (SET NULL, the exact failure class 0098's own header rejected after
testing it).

**Disclosed rather than merely leaned on: `0100_merge_completeness.sql` is a table-name
substring test, not a column-level one — I read the file directly to confirm this rather
than take the citation above on faith.** Its own header says so: it checks that each FK-
referencing table's *name* appears somewhere in `merge_wines`'/`merge_canonical_wines`'
source text, and names its own known blind spot — `wine_aliases` has two FKs into this
identity graph, only one of which anything actually repoints, and the test cannot tell
those cases apart because the table name appears in the source either way. For
`wine_images` specifically this is not a live gap **today** — there is exactly one FK
column (`canonical_wine_id`), so "the table name is mentioned" and "the one FK is handled"
happen to coincide — but the test would keep passing even if a future edit to §9's
function body left the `selected = false` demotion step out, or updated `canonical_wine_id`
on only some rows: it checks for the string `wine_images` in the function source, not that
the repoint is correct. **The actual proof that this design's repoint logic works is the
"Merge repoint correctness" integration test in §15** — it inserts real rows, calls the
real function, and asserts real post-conditions (which row's `canonical_wine_id` changed,
which `selected` flag cleared, what `identity_merge_log` recorded). Cite
`0100_merge_completeness.sql` for "nobody forgot this table exists"; cite §15's test for
"the repoint is actually right."

```sql
-- 0118_merge_canonical_wines_images.sql
create or replace function public.merge_canonical_wines(
  p_source_id uuid,
  p_target_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_source              public.canonical_wines%rowtype;
  v_target              public.canonical_wines%rowtype;
  v_conflict_restaurant uuid;
  v_conflict_vintage    int;
  v_conflict_size_ml    int;
  v_moved_variants      int;
  v_moved_lineages      int;
  v_moved_wines         int;
  v_moved_aliases       int;
  v_deduped_aliases     int;
  v_moved_wine_images   int;
  v_moved_wine_image_ids uuid[];
begin
  -- [unchanged 0100 guard/lock/lookup logic through the variant_conflict
  --  check -- reproduced verbatim, omitted here for brevity in this
  --  design doc; the real migration file carries the FULL body, not a
  --  diff, per the down-migration note below.]

  update public.wine_variants set canonical_wine_id = p_target_id where canonical_wine_id = p_source_id;
  get diagnostics v_moved_variants = row_count;

  update public.wine_lineages set canonical_wine_id = p_target_id where canonical_wine_id = p_source_id;
  get diagnostics v_moved_lineages = row_count;

  update public.wines set canonical_wine_id = p_target_id where canonical_wine_id = p_source_id;
  get diagnostics v_moved_wines = row_count;

  delete from public.wine_aliases s
   where s.canonical_wine_id = p_source_id
     and exists (select 1 from public.wine_aliases t
                  where t.canonical_wine_id = p_target_id
                    and t.raw_producer is not distinct from s.raw_producer
                    and t.raw_cuvee is not distinct from s.raw_cuvee);
  get diagnostics v_deduped_aliases = row_count;

  update public.wine_aliases set canonical_wine_id = p_target_id where canonical_wine_id = p_source_id;
  get diagnostics v_moved_aliases = row_count;

  -- P4 addition. Clear `selected` on every source image BEFORE repointing:
  -- wine_images_selected_scope_idx is a unique index on (canonical_wine_id,
  -- vintage, size_ml, role) where selected=true, so a blind repoint while
  -- the target already holds a selected image for the same (vintage,
  -- size_ml, role) would raise 23505 mid-merge. Clearing first means the
  -- target's own pre-existing selection is NEVER touched (an operator who
  -- already vetted the target's image keeps it), and the source's images
  -- survive as demoted, unselected alternates -- not deleted, not
  -- promoted, available for a later re-review. See design doc §9 for the
  -- named, unresolved question this default answers only for the common
  -- case.
  update public.wine_images set selected = false where canonical_wine_id = p_source_id;

  select array_agg(id) into v_moved_wine_image_ids
  from public.wine_images where canonical_wine_id = p_source_id;

  update public.wine_images set canonical_wine_id = p_target_id where canonical_wine_id = p_source_id;
  get diagnostics v_moved_wine_images = row_count;

  insert into public.identity_merge_log (
    merge_type, source_id, target_id, restaurant_id, source_snapshot, moved_counts, merged_by
  ) values (
    'canonical_wine', p_source_id, p_target_id, null,
    to_jsonb(v_source),
    jsonb_build_object(
      'moved_wine_variants', v_moved_variants, 'moved_wine_lineages', v_moved_lineages,
      'moved_wines', v_moved_wines, 'moved_wine_aliases', v_moved_aliases,
      'deduped_wine_aliases', v_deduped_aliases,
      'moved_wine_images', v_moved_wine_images,
      'moved_wine_image_ids', to_jsonb(coalesce(v_moved_wine_image_ids, array[]::uuid[]))
    ),
    auth.uid()
  );

  delete from public.canonical_wines where id = p_source_id;

  return jsonb_build_object(
    'target_id', p_target_id, 'moved_wine_variants', v_moved_variants,
    'moved_wine_lineages', v_moved_lineages, 'moved_wines', v_moved_wines,
    'moved_wine_aliases', v_moved_aliases, 'deduped_wine_aliases', v_deduped_aliases,
    'moved_wine_images', v_moved_wine_images
  );
end;
$$;
```

`moved_wine_image_ids` is carried in `moved_counts` (not a new `identity_merge_log`
column) specifically so a later audit can answer "which exact images moved" even after the
source row's `canonical_wine_id` no longer exists to query against directly — the count
alone would not support that.

**The question this migration answers only for the common case, named rather than
resolved:** `merge_canonical_wines`'s own purpose (0100's header) is fixing accidental
duplicate rows of the **same** real-world wine — the common, safe case, where preserving
the target's `verified`/`selected` state and demoting the source's is exactly right. It is
also possible, though rarer, that a merge is called because the source was **misidentified**
(pointed at the wrong real wine, not merely a duplicate spelling of the right one) — in
that case, images repointed from a misidentified source could carry over pictures of an
actually-different wine, silently. This design does not attempt to distinguish the two
cases (the function has no `p_reason` parameter and no way to know which is true), and does
not downgrade `state` defensively on every merge, because doing so would degrade the common
case for no benefit. This is carried forward as an open question (§14.2), not silently
decided.

**What this migration does NOT cover:** it does not touch `merge_wines` (§2.2 explains
why it needs no changes). It does not repoint `background_jobs`/`enrichment_source_
attempts` rows whose `metadata->>'canonical_wine_id'` names the now-deleted source — those
are historical audit facts ("this attempt fired against wine X before the merge"), not
live references (no FK), and are left as-is deliberately, the same posture
`identity_merge_log` itself already takes toward its own `source_snapshot`.

**Down-migration note:** the down file for 0118 must restore 0100's **exact prior**
`merge_canonical_wines` body (a full `create or replace function`, not a `drop function`)
— dropping it would break anything depending on the function existing, including
`supabase/tests/0100_merge_completeness.sql`. This mirrors how 0098/0100's own function-
replacement chain already treats continuity.

## 10. Serving: `resolve_wine_images_bulk`

```sql
-- 0119_resolve_wine_images_bulk.sql
create or replace function public.resolve_wine_images_bulk(p_lookups jsonb)
returns table (
  idx              int,
  image_id         uuid,
  role             text,
  identity_scope   text,
  state            text,
  storage_bucket   text,
  storage_path     text,
  derivatives      jsonb,
  license_id       text,
  attribution_text text,
  license_url      text
)
language sql
security invoker
stable
set search_path = public
as $$
  with input as (
    select x.idx, x.canonical_wine_id, x.vintage, x.size_ml, x.role
    from jsonb_to_recordset(p_lookups) as x(
      idx int, canonical_wine_id uuid, vintage int, size_ml int, role text
    )
  ),
  ranked as (
    select
      i.idx, wi.*,
      case wi.identity_scope
        when 'exact_variant' then 0 when 'exact_vintage' then 1 else 2 end as scope_rank,
      -- Only verified/probable/unverified can reach this join at all (see
      -- the WHERE clause below) -- discovered/downloaded/rejected rows
      -- are excluded before ranking ever runs, not merely ranked last.
      case wi.state
        when 'verified' then 0 when 'probable' then 1 when 'unverified' then 2
        else 9 end as state_rank,
      case when wi.selected then 0 else 1 end as selected_rank
    from input i
    join public.wine_images wi
      on wi.canonical_wine_id = i.canonical_wine_id
     and wi.role = i.role
     -- Round-3 fix (Finding A): the original filter was `state <> 'rejected'`,
     -- which left `discovered`/`downloaded` rows -- never scored, and for
     -- `discovered` specifically never even downloaded -- structurally
     -- eligible to be returned as "the" image, handing the caller a NULL
     -- storage_path. A candidate is only servable once §8.5's scoring pass
     -- has actually assigned it one of these three states, and only ever
     -- with real cached bytes behind it -- never hotlinked, per §0/blueprint
     -- §4F. storage_path is not null is defense in depth: state alone
     -- should already guarantee this, but a state that could ever exist
     -- without a real path is exactly the shape of bug this guards against.
     and wi.state in ('verified', 'probable', 'unverified')
     and wi.storage_path is not null
     and (
       wi.identity_scope = 'base_wine'
       or (wi.identity_scope = 'exact_vintage' and wi.vintage is not distinct from i.vintage)
       or (wi.identity_scope = 'exact_variant' and wi.vintage is not distinct from i.vintage and wi.size_ml = i.size_ml)
     )
  )
  select distinct on (idx)
    idx, id, role, identity_scope, state, storage_bucket, storage_path, derivatives,
    license_id, attribution_text, license_url
  from ranked
  order by idx, selected_rank, scope_rank, state_rank, created_at desc;
$$;

revoke all on function public.resolve_wine_images_bulk(jsonb) from public;
grant execute on function public.resolve_wine_images_bulk(jsonb) to authenticated;
```

One call resolves an entire search-results page (batched, set-based — the same C10
discipline `resolve_wine_variants_bulk` established: no per-row RPC round trip for a page
of 20–50 results). A lookup with no matching row returns no row for that `idx`; the caller
renders the neutral placeholder, matching §7.3's stated fallback. `vintage is not distinct
from` makes an NV lookup (`vintage=null`) correctly match only NV-specific or base-wine
images, never an arbitrary vintage-specific one.

**What this migration does NOT cover:** it does not change `wines.hero_image_url` or any
existing search route — wiring the search API to call this function is application code,
out of scope here. `hero_image_url` is left untouched; a resolver can prefer `wine_images`
with a fallback to `hero_image_url` during transition, and the column's deprecation
timeline is an open question (§14.2), not decided by this migration.

## 11. Scale: what happens at 20,000 bottles

**Correction: the unique-variant count is not an estimate — it is computable, and I had
the wrong number.** The original design guessed 8,000–14,000 unique variants and flagged
it "unverified." The deterministic partner-cellar fixture (`scripts/fixtures/generate-
partner-cellar.mjs`) is the actual stand-in for the real 20,000-row file until it arrives,
and it hardcodes the answer: `export const TARGET_VARIANT_TOTAL = 4200;`. I ran the
generator directly (`node scripts/fixtures/generate-partner-cellar.mjs`) rather than trust
the constant in isolation — it produced 20,000 rows and printed "Unique variants: 4200,"
confirming the constant is what the fixture actually emits, not just what it declares. The
manifest's `category_summary` gives real (if partial) texture on top of the headline
number: 130 variants tagged `famous`, 586 tagged `long_tail`, 260 `nv`, 90
`adjacent_vintage`, 100 `format_sibling`, 40 `spelling_noise` (these tag deliberately
injected edge cases and don't sum to 4,200 — the remainder is an untagged, ordinary
middle population). This is real, verified texture, not a basis for inventing a more
precise miss-rate estimate than §11's original 30–50% guess; that guess is restated below,
unchanged, because the fixture's category tags say nothing about actual overlap with the
three free datasets — that overlap is still only measurable by running the pilot.

**Every downstream number is redone against 4,200, not the old 8,000–14,000.** This
error was conservative (fewer variants means less real work than originally estimated),
but "conservative" is not the same as "safe to leave uncorrected" — the arithmetic below
replaces the original figures rather than merely noting they were off.

**Tier 1 (local joins, all 4,200 variants):** indexed Postgres lookups against three
local tables, no network I/O. **[ESTIMATE]** Comfortably under a minute of total DB time
for the whole batch — this tier's cost scales with row count times an indexed-lookup
constant, and 4,200 is smaller than the range originally assumed, not larger.

**Tier 2 (DDGS gap-fill, only the misses) — and the parallelism this design actually
supports, reconciled:** the original arithmetic divided by "20 req/min × 5 parallel
workers = 100 req/min," which contradicts §8's own architecture. `image_sources.
rate_limit_per_min` is a single number describing DDGS's *safe throughput for that
source*, not a per-worker allowance — this design has no shared, enforced rate limiter
(no token-bucket table, no distributed counter) that would let multiple concurrent workers
each independently consume 20 req/min without collectively exceeding whatever the real
safe ceiling is. `claim_wine_image_enrichment_job` is safe under concurrent callers
(`FOR UPDATE SKIP LOCKED`), so running multiple copies of the batch script would not
corrupt anything — but without a shared limiter, running five of them would send DDGS
~100 req/min, not the 20 req/min this design has any basis for calling safe. **The
corrected math assumes one worker process (§8.3's batch script, run singly) respecting the
one rate-limit number this design actually has**, and treats a shared limiter as a
named, unbuilt prerequisite for real horizontal scaling on this specific tier, not
something concurrency quietly provides for free:

- 30% miss rate (**[ESTIMATE, unmeasured]**, unchanged from the original guess, now
  applied to the correct 4,200): 1,260 misses × 3 queries ÷ 20 req/min ≈ 189 minutes
  (≈3.2 hours).
- 50% miss rate: 2,100 misses × 3 queries ÷ 20 req/min ≈ 315 minutes (≈5.25 hours).

These are both longer than the original (wrong) 90–150 minute figures, which were inflated
by the uncorroborated ×5. This is the honest number for a single-worker prototype: a
multi-hour background fill, not a sub-two-hour one. It remains a background fill, not a
blocking wait — the import itself completes immediately via Tier 1 plus P3's chunked
apply, and search already renders Tier 1's finds plus neutral placeholders the moment the
import completes. **Getting meaningfully faster than this on Tier 2 specifically requires
building the shared rate-limiter this design does not build** — named here as a concrete,
scoped follow-on rather than assumed away by an uncosted "add more workers."

**Storage:** at ~150 KB average per cached original (a reasonable label/bottle photo) plus
four WebP derivatives (~15 KB combined) per selected image, 4,200 variants ≈ 693 MB
(≈0.7 GB) total — smaller than the original (wrong) 2.3 GB estimate, trivial for Supabase
Storage at prototype scale either way, and mostly deduplicated further by the
content-addressed path convention (§5.3) whenever two variants happen to share an
externally-discovered photo.

**What this section does NOT cover:** the unique-variant count (4,200) is now a verified,
deterministic fact of the fixture standing in for the real file — it does not commit to
the 30–50% miss-rate figure as anything but a planning input (§14.1 restates this), and it
does not build the shared rate-limiter Tier 2's faster-than-single-worker path depends on.
The correct next step, unchanged from the blueprint's own Milestone 1, is running the real
500-variant stratified pilot — against the real partner file once available, or this
fixture in the meantime — before trusting the miss-rate figure operationally.

## 12. 3D bottle renders — confirming, not building, the extension point

`asset_class='render_3d'`, `role='render_3d'`, `source_id='terroir_render'`,
`license_id='internal-asset'` are already reserved in the seed data (§6). A render row
would leave `width`/`height`/`sha256`/`ocr_text`/`phash` null (all already nullable) and
`storage_path` pointing at a `.glb`/`.gltf` file instead of an image — `mime_type` already
holds arbitrary text (`'model/gltf-binary'` is a legal value today with no schema change).
**The one column a real 3D pipeline would likely want that this design does not add:** a
`model_format`/parameter-set field for the template-library approach the blueprint sketches
(§8 of the blueprint: Bordeaux/Burgundy/Champagne geometries, glass colour, label
placement). Adding it later is a single additive `ALTER TABLE ... ADD COLUMN`, not a
rewrite — named here so nobody mistakes "not built" for "not accounted for."

## 13. Migration set (0112–0119)

| # | file | one line | does NOT cover |
|---|---|---|---|
| 0112 | `image_licenses.sql` | Licence registry table + 6 seed rows (§6). | An admin UI for adding licences; InVintory's actual terms. |
| 0113 | `image_sources.sql` | Source/adapter registry + 9 seed rows, 3 disabled pending approval (§6). | The Brave/SerpApi/InVintory adapter code itself. |
| 0114 | `wine_images.sql` | Core table, scope/attribution triggers, RLS, indexes (§5.1). | `image_embeddings` (P5); derivative normalization (§5.3 states the path). |
| 0115 | `wine_images_storage.sql` | One private bucket for every licence tier, RLS (§5.3 — round-3 corrected from an earlier two-bucket public/private split). | A rights-clearance workflow to move an image between buckets; reintroducing a public bucket once attribution-delivery (§14.2 Q11) is solved. |
| 0116 | `enrichment_source_attempts.sql` | Per-attempt observability table (§7.4). | An operator dashboard. |
| 0117 | `wine_image_enrichment_jobs.sql` | New `job_type` value `wine_image_enrichment` (NOT the pre-existing, staging-claimed `wine_enrichment` — §8.1), nullable `background_jobs.restaurant_id` for it, `enqueue`/`claim`/`reclaim` functions (§8.1–8.2). | The worker process itself (application code, §8.3); a generic multi-job-type runner (explicitly rejected, §8.2); decommissioning the abandoned staging deployment (infra task, not this migration's). |
| 0118 | `merge_canonical_wines_images.sql` | Extends `merge_canonical_wines` to repoint + demote `wine_images` (§9). | Deciding the misidentified-source case (§14.2 open question); repointing historical job metadata. |
| 0119 | `resolve_wine_images_bulk.sql` | Batched, set-based image resolver for search results (§10). | Wiring it into the actual search API route (application code). |

Every forward migration pairs with `down/NNNN_<name>.down.sql`. None uses `create index
concurrently` (every new index here is on a table this migration itself creates, empty at
creation time). 0117's down file must delete `job_type='wine_image_enrichment'` rows
before restoring the bare `NOT NULL` and the prior job-type vocabulary (leaving the
pre-existing, unrelated `wine_enrichment` value and any rows under it untouched — see
§8.1), mirroring 0075's own documented destructive-rollback policy.
0118's down file must restore 0100's exact prior function body (§9).

## 14. Assumptions and open questions

### 14.1 Assumptions (made because I could not verify them, or chose a reasonable default)

1. **Partly resolved.** The stand-in fixture's unique-variant count — 4,200 out of 20,000
   rows — is now a verified, computed fact (§11: read from `TARGET_VARIANT_TOTAL` in
   `scripts/fixtures/generate-partner-cellar.mjs` and confirmed by actually running the
   generator), replacing the original 8,000–14,000 guess. What remains an assumption is
   that the *real* partner file, once it exists, dedupes at a broadly similar ratio to this
   deliberately-representative synthetic one — the fixture is a stand-in, not a guarantee,
   and only P2/P3's own resolution step run against the real file will produce the real
   number.
2. DDGS's safe practical throughput is roughly 20 requests/minute — unverified, and (per
   §11's round-2 correction) treated as one global ceiling for the source, assumed
   consumed by a single worker process rather than divided or multiplied across concurrent
   workers, since this design builds no shared rate-limiter. The blueprint's own
   recommended 500-query soak test has not been run.
3. The enrichment worker will use a service-role Supabase client, mirroring
   `createServiceRoleClient()` already used by the `invoice_extract` worker — verified that
   pattern exists for the sibling job type, not that an enrichment-specific helper does
   (this design specifies one be created the same way).
4. Producer/cuvee text similarity plus OCR agreement is sufficient for Tier 1's automatic
   `'verified'` state without a human in the loop — inherited from the blueprint's own
   confidence framing, not independently re-derived here, and riskiest for long-tail wines
   where a dataset's own text field might itself be dirty. **Extended, round 3:** §8.5 now
   specifies Tier 2's scoring formula and state thresholds concretely (closing the gap
   round 2 left open), but the specific weights (`0.40`/`0.35`/`0.15`/`0.05`/`0.05`) and
   the `0.90`/`0.70` bands are the blueprint's own numbers and a reasonable prototype-grade
   combination of them, not independently tuned or validated against real DDGS results —
   the same "must be measured on the partner CSV" caveat the blueprint attaches to its own
   thresholds applies here too.
5. `src/lib/jobs/*`'s existing one-module-per-concern shape (`claim.ts`, `enqueue.ts`,
   `reclaim.ts`, `types.ts`, `constants.ts`, `run-once.ts`) is the intended shape for a
   sibling `wine-image-enrichment` module tree — a builder could reasonably choose a
   different file layout; this design does not mandate one beyond following the
   established pattern.
6. **No longer an assumption — verified, and now enforced (see §4.7).** Terroir does have
   a public, unauthenticated menu surface, confirmed by reading `0081_anon_column_scoping.
   sql` directly: it exposes zero image columns today (the anon-readable column sets on
   `wines`/`restaurants` are pinned, and `wine_lists`/`wine_list_sections`/`wine_list_items`
   carry no image field either). This design does not merely rely on that fact holding
   elsewhere — `wine_images` itself grants `select` to `authenticated` only, no anon grant
   at all, and §15 pins that with a `pg_attribute`-scanning test so it cannot regress
   silently. §4.5/§4.6's judgment about `unrated-web-source` images is therefore grounded
   in an enforced constraint, not an unverified assumption about how other tables happen to
   behave today.
7. The job-type mitigation in §8.1 is verified only against the two handlers the runbook
   names for the abandoned staging deployment (`wine_enrichment`, `wine_list_pdf`) — I did
   not check whether any other legacy or abandoned deployment claims a different job-type
   string this design might someday want. The mitigation pattern (verify against the exact
   claim list before minting or reusing a `job_type` value) is the reusable lesson; I am
   assuming it needs to be repeated for any future job type, not that `wine_image_
   enrichment` is the last name this codebase will ever need to check.

### 14.2 Open questions (decisions needed, not mine to make)

1. **Legal:** may Terroir show an `unrated-web-source` image (uncleared rights) to a
   restaurant's own staff inside the authenticated app, before a rights-cleared replacement
   exists? This design stores the truth and lets it render by default (matching "the image
   must always render"), gated behind one flag — the acceptability of that default for a
   commercial product is a legal call. **Narrowed by Q2 below:** the public-redistribution
   half of this risk is now closed by construction (§4.7) — `wine_images` has no anon
   exposure, enforced by a pinning test — so what's actually being asked here is only about
   staff-facing display inside the authenticated app, not about the open internet.
2. ~~Does any Terroir surface publish restaurant wine images to unauthenticated visitors?~~
   **Closed.** Yes — Terroir has a public, unauthenticated surface
   (`wine_lists`/`wine_list_sections`/`wine_list_items` anon-readable, plus the
   `0081`-pinned anon columns on `wines`/`restaurants`), and it was the subject of two
   confirmed audit findings (C05, C06) on exactly this data. It exposes no image column
   today, and `wine_images` is designed so it cannot without a deliberate, reviewed anon
   grant (§4.7) — the pinning test in §15 fails the build the moment that changes. No open
   question remains here.
3. **Brave/SerpApi/InVintory approval.** All three are `enabled=false` with their exact
   published costs in `approval_note` (§6). No decision has been made on my behalf.
4. **Execution model at ship time:** the prototype batch script (§8.3, my default, zero new
   infra) vs. immediately deploying a persistent Railway worker vs. a Vercel Cron trigger.
   A real operational decision, not a hidden default.
5. **Merge-time image trust** (§9): should a merge's repointed images keep their
   `state`/`selected` as-is (this design's default, optimized for the common "same wine,
   cosmetic duplicate" case), or should the DB defensively downgrade them pending re-review
   (safer for the rarer "these were actually different wines" case)? Not decided here.
6. **`wines.hero_image_url` deprecation timeline** — untouched by this design; a resolver
   can prefer `wine_images` with a fallback during transition, but nobody has set a date.
7. **Tenant-uploaded photos** (`tenant_upload` source, §6) — the schema accommodates them
   but this design does not specify the upload API's authorization/moderation flow; a
   separate design pass if wanted.
8. **Wine Images 126K's real commercial-use status (§3.1) — the largest single open
   decision in this design, larger in scope than Q1.** The packager's CC BY 4.0 claim, by
   the dataset card's own words, covers "this dataset compilation, stable ID system, and
   organized structure," not the underlying retailer photography, which was scraped "for
   research purposes under fair use." This design defaults `commercial_use_allowed=false`
   for this source. Is the compilation argument (or an accepted, diffuse exposure across
   ~108,000 images from many retailers) good enough for a commercial product, or does
   Terroir's single largest bulk image source need to be treated as no safer than an
   uncleared web-search hit — shrinking the "safe free tier" this design and the parent
   blueprint both leaned on? Flipping the licence row's `commercial_use_allowed` is a
   one-line data change either way (§6); the decision itself is not mine to make.
9. **Which X-Wines channel governs (§3.2)?** The GitHub repo's `LICENSE` file is genuine
   CC0; the Kaggle page hosting the archive actually used declares ODbL/DbCL; neither
   channel acknowledges the other. This design defaults to the more restrictive reading
   until someone resolves it — by asking the dataset's author, or by deciding the Kaggle
   listing (the channel the bytes actually come from) is authoritative regardless of what
   the GitHub badge says. Not decided here.
10. **The abandoned `terroir-worker` staging deployment (§8.1)** should probably be
    decommissioned or redeployed from `main` as general infrastructure hygiene — this
    design's job-type rename (`wine_image_enrichment`) removes the immediate collision risk
    without requiring that cleanup, but unmaintained code claiming jobs against a live
    (if only staging) Supabase project is a standing risk for whatever else eventually
    reuses `wine_enrichment` or `wine_list_pdf` without reading this document first. Not
    this design's to schedule, but worth someone owning.
11. **Attribution delivery for a publicly-servable image, once one exists (§4.4/§5.3,
    round 3).** Every `wine_images` row is now served only from a private, authenticated
    bucket, so this is not urgent — but `attribution_text` lives in the `wine_images` row,
    not in the image file or the HTTP response, and CC-BY-SA-3.0/ODbL-DbCL's attribution
    term is most load-bearing for exactly the audience a private bucket doesn't reach:
    someone who obtains the bytes without ever seeing Terroir's UI. Before this design (or
    a successor) reintroduces a public bucket for genuinely cleared sources, someone needs
    to decide whether embedding attribution in the file's own metadata, or serving it via a
    header on an authenticated proxy response, is required — not decided here.

## 15. How this gets tested

**Unit (TypeScript, no DB):**

- `image-search-query.test.ts` — asserts every generated DDGS query string for a given
  identity never contains `lwin7`, even when the input record has one set. **Breaks if** a
  future change starts interpolating `lwin7` into a query string, reopening the exact
  D9-adjacent risk §2.3 designs around.
- `licence-rank.test.ts` — given two candidates for the same scope+role, one
  `cc-by-4.0`/`cc0-1.0` and one `unrated-web-source`, asserts the cleared candidate is
  always preferred in the selection ranking. **Breaks if** a ranking change starts
  preferring web-search hits over verified free-dataset hits.
- `identity-scope-shape.test.ts` — table-driven, asserts the app-layer construction of a
  `wine_images` insert rejects any `(identity_scope, vintage, size_ml)` combination the DB
  CHECK (§5.1) would also reject. **Breaks if** application code and the DB constraint
  diverge on what a valid scope shape is.
- `tier2-scoring.test.ts` — table-driven, both directions, exercising §8.5's formula
  directly: (a) an extraction that agrees on producer/cuvee text and the requested
  vintage/size (`vintage_agreement='agree'`, `size_agreement='agree'`, both similarities
  ≥0.8) computes `confidence_score >= 0.90` with `agreeing_channel_count >= 2` and assigns
  `state='verified'`; (b) an extraction with `vintage_agreement='conflict'` (an explicit,
  different year detected) is assigned `state='rejected'`, `rejected_reason=
  'vintage_conflict'`, **regardless of how high producer/cuvee similarity scores** —
  proving the hard-rejection gate runs before scoring, not as a side effect of a low
  number. **Breaks if** a future refactor lets high text similarity override an explicit
  conflict, or the accept case regresses to `probable`/`unverified`.

**Integration (live two-tenant Postgres, `signedInClient()` pattern from
`tenant-isolation.test.ts`, per that file's own MANDATORY header):**

- **Cross-tenant sharing (the core P4 property):** Restaurant A's import resolves and
  enriches "Domaine X, Cuvée Y, 2019, 750ml" to a `verified` image. Restaurant B
  independently imports the same real-world wine (same normalized text ⇒ same
  `canonical_wine_id` via P2). Assert `resolve_wine_images_bulk` called under B's session
  returns the **same** `image_id`, and assert **zero** new `background_jobs` rows were
  created for B's import. **Breaks if** images were ever scoped by `restaurant_id`
  anywhere in the chain, or if the idempotency key omitted `canonical_wine_id`.
- **Ownership check, the malicious case (Finding B):** Restaurant B genuinely holds a
  `wine_variants` row for `(canonical_wine_id=W, vintage=2019, size_ml=750)`. Restaurant A
  does not. Call `enqueue_wine_image_enrichment_job` as a staff member of Restaurant A,
  passing Restaurant A's own `p_restaurant_id` but Restaurant B's `(W, 2019, 750)` tuple.
  Assert the call raises `forbidden` and **zero** `background_jobs` rows are created.
  **Breaks if** the ownership `exists` check is removed, or loosened to check that *some*
  restaurant holds the tuple rather than that the *caller's* `p_restaurant_id` specifically
  does — the exact regression Finding B named.
- **Tier-2 acceptance, the positive control (Finding A):** a tail wine with no Tier-1
  dataset hit gets a `wine_image_enrichment` job; the DDGS fixture adapter (§7.2) returns
  one candidate whose fixture OCR text genuinely names the right producer, cuvée, and
  vintage. Run the job. Assert a `wine_images` row results with `state in ('verified',
  'probable')` and a non-null `storage_path`, and that `resolve_wine_images_bulk` returns
  it for that lookup. **Breaks if** §8.5's pipeline is implemented in a way that never
  accepts a genuinely correct candidate — a suite that only tests rejection (the failure
  mode this run keeps hitting) would not catch that regression; this is the case that does.
- **Tier-2 hard rejection, the negative control (Finding A):** the same setup, but the
  DDGS fixture returns a candidate whose fixture OCR text explicitly shows a different
  vintage (2016 when 2019 was requested). Run the job. Assert the resulting row is
  `state='rejected'`, `rejected_reason='vintage_conflict'`, and that
  `resolve_wine_images_bulk` returns **no row** for that lookup — not the rejected row, not
  a fallback to it. **Breaks if** an explicit conflict is ever treated as merely lowering
  `confidence_score` rather than a hard, score-independent rejection.
- **Serving guard, the bug this round found (Finding A):** directly insert (as
  service_role, bypassing the job pipeline) one `wine_images` row with `state='discovered'`
  (`storage_path=null`) and one with `state='downloaded'` (`storage_path` set, but not yet
  scored) for the same `(canonical_wine_id, vintage, size_ml, role)`, with no other row for
  that identity. Call `resolve_wine_images_bulk` for that lookup. Assert it returns **zero
  rows** for that `idx`. **Breaks if** the guard in §10 (`state in ('verified','probable',
  'unverified') and storage_path is not null`) is ever loosened back toward the original
  `state <> 'rejected'` — the exact bug this round fixed.
- **Merge repoint correctness:** canonical wine S has two `wine_images` rows (`bottle_full`
  selected, `label_front` unselected); canonical wine T has its own selected `bottle_full`
  image. Call `merge_canonical_wines(S, T)`. Assert (a) both of S's rows now have
  `canonical_wine_id = T`; (b) T's pre-existing selected `bottle_full` image is **unchanged**
  (same id, still selected); (c) S's formerly-selected row is now `selected=false` but still
  exists; (d) `identity_merge_log.moved_counts->>'moved_wine_images' = '2'`. **Breaks if** a
  future change to `merge_canonical_wines` forgets the repoint (the exact standing tripwire
  0100's own comment demands) or drops the pre-repoint `selected=false` clear, which would
  make this test fail with a `23505` unique-violation instead of the asserted success.
- **RESTRICT proof:** attempt `delete from canonical_wines where id = S` directly (not via
  `merge_canonical_wines`) while S still has a `wine_images` row. Assert a `23503`
  foreign-key violation. **Breaks if** the FK is ever changed from RESTRICT to CASCADE
  (would silently destroy images) or SET NULL (would silently orphan them).

**DB-contract (pgTAP, following `supabase/tests/0074_public_api_grants.sql`):**

- Assert `authenticated` has SELECT but not INSERT/UPDATE/DELETE on `wine_images`,
  `image_sources`, `image_licenses`, `enrichment_source_attempts`. **Breaks if** a future
  migration accidentally grants a write privilege to `authenticated`, reopening the
  worker-only-write boundary.
- Assert EXECUTE on `claim_wine_image_enrichment_job`/`reclaim_stuck_wine_image_enrichment_jobs`
  is `service_role`-only, and EXECUTE on `enqueue_wine_image_enrichment_job`/
  `resolve_wine_images_bulk` is granted to `authenticated`. **Breaks if** the claim/reclaim
  functions are ever left executable by `PUBLIC` (a privilege-escalation regression) or the
  enqueue function's grant is missing (a functional regression).
- Attempt a direct service-role INSERT of a second `selected=true` row for the same
  `(canonical_wine_id, vintage, size_ml, role)`. Assert `23505`. **Breaks if** the partial
  unique index is dropped or its column list narrowed.
- Attempt a direct INSERT with `license_id='cc-by-4.0'` and `attribution_text=''`. Assert
  rejection by `wine_images_require_attribution`. **Breaks if** the trigger is removed or
  its `requires_attribution` lookup is short-circuited — this is the literal DB-level
  enforcement of the run's single non-negotiable requirement.
- `anon` holds no privilege on `wine_images`, in the same `pg_attribute`-scanning style as
  `supabase/tests/0074_public_api_grants.sql`'s pins for `wines`/`restaurants`:

  ```sql
  select ok(
    not has_table_privilege('anon', 'public.wine_images', 'select')
    and not exists (
      select 1
      from pg_attribute a
      where a.attrelid = 'public.wine_images'::regclass
        and a.attnum > 0
        and not a.attisdropped
        and has_column_privilege('anon', 'public.wine_images', a.attname, 'select')
    ),
    'anon holds no privilege on wine_images -- see design doc §4.7'
  );
  ```

  **Breaks if** any future migration grants `anon` so much as one column's SELECT on
  `wine_images` — including as a side effect of a broad `grant select on all tables in
  schema public to anon`-style statement — which is exactly the scenario §4.7 names as the
  point where the licence reasoning for `unrated-web-source` images would silently invert.

**Fault injection:**

- DDGS fixture returns malformed JSON. Assert zero candidates result, `enrichment_source_
  attempts.outcome='invalid_response'` is recorded, and the job proceeds to try the next
  ranked source rather than aborting. **Breaks if** a schema-drifted response is ever
  partially trusted into a real `wine_images` row.
- DDGS fixture returns HTTP 429. Assert `outcome='rate_limited'`, `run_after` is bumped by
  the existing backoff constants, and the job returns to `queued` rather than hot-looping.
  **Breaks if** a naive immediate-retry replaces the backoff.
- All sources return zero candidates. Assert the job completes `status='succeeded'` with
  `result->>'candidates_found'='0'` (not `'failed'`/`'dead'`), and no `wine_images` row
  exists. **Breaks if** a future implementation starts inserting a placeholder row for "no
  image found," which would silently zero out an operator's real coverage metric.
- Kill the batch script mid-job after claiming but before completing. Run
  `reclaim_stuck_wine_image_enrichment_jobs` after the stuck threshold. Assert the job
  returns to `queued` with `attempt_count` incremented, and that a job already at
  `max_attempts - 1` is marked `dead` on the next reclaim rather than looping forever.
  **Breaks if** `wine_image_enrichment` jobs were wired with bespoke (and unproven) reclaim
  logic instead of reusing the already-proven shared mechanism.
- **Negative control:** enqueue a `wine_image_enrichment` job against a Supabase project
  that also has the abandoned staging deployment's generic worker running (or a local
  double, its exact `job_type = 'wine_enrichment'` claim query reproduced against a
  fixture row). Assert the abandoned worker's claim query matches zero of this design's
  rows. **Breaks if** a future change ever reuses or aliases the `wine_enrichment` job type
  for this feature instead of `wine_image_enrichment` — the exact regression §8.1 exists to
  prevent.
- **Positive control for the same fixture, added this round:** insert a genuine `queued`
  `wine_image_enrichment` row and call `claim_wine_image_enrichment_job` directly. Assert
  it successfully claims that row (`status` flips to `'processing'`, `claimed_by` set to
  the calling worker id). **Breaks if** the claim function's own `job_type` string has a
  typo or drifts from what `enqueue_wine_image_enrichment_job` actually inserts — the
  negative control above proves the gate can reject the abandoned worker's rows; this
  proves it can also accept its own, which a maximally-restrictive (i.e. permanently
  broken) claim function would otherwise pass unnoticed.
