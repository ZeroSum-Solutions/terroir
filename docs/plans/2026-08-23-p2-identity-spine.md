# P2 — Wine Identity Spine and Duplicate Prevention

Status: design only. No code or migrations were written by this pass.

> **MIGRATION-NUMBER CORRECTION (added by the orchestrating session, 2026-08-23).**
> This plan was authored reserving `0077`–`0081`. Those numbers are **already claimed** by
> the concurrent `fix/db-audit-2026-08-23` branch, which reserves **0077–0096** across four
> sequenced fix lanes (0077–0078 performance, 0079–0084 tenancy, 0085–0090 inventory,
> 0091–0096 scans/hygiene). Both branches descend from `225fbfb` where the tip is `0076`, so
> the collision would only surface at merge — exactly the failure mode
> `docs/runbooks/migration-numbering.md` documents from 2026-05-23.
> **P2 therefore takes `0097`–`0101`**, in the same order listed in §3. P3 takes `0102`+.
> Re-verify against `ls supabase/migrations/ | sort | tail` on BOTH branches before creating
> files. Never renumber an applied migration.

## 0. Scope statement

P2 delivers: (1) two new global/tenant-scoped identity tables (`canonical_wines`, `wine_variants`) plus a shared alias ledger (`wine_aliases`) and a merge audit log (`identity_merge_log`); (2) a normalization spec precise enough to implement identically in two places; (3) a set-based identity-resolution RPC (`resolve_wine_variants_bulk`) that is the "dedup service"; (4) an extended `merge_wines` (closing a confirmed audit gap) plus a new `merge_canonical_wines`; (5) the NV-vintage acceptance fix. P2 does **not** touch `apply_import_batch_chunk`, `import_batches`/`import_batch_rows`, the CSV upload/staging path, `wine_images`/`image_embeddings`/`scan_sessions`, or any of the tenancy/concurrency bugs outside its lane (C01, C05, C06, C09, C17 are explicitly out of scope — see §12).

## 1. Why `canonical_wine_id` outranks LWIN (affirming the blueprint, one addendum)

The blueprint's reasoning holds: LWIN is curated by a third party, covers ~200k wines, and a bad fuzzy match against it is currently irreversible the moment `match_lwin_batch`/`match_lwin_bulk` writes `wines.lwin_id` (C24). Terroir's own UUID must be able to represent a wine LWIN has never heard of (the entire long tail of the partner's 20k-row cellar) and must never be *retroactively invalidated* by a later, better LWIN match — LWIN participates as an alias, never as the row's identity.

Addendum: the codebase already has a per-tenant analogue of this idea (`wine_lineages`, migration 0054) that pins vintage-sibling wines to one producer+cuvée identity, LWIN7-anchored with a name fallback. P2 does not replace it — see §2.

## 2. Coexistence decision: `wines` is extended, not replaced or shadowed

**Decision: `wines` stays the authoritative per-tenant operational row** (inventory, pours, pricing, tasting notes, everything accumulated across 50+ migrations). It is *extended* with two new nullable FK columns, never migrated off of. `wine_lineages` gains one new nullable FK column. Nothing existing is renamed, dropped, or made an FK target of anything that isn't additive.

Rejected alternatives:

- **Replace `wines` with `wine_variants` as the FK target for inventory/pours/etc.** — touches 9+ tables' foreign keys (`inventory_items`, `pour_events`, `open_bottles`, `wine_list_items`, `availability_events`, `bottle_closeouts`, `cellar_health`, `stock_adjustments`, `pricing_recommendations`) in one migration set. A different, much larger piece of work than "identity spine," and if it breaks, a blind critic evaluating duplicate prevention also sees broken pours/pricing/cellar-health — collateral damage that isn't P2's to risk.
- **Shadow tables that nothing reads** — worthless for the grading criterion, since nothing in the running app would consult them.
- **Backfill by rewriting `wines` rows in place** — there's nothing to rewrite; `wines` doesn't need new *values*, it needs a *pointer* to the identity layer.

Concretely:

- `wines.wine_variant_id uuid null references wine_variants(id)` — **not** unique, deliberately. If two `wines` rows (one via the untouched `find_or_create_wine` RPC, one via the CSV path) resolve to the same real-world identity because of spelling drift, they legitimately share one `wine_variant_id`. That is the exact signal a "possible duplicate" review surface wants, and it is cheaper to detect (`GROUP BY wine_variant_id HAVING count(*) > 1`) than to prevent by force.
- `wines.canonical_wine_id uuid null` — denormalized convenience (avoids a join through `wine_variants` for every list/search view; gives P4's image resolver a one-hop path). **Kept in sync by a trigger, not by convention** (`wines_derive_canonical_wine_id`, `before insert or update of wine_variant_id`). A convention-only invariant here would reproduce exactly the drift C17 demonstrates elsewhere (`import_batch_rows` has two independently-writable FKs that can disagree).
- `wine_lineages.canonical_wine_id uuid null references canonical_wines(id) on delete set null` — a light-touch link only. `derive_wine_lineage()`, `merge_wines`'s lineage-equality guard, and every existing lineage consumer are untouched. Inert in P2; exists so a future piece can join tenant lineages to global identity without a schema change.

## 3. Migration set

Tip is `0076_csv_import_batches.sql` on every worktree checked. Per the correction block above, P2 takes **0097–0101**.

### 0097_canonical_wines.sql — the global identity table

| column | type | constraint | reasoning |
|---|---|---|---|
| `id` | uuid | PK default `gen_random_uuid()` | immutable internal identity, per blueprint §2 |
| `producer` | text | not null | display form, first-seen casing, never silently overwritten |
| `cuvee` | text | not null | base wine name, no vintage (mirrors LWIN7's scope) |
| `producer_norm` | text | not null | normalized producer, §5 — the exact-match key |
| `cuvee_norm` | text | not null | normalized cuvée, §5 |
| `colour` | text | null | free text, matches `wines.colour` (0049) / `lwin_catalog.colour` — no enum, consistency over cleverness |
| `region`, `country` | text | null | fill-only-null on later matches, same semantics as `find_or_create_wine` |
| `lwin7` | text | null, `check (lwin7 ~ '^[0-9]{7}$')` | external alias anchor, never the PK |
| `identity_status` | text | not null default `'unverified'`, `check in ('lwin_verified','operator_confirmed','unverified')` | distinguishes curated identity from tenant-asserted identity — the anti-pollution signal (§8) |
| `created_by_restaurant_id` | uuid | null, `references restaurants(id) on delete set null` | audit only, never a tenancy boundary |
| `created_by_user_id` | uuid | null, `references auth.users(id) on delete set null` | audit only |
| `created_at`, `updated_at` | timestamptz | not null default `now()` | standard, reuse `set_updated_at()` |

Indexes: `unique (producer_norm, cuvee_norm)`; `unique (lwin7) where lwin7 is not null`; `gin (producer_norm gin_trgm_ops)`, `gin (cuvee_norm gin_trgm_ops)` — queried with the `%` operator under `pg_trgm.similarity_threshold`, **never** `similarity(...) >= x`. That is the direct application of C07's lesson to new code rather than a repetition of it.

RLS: enabled; `select` to `authenticated` `using (true)` (same trust tier as `lwin_catalog`, 0003); `insert` to `authenticated` gated on the *shape* of the row (§8 — no per-row ownership check is possible on a global table, so the check is on what can be asserted, not who asserts it); **no client-facing update/delete grant** — mutation goes through `resolve_wine_variants_bulk` (fill-null-only) or `confirm_wine_alias`/`merge_canonical_wines`.

### 0098_wine_variants.sql — the tenant-scoped identity table, plus `wines`/`wine_lineages` hooks

`wine_variants`:

| column | type | constraint | reasoning |
|---|---|---|---|
| `id` | uuid | PK | |
| `restaurant_id` | uuid | not null, `references restaurants(id) on delete cascade` | tenant ownership |
| `canonical_wine_id` | uuid | not null, `references canonical_wines(id) on delete restrict` | `restrict` — a canonical row backing a live tenant variant must never silently vanish; the only sanctioned removal path is `merge_canonical_wines` |
| `vintage` | int | null, `check (vintage is null or vintage between 1900 and extract(year from now())::int + 1)` | null = NV, identical convention to `wines.vintage` |
| `size_ml` | int | not null default 750, `check (size_ml > 0)` | the format identity key — §5, deliberately numeric, not the free-text `format` column |
| `lwin11` | text | null, `check (lwin11 ~ '^[0-9]{11}$')` | vintage-level LWIN alias |
| `lwin16` | text | null, `check (lwin16 ~ '^[0-9]{16}$')` | vintage+size LWIN alias |
| `gtin` | text | null, `check (gtin ~ '^[0-9]{8,14}$')` | tenant's barcode copy — loose length check (UPC-A/EAN-13/GTIN-14 all valid) |
| `display_name` | text | null | cached render string; no identity query touches it |
| `created_at`, `updated_at` | timestamptz | not null default `now()` | |

Indexes/constraints: `unique (id, restaurant_id)` (composite-FK target); `unique (restaurant_id, canonical_wine_id, coalesce(vintage, 0), size_ml)` — **the exact-match identity key**, `coalesce` chosen to match the existing `wines_dedup_idx` convention exactly; `unique (restaurant_id, gtin) where gtin is not null`; `index (restaurant_id)`; `index (canonical_wine_id)`.

RLS: same shape as `wines` — `select`/`insert`/`update` via `is_member(restaurant_id)`, **no delete policy** (identity records are permanent audit trail, same posture as `import_batches`/`stock_adjustments`).

`wines` alterations: add `canonical_wine_id`, add `wine_variant_id`, add `constraint wines_variant_tenant_fk foreign key (wine_variant_id, restaurant_id) references wine_variants(id, restaurant_id)`. The composite FK is C17's own fix sketch applied from day one on a brand-new column rather than retrofitted — it makes "a wines row pointing at another tenant's wine_variant" a constraint violation rather than a possible bug. Plus the `wines_derive_canonical_wine_id` trigger from §2.

`wine_lineages`: add `canonical_wine_id uuid null references canonical_wines(id) on delete set null`. No trigger, no backfill — inert until a later piece needs it.

### 0099_wine_identity_resolution.sql — the dedup service's DB entrypoint

`resolve_wine_variants_bulk(p_restaurant_id uuid, p_variants jsonb) returns table (idx int, canonical_wine_id uuid, wine_variant_id uuid, canonical_match_method text, canonical_created boolean, variant_created boolean)`.

- **Input**: already normalized by the TypeScript layer (§5) — this function does no Unicode folding. Each element: `{idx, producer_raw, cuvee_raw, producer_norm, cuvee_norm, vintage, size_ml, lwin7, lwin11, lwin16, gtin}`. `lwin7` **must already have cleared the caller's confidence gate** — §6, a contract, not a suggestion.
- **`security invoker`, not definer.** The load-bearing tenancy decision: RLS on `wine_variants` (requiring `is_member(restaurant_id)`) is the only thing between a caller and writing another tenant's variant, and invoker mode makes that check actually apply. This is C01's own fix sketch ("prefer SECURITY INVOKER so RLS is the boundary") applied to new code.
- **Algorithm** (set-based; no per-row PL/pgSQL loop, no advisory locks — §9):
  1. Unnest `p_variants` via `jsonb_to_recordset`.
  2. **Canonical, phase 1 (exact):** left join `canonical_wines` on `(lwin7 is not null and cw.lwin7 = i.lwin7) or (cw.producer_norm = i.producer_norm and cw.cuvee_norm = i.cuvee_norm)`. LWIN7 equality wins even where text differs; such a row gets an `import_raw` alias, not a duplicate canonical row.
  3. **Canonical, phase 2 (create):** one batched `insert ... select distinct on (producer_norm, cuvee_norm) ... on conflict (producer_norm, cuvee_norm) do nothing returning ...` — handles two rows in the *same* input batch being the same new wine, a real risk when a long-tail producer appears many times in one 20k import.
  4. Re-join to get every input row's `canonical_wine_id` (exact ∪ newly inserted ∪ lost-the-conflict-race read-back).
  5. **Variant resolution:** identical two-phase pattern keyed on `(restaurant_id, canonical_wine_id, coalesce(vintage,0), size_ml)`.
  6. **Alias write:** one batched insert into `wine_aliases` recording every raw producer/cuvée string against its resolved `canonical_wine_id` (`match_method = 'exact'`) — this builds the spelling corpus over time.
  7. Return the per-`idx` result set.
- **Cost shape:** every phase is O(1) SQL statements regardless of input size, not O(n) function calls — the direct answer to C10 (§9).

### 0100_wine_identity_merge.sql — merge, closing the confirmed C23 gap

`identity_merge_log` (append-only): `id`, `merge_type` (`check in ('canonical_wine','wine')`), `source_id`, `target_id`, `restaurant_id` (populated for wine-level, null for canonical-level), `source_snapshot jsonb` (full row of the deleted thing at delete time), `moved_counts jsonb` (per-child repointed counts, same shape `merge_wines` already returns), `merged_by`, `merged_at`.

RLS: `select` gated as the corresponding merge's authorization; no client insert/update/delete — only the merge functions write it.

**`merge_wines` is replaced again** (the same pattern 0055 used on 0054's version), extended to:

1. Repoint `wine_variant_id`: source null → nothing; target null and source set → adopt; **both set and different → raise `variant_identity_conflict`** naming both variant ids. That reveals normalization failed to converge two spellings, and the fix is a `merge_canonical_wines` call first, not a silent pick.
2. Repoint the four confirmed-missing C23 children that are `on delete cascade` today (currently *destroyed*, not orphaned, by every merge): `bottle_closeouts`, `stock_adjustments`, `pricing_recommendations` — full repoint, because these are ledger/audit data that must survive. `cellar_health` — `unique(restaurant_id, wine_id)`, so repoint `on conflict do nothing` and drop the source's stale row (materialized nightly, safe to recompute).
3. Repoint `import_batch_rows.applied_wine_id` (currently `on delete set null` — the merge silently orphans the "which import created this wine" link today).
4. Write one `identity_merge_log` row before the delete.
5. Existing lineage/vintage/format-equality guards and the manager-role check are untouched. This is a mechanical extension, not a rewrite of its guards.

`merge_canonical_wines(p_source_id uuid, p_target_id uuid) returns jsonb`:

- **`security definer`** — the one place in P2 that legitimately needs it, because the operation is inherently cross-tenant (it may repoint `wine_variants` belonging to restaurants the caller has never heard of) and no single tenant's RLS can be the boundary. Unlike the audited functions, this pairs `definer` with an explicit check.
- **Authorization:** caller must be `is_member_with_role(r, 'manager')` for **at least one** restaurant `r` holding a `wine_variants` row referencing either side. Requiring every affected tenant's manager to co-sign is impractical for a prototype and blocks the exact "fix the shared catalog" workflow the blueprint wants; requiring at least one real stakeholder is the middle ground. **This is the least-settled call in the plan** — §14.
- **Guards, fail loud, no silent picks:** `identical_merge` if source = target. For every restaurant holding a variant under **both** source and target with the **same** `(coalesce(vintage,0), size_ml)`, raise `variant_conflict` naming the restaurant and both ids — a real variant-level duplicate revealed by the canonical merge, resolved via the tenant's own `merge_wines` first, deliberately **not** auto-resolved (§14). Otherwise repoint `wine_variants.canonical_wine_id`, `wine_lineages.canonical_wine_id` (where populated), `wine_aliases.canonical_wine_id` (deduping exact-duplicate alias rows the way 0055 deduped `wine_list_items`), write the log, delete source.
- **Standing convention, stated in the migration file itself:** every future migration adding an FK to `canonical_wines(id)`/`wine_variants(id)` (P4's `wine_images`, P6's `scan_candidates`) **must** extend this function and the §11 regression test in the same migration. This generalizes C23's own fix sketch from a one-time patch into a standing contract test.

**Reversibility, plainly:** merges are **hard deletes, not self-service-reversible.** `identity_merge_log` gives *forensic* reversibility (a human can reconstruct the deleted row and re-run the moved counts by hand). There is no `unmerge_*` RPC in P2. True reversibility (soft-delete plus every read path filtering merged rows) is a materially larger piece with app-wide blast radius — deferred (§12).

### 0101_wine_identity_backfill.sql — data migration for pre-existing `wines` rows

Idempotent, following the three-pass structure `0054_wine_lineages.sql` already used for its own backfill:

1. `create extension if not exists unaccent;` (not currently enabled anywhere — confirmed by grep).
2. For every `wines` row with `wine_variant_id is null`, compute a **best-effort SQL-side normalization** using `unaccent()` + `lower()` + `regexp_replace(..., '[^a-z0-9]+', ' ', 'g')` + token-sort via `string_agg(t, ' ' order by t)`.
3. **This SQL approximation is explicitly not a perfect mirror of the TypeScript algorithm in §5** — Postgres `unaccent`'s dictionary and JS `NFKD` plus manual œ/æ folding will not agree on every input. Stated, not hidden: the failure mode is *always* "creates one extra canonical/variant row a later exact match could have reused," never "merges two different wines." Given that invariant, an imperfect one-time backfill is a bounded-risk trade.
4. Match/create canonical + variant rows using §3's exact-key logic, then set both columns on `wines` in one bulk UPDATE (skipping the trigger for the backfill's own statement; the trigger stays scoped to application-code changes going forward).
5. On a fresh local stack `wines` is empty, so this is a no-op there. It exists for production-safety discipline, matching this codebase's habit of never assuming a clean slate.

## 4. Migration-number collision check

Checked against `main` (`225fbfb`) and every live worktree (`terroir-vw` @ `c95ea08`, `terroir-vw-p1` @ `add2d93`, `terroir-vw-audit` @ `33a3fae`) — all show `0076_csv_import_batches.sql` as latest, no duplicates, no gaps besides the documented 0067–0071. See the correction block at the top for the 0097–0101 reassignment. Re-check immediately before creating files.

## 5. Normalization rules (implementation-grade, single TypeScript source of truth)

**File:** new `src/domains/identity/normalize.ts`.

**Critical cross-piece fact:** P1's fixture generator (`scripts/fixtures/generate-partner-cellar.mjs`) already contains an inline `normalizeForDedup()` used to prove its spelling-noise groups converge. P2's implementation must be **byte-for-byte identical in behavior**, because P1's fixture is the graded oracle.

```
normalizeProducerOrCuvee(raw: string): string
  1. raw.replace(/œ/gi, "oe").replace(/æ/gi, "ae")   // NFKD does not decompose true ligatures
  2. .normalize("NFKD")
  3. strip Unicode combining marks, U+0300–U+036F
  4. .toLowerCase()
  5. .replace(/['’]s(?=\s|$)/g, "s")   // merge a TRAILING possessive into its host word (added round 3, D3/D7)
  6. replace everything not [a-z0-9] with a single space
  7. .trim()
  8. split on spaces, drop empties, SORT TOKENS ALPHABETICALLY, rejoin with single space
```

Step 8 (token-sort) makes `producer_reorder` ("Domaine Jean Grivot" vs "Jean Grivot Domaine") an **exact** match rather than fuzzy. Named risk, not papered over: token-sort can theoretically conflate two *different* producers whose names are word-order permutations. The mitigation is structural, not a threshold — the exact-match key is never producer-alone; it is `(producer_norm, cuvee_norm)` for canonical identity and additionally `(vintage, size_ml)` for variant identity, so an accidental collision would require all of those to coincide too.

**Step 5, the possessive rule (added round 3 — D3, then D7):** round-2 review of the shipped implementation found that a possessive apostrophe and a pair of period-separated initials could decay to the SAME stray single-character token set — `"O'Brien's Vineyard"` and `"O.S. Brien Vineyard"` both produced `{"brien","o","s","vineyard"}` and over-merged. Step 5 targets ONLY a trailing possessive marker (an apostrophe — straight `'` or curly `’` — immediately before a word-final `s`), merging it into its host word (`"Brien's"` -> `"briens"`) before the general collapse in step 6 ever runs. It deliberately does NOT touch any other apostrophe position: a name-internal apostrophe like `"d'Alsace"` still splits into separate tokens exactly as before, which is required for byte-for-byte parity with P1's fixture (see below) — its own `punctuation_spacing` golden vector, `"Cœur d'Alsace"`/`"Coeur d'Alsace"`, is unaffected by this rule. A blanket "drop every single-character token" alternative was considered and rejected: it would also drop DIGIT tokens, incorrectly collapsing `"Chateau 5"` and `"Chateau 6"` (a verified-must-stay-distinct adversarial case) into the same key.

**Named integration risk — RESOLVED (round 3):** P1's copy of this function lives in a different worktree and P2 cannot edit it. Round 2 review found the two implementations had silently diverged: P2 shipped the step-5 possessive rule but P1's `normalizeForDedup` was never told about it, and the existing golden-vector contract test only checks agreement on P1's own 40 `SPELLING_SEEDS` pairs — none of which contain a possessive apostrophe — so the divergence was invisible to it. Fixed via option (b) below, done properly: P1 adopted the byte-identical rule (same regex, same pipeline position, coordinated directly against P2's implementation in commit `c537d84`), and a SEPARATE adversarial contract test (`src/domains/identity/normalize.test.ts`, describe block `"adversarial P1/P2 normalization parity"`) checks both live implementations against a corpus of realistic possessive/apostrophe inputs absent from the 40-seed fixture — trailing possessives, the curly-quote variant, plural-only possessives, multiple possessives in one name, and internal+trailing combinations — and is written to FAIL on any future divergence, not just the ones already found. At merge time the two sanctioned resolutions were: (a) P1's generator imports P2's shared module, or (b) a contract test asserts both implementations agree on a fixed golden-vector list. (b) was chosen, now extended beyond the original 40-seed list.

```
normalizeVintage(raw: string | null): number | null
  1. null/empty -> null (unchanged from today)
  2. collapse := raw.trim().toUpperCase().replace(/[.\-\/]/g, " ").replace(/\s+/g, " ").trim()
  3. collapse in {"NV","N V","NON VINTAGE","NONVINTAGE","MV","MULTI VINTAGE"} -> null
     (this IS the identity fact "no vintage", not an error)
  4. else the existing Number.parseInt + MIN_VINTAGE..CURRENT_YEAR+1 range check, unchanged
```

A **closed allowlist, deliberately not a fuzzy detector** — for the same reason fuzzy identity matching may never silently merge. A fuzzy "is this NV?" heuristic risks reclassifying genuinely malformed vintage text (`"202X"`, `"circa 1998"`, `"'98"`) as legitimate non-vintage data, which is corruption in the opposite direction. Implementation site: `src/domains/import/row-validator.ts` lines 86–95 — call `normalizeVintage` before the existing numeric parse, skip the numeric branch on an NV hit. P2 and P3 both have a stake here; naming it P2's because it is an identity fact, not a staging concern, while flagging the overlap.

**Known interaction with P1's fixture, disclosed rather than absorbed:** P1's `--dirty` `bad_vintage_text` category (17 rows cycling 7 texts, including literal `"NV"`) will see roughly 2–3 rows flip from correctly-rejected to correctly-accepted once this lands, because `"NV"` was never bad data — it predates the importer's NV acceptance. A correct side effect, not a regression.

**Size/format:** `size_ml` is the **sole** identity key for bottle format — never the free-text `format` column (0073), which describes decoration/purchase metadata ("Magnum" vs "1.5L Magnum" vs "1500ml" for the same `size_ml=1500`) and must never create separate identities. Where a CSV supplies only text, a closed lookup for P3's row-validator to consult when `size_ml` is blank: `{split/piccolo:187, half/demi:375, bottle:750, magnum:1500, double magnum/jeroboam(bordeaux):3000, rehoboam:4500, methuselah/imperial:6000, salmanazar:9000, balthazar:12000, nebuchadnezzar:15000}` — closed, not fuzzy, for the same reason as NV.

## 6. Dedup decision procedure

Three tiers. The boundary between them is the most important sentence in this plan: **vintage and bottle size are never part of the fuzzy layer.** They are always exact-key fields. Only producer and cuvée text ever pass through fuzzy matching, and only to *suggest*.

1. **Exact (auto-link, no human):** LWIN7/11/16 equality, OR `(producer_norm, cuvee_norm)` equality for canonical identity plus `(canonical_wine_id, vintage, size_ml)` for variant identity. The dominant path — every repeat purchase and every accent/case/punctuation/NFC-NFD/word-order variant in P1's fixture, plus every NV wine, resolves here.
2. **Candidate (suggest, never auto-link):** trigram similarity on `producer_norm`/`cuvee_norm` in **0.3–0.6** (via `%` with `pg_trgm.similarity_threshold`) with no exact key. Recorded as a `wine_aliases` row with `match_method = 'fuzzy_suggested'`. Never written to `canonical_wines.lwin7`, never used to reuse an existing row, never blocks import — the row still gets its own new identity and the suggestion sits in a review queue.
   **This reconciles C24 with the blueprint's "fuzzy suggests, never merges" rule** without touching `match_lwin`/`match_lwin_bulk` (out of scope): the contract for P3 is that an `import_batch_rows.lwin_id` from the existing 0.3-threshold matcher may only be forwarded as `lwin7` if its `lwin_score >= 0.6` (P2's stricter, precision-first bar). Anything below must be forwarded as a separate `lwin_candidate` field that only ever produces a `fuzzy_suggested` alias. Below 0.3: discarded, no alias recorded.
3. **Human-confirmed merge:** the only path that collapses two already-created identities — `merge_wines` (tenant) or `merge_canonical_wines` (global), both role-gated, both logged, neither reachable from an automated score.

**The failure the blueprint cares about most** (two genuinely different wines silently collapsed) is structurally prevented, not discouraged: it would require either a coincidental exact-key collision across all four fields for a token-sort-normalized pair that are actually different wines (theoretically possible, practically vanishingly rare — named as residual risk), or a human explicitly invoking a merge RPC against wines that fail its own guards (which raise `lineage_mismatch_merge`/`cross_vintage_merge`/`format_mismatch_merge`/`variant_identity_conflict` rather than proceeding).

## 7. Merge and unmerge — full child-table enumeration

For `merge_wines`, every table with a live FK to `wines(id)`:

| table | current FK action | current merge_wines behavior | this plan |
|---|---|---|---|
| `inventory_items` | restrict | repointed | unchanged |
| `pour_events` | cascade | repointed | unchanged |
| `open_bottles` | cascade | repointed | unchanged |
| `wine_list_items` | restrict | repointed, deduped per-section | unchanged |
| `availability_events` | cascade | repointed | unchanged |
| `bottle_closeouts` | **cascade (destroys on delete today)** | **not repointed — data loss (C23)** | **repointed** |
| `cellar_health` | **cascade** | **not repointed — data loss (C23)** | **repointed, `on conflict (restaurant_id, wine_id) do nothing`** |
| `stock_adjustments` | **cascade** | **not repointed — audit-trail loss (C23)** | **repointed** |
| `pricing_recommendations` | **cascade** | **not repointed — data loss (C23)** | **repointed** |
| `import_batch_rows.applied_wine_id` | **set null** | **orphaned (C23)** | **repointed** |
| `wines.wine_variant_id` (new) | — | n/a | repointed with the fail-loud `variant_identity_conflict` guard |

For `merge_canonical_wines`: `wine_variants.canonical_wine_id` (repointed, `variant_conflict` guard per restaurant), `wine_lineages.canonical_wine_id` (where set), `wine_aliases.canonical_wine_id` (repointed, deduped). Any future FK to `canonical_wines`/`wine_variants` must be added here in the same migration that introduces it — §11's test fails the build otherwise.

Reversibility: **hard delete, not self-service reversible.** Forensic only, via `identity_merge_log`.

## 8. Tenancy

| table | scope | select | insert | update | delete |
|---|---|---|---|---|---|
| `canonical_wines` | global | any authenticated | any authenticated, shape-restricted | none directly | none |
| `wine_variants` | tenant | `is_member(restaurant_id)` | `is_member(restaurant_id)` | `is_member(restaurant_id)` | none |
| `wine_aliases` (canonical-scoped) | global | any authenticated | any authenticated, `match_method in ('exact','fuzzy_suggested')` only | none | none |
| `wine_aliases` (variant-scoped) | tenant | `is_member(restaurant_id)` | `is_member(restaurant_id)`, same restriction | none | none |
| `identity_merge_log` | mixed | staff of an affected restaurant | none (function-only) | none | none |

**The anti-pollution answer, directly:** any authenticated tenant *can* insert into `canonical_wines` and `wine_aliases` — there is no way to lock down a genuinely shared, globally-readable table used by every tenant's import while still letting the long tail (wines with no LWIN match) be created at all. What stops corruption is not access control but **what a given `match_method`/`identity_status` may assert**:

- A client-reachable insert may only claim `match_method = 'exact'` (an objectively checkable text-equality fact — nothing to trust) or `'fuzzy_suggested'` (explicitly non-authoritative, read by nothing as ground truth).
- `identity_status = 'lwin_verified'` (`'operator_confirmed'` remains unreachable — no promotion RPC exists) is reachable through a raw client insert on `canonical_wines` **or** through `resolve_wine_variants_bulk`, and both paths are gated by the same requirement, enforced identically in both places: the claimed `lwin7` must name a real `lwin_catalog` row whose producer/display name **deterministically** match the submitted producer/cuvée after normalization (exact equality on the normalized text — not a similarity score). A separate table-level `CHECK` constraint additionally makes `lwin7` non-null **only** when `identity_status = 'lwin_verified'`, universally, including for the one-time backfill migration, which runs as the table owner and bypasses RLS entirely.

  **Revision history on this point, stated plainly rather than silently corrected:** an earlier draft of this paragraph asserted that `resolve_wine_variants_bulk` "re-derives the match from the confidence-gated `lwin7`" and treated that as sufficient — i.e., it assumed a client-supplied `lwin7` could be trusted once P3's confidence gate had (supposedly) screened it, and that `lwin_verified` rows were therefore inherently trustworthy. Both assumptions turned out to be false and were caught by adversarial review, not by design: `lwin7` is caller-supplied input with no server-side re-derivation, so "confidence-gated" was a client-side convention, not a server-side guarantee; and an early implementation of the corroboration check used a `pg_trgm` similarity **threshold** borrowed from `match_lwin`'s own ranking cutoff (0.3) — a threshold tuned to tolerate false positives because a human reviews `match_lwin`'s suggestions before anything is written. That threshold could not distinguish two real, differently-identified wines that happen to share vocabulary (a live-measured example: two real Bordeaux estates under the same historic property, whose full names share a long common prefix, scored 0.55 similarity — comfortably above 0.3), which meant a wine's `lwin7` claim from an entirely different, correctly-typed submission could pass corroboration for the wrong wine. Composed with LWIN-exact matching intentionally winning over producer/cuvée text (the mechanism that makes a data-entry-error row still land on the right identity), this let one tenant's ordinary, non-adversarial submission of one member of such a pair silently bind a *later* tenant's correct submission of the *other* member onto the first tenant's canonical row — a genuine cross-tenant identity collision requiring no attacker, just two real wines whose names overlap. A second, independent gap let a row claim `identity_status = 'unverified'` while still carrying a real `lwin7`: the corroboration check as originally scoped only gated the `lwin_verified` branch, and LWIN-exact matching itself did not check `identity_status` before matching, so an uncorroborated `lwin7` sitting on an `unverified` row was just as capable of capturing every later import carrying that number as a properly verified one would have been. The current design — deterministic normalized-text equality, checked identically at every insert path, plus the universal `lwin7`-requires-`lwin_verified` constraint, plus an explicit `identity_status = 'lwin_verified'` filter on the LWIN-exact match itself — closes both. The residual risk this leaves is the same one the SQL-side normalization approximation used by the deterministic check (and by the backfill, §3) already discloses: a normalization mismatch between Postgres's `unaccent()` and the TypeScript implementation can cause a **false negative** (a legitimate match fails to verify, creating one extra row), never a false positive (verifying the wrong wine) — that asymmetry is what makes the approximation an acceptable trade here, not merely a convenient one.

- Residual risk, named: a bad actor can still spam `canonical_wines` with junk `unverified` rows (necessarily `lwin7 is null`, per the constraint above) or noisy `fuzzy_suggested` aliases. Blast radius is bounded to noisy autocomplete/candidate lists and does not reach another tenant's inventory, pricing, or pour history, none of which are reachable from a `canonical_wines`/`wine_aliases` write. This bound now holds specifically *because* an unverified row can never carry a claimed `lwin7` that matching logic elsewhere would trust — before the fix described above, that was not true, and the identity layer itself (which canonical row a tenant's variant resolves to) was the reachable target, not merely display noise. Materially smaller than C01/C05 (which reach live tenant inventory directly). Treated as an acceptable prototype-scale trade; a full curation/moderation workflow for the noisy-`unverified`/`fuzzy_suggested` residue is out of scope (§12).

## 9. Performance

**Index plan** — per §3: `canonical_wines` unique btree on `(producer_norm, cuvee_norm)`, unique-partial on `lwin7`, two GIN trigram indexes; `wine_variants` unique btree on the four-column identity tuple, unique-partial on `(restaurant_id, gtin)`, plain index on `canonical_wine_id`; composite FK indexes on `wines`/`wine_aliases`. Every exact-match lookup is a single-index-lookup or hash join — no sequential scan for exact matching anywhere in P2's path — and the fuzzy tier uses `%`/`pg_trgm.similarity_threshold` so its GIN indexes are actually reachable.

**The C10 question, answered:** does P2 add per-row cost to the apply hot path? **No.** `resolve_wine_variants_bulk` is called **once per batch of unique variants**, not once per CSV row, and *before* `apply_import_batch_chunk`'s existing per-row loop — echoing the blueprint's framing that the governing number is unique wine variants, not 20,000 bottle rows. Every phase is a fixed number of set-based statements regardless of batch size; no PL/pgSQL per-row loop, no advisory lock anywhere in P2's own code. P2 does **not** fix `wines_derive_lineage`'s existing advisory-lock behavior (out of scope, unmodified) — no claim to have solved C10, only to have avoided compounding it.

**Cost estimate [ESTIMATE, unmeasured]:** 4,200 unique variants (P1's actual number) resolved in ~5 calls of ~1,000. Each performs 5–8 set-based statements against unique-btree/hash-joinable keys with `canonical_wines` on the order of a few thousand rows. Estimate: **low single-digit seconds total** for all identity resolution across the whole import. Explicitly a hypothesis to measure, not a guarantee — and **not** an estimate of the full import's wall-clock, which remains dominated by `apply_import_batch_chunk`'s per-row loop and `wines_derive_lineage`, both P3/fix-lane territory.

## 10. 3D-readiness

P2 builds no image/3D table (P4 owns those). What it commits to now so P4 faces no migration crisis:

- `wine_variants.size_ml` is the single stable, never-fuzzy-matched numeric fact 3D geometry scaling needs, exact by construction (§6).
- `canonical_wines` — not `wine_variants` — is the correct future home for a `bottle_shape_family` column (Bordeaux/Burgundy/Champagne-flute/etc.), because bottle shape is a fact about the real-world wine, shared across every tenant carrying it. Adding it later is one additive nullable column, not a restructuring. **P2 does not add it now** — no CSV field drives it, and speculative columns aren't earned.
- **The one concrete forward-compatibility commitment:** when P4 builds `wine_images`, it should key off the value tuple `(canonical_wine_id, vintage, size_ml)` rather than `wine_variant_id` row identity — precisely because `wine_variants` is tenant-owned. Keying on the value tuple is what lets one cached image serve every tenant who independently owns that vintage+format, with zero schema change.

## 11. Test plan

**Unit (TypeScript, no DB):**
- `normalize.ts` against P1's 40 `SPELLING_SEEDS` pairs (accent-stripped, NFC/NFD, punctuation/spacing, producer-reorder) — canonical and alt forms normalize identically.
- `normalizeVintage` against the fixture's `nv_literal` token and all 7 `DIRTY_VINTAGE_TEXTS` — assert exactly one ("NV") now passes and the other six still fail.
- Adjacent-vintage and format-sibling groups: assert their normalized keys are **NOT** identical — the negative test defending against "two different wines collapsed."

**Database-contract (pgTAP, following `supabase/tests/0074_public_api_grants.sql`):**
- Every new table has RLS enabled and the correct base-table grant.
- A generalized, standing version of C23's fix sketch: introspect `pg_constraint` for every FK targeting `canonical_wines`/`wine_variants`/`wines(id)` and assert every referencing table appears in `merge_wines`'s or `merge_canonical_wines`'s source text (or an explicit allowlist comment). **Fails the build the day a future migration adds a referencing table without updating the merge** — closing C23's hole permanently rather than once.
- `resolve_wine_variants_bulk` re-run on identical input is a no-op (zero new rows) — the idempotency property the blueprint's §11 asks for.
- `%`/`pg_trgm.similarity_threshold` on `canonical_wines.producer_norm` actually uses the GIN index (`EXPLAIN ANALYZE` shows Bitmap Index Scan, not Seq Scan) — the direct regression test for not repeating C07.

**Integration (live two-tenant Postgres, following `src/domains/import/tenant-isolation.test.ts`'s `signedInClient()` pattern, which that file's own header calls MANDATORY):**
- Tenant A cannot resolve/read tenant B's `wine_variants`; A's `resolve_wine_variants_bulk` targeting B's `restaurant_id` fails via RLS, not a manual check — the C01-shaped test proving the new function doesn't repeat the old bug.
- `merge_canonical_wines` by a non-stakeholder is rejected; by a manager at one of two stakeholder restaurants it succeeds and correctly repoints the *other* restaurant's variant — proving the deliberately asymmetric authorization works as designed.
- `merge_wines` against a fixture pair with populated `bottle_closeouts`/`stock_adjustments`/`cellar_health`/`pricing_recommendations`/`import_batch_rows.applied_wine_id` — assert **zero** rows lost, all present and repointed. The direct C23 regression test.

**Fault injections worth running:**
- Two rows in the *same* batch that are the same new wine — must produce exactly one canonical row (tests the insert-race-within-one-call path, not just cross-call idempotency).
- A row whose `lwin7` matches an existing canonical row but whose text differs — must reuse and record an alias, never duplicate.
- Concurrent calls for overlapping variant sets from two workers (retry-after-timeout) — no duplicate rows, proving `on conflict do nothing` + re-join correctness under real concurrency.
- `merge_wines` on two wines whose `wine_variant_id`s are both set and different — must raise `variant_identity_conflict`, not silently pick.

## 12. What P2 deliberately does not do

- Does not touch `find_or_create_wine`, `find_or_create_wines_batch`, `match_lwin`/`match_lwin_batch`/`match_lwin_bulk` — C01 and C24's fixes belong to the audit fix lane. P2's contract is that its own new functions don't repeat their mistakes, not that it repairs them.
- Does not modify `apply_import_batch_chunk`, `import_batches`/`import_batch_rows`, the upload/staging path, or `MAX_ROWS` — P3's piece. P2's interface to P3 is exactly `resolve_wine_variants_bulk`, called on a pre-deduplicated batch of unique variants before the existing per-row loop.
- Does not build `wine_images`, `image_embeddings`, `scan_sessions`, `scan_candidates` — P4/P6. P2 only guarantees stable, indexed UUIDs they can FK to.
- Does not build self-service merge reversal — forensic only (§7).
- Does not build a curation/moderation workflow for global identity data — §8 bounds the harm instead.
- Does not backfill `wine_lineages.canonical_wine_id` or build any consumer of it.
- Does not attempt a recursive canonical→variant→wines merge cascade — fails loud and names the manual follow-up instead.

## 13. Where the blueprint and the existing schema conflict

- **Blueprint's `wine_variants` reads as globally scoped**; this plan makes it tenant-owned. Terroir's inventory model is restaurant-scoped SaaS, and a global vintage+format catalog shared across tenants would recreate exactly the cross-tenant-write risk C01/C05/C06 already demonstrate. §10's value-tuple-keyed image design recovers the cross-tenant sharing benefit without making the variant row itself global.
- **Blueprint doesn't mention `wine_lineages`** (it predates that migration), yet the schema already has a per-tenant producer+cuvée identity concept doing almost the same job at a different scope. Resolution: light-touch link (§2), not a merge of the two concepts. Full reconciliation is future work.
- **Blueprint's confidence tiers (0.90/0.70/0.30) are calibrated for multi-channel image verification, not text-only identity matching.** This plan defines its own tiers (§6) for the text problem while keeping the same three-tier philosophy: auto / suggest / discard.

## 14. Open uncertainties

- `merge_canonical_wines`'s "manager at any one stakeholder restaurant" rule is a judgment call, not a settled design — it trades strict correctness (every affected tenant arguably should consent) for practicality. Worth a second opinion before treating as final.
- The SQL-side backfill normalization (0101, `unaccent`) is a known, accepted approximation of the TypeScript algorithm — bounded as described, but not verified against real accented data.
- The cross-piece contract with P1's own `normalizeForDedup` (§5) is unresolved: either P1 imports P2's module or a golden-vector contract test enforces agreement. Not assuming it resolves itself.
- The 20k identity-resolution cost estimate (§9) is unmeasured. Reasoning for the order of magnitude exists; a benchmark does not.
