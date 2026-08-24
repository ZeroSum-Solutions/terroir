# P2 (wine identity spine) — round-4 critic report

Target: `terroir-vw` worktree, branch `feat/visual-wine-prototype`, tip `08a665c`.
Stack: existing `terroir-vw-local` Docker stack (API 57321, Postgres 57322) — not restarted, not reset.

## VERDICT: DOES-NOT-MEET

The single most important test in this round's brief — whether the D9 corroboration gate
actually stops a real-but-mismatched LWIN pairing, not just outright garbage — **fails**. I
reproduced the full cross-tenant identity-corruption chain live, through the real
`resolve_wine_variants_bulk` RPC as two real signed-in tenants, and separately through the raw
RLS `INSERT` policy. It is not a theoretical concern: it requires no attacker at all, only two
real, textually-similar wines.

---

## 1. The central finding: the corroboration gate does not corroborate

### What I did

Confirmed live (via `pg_trgm.similarity`, the same function the gate calls) that two real, distinct
Bordeaux second-growth estates clear the reused threshold:

```
select similarity(lower('Chateau Pichon Longueville Baron'), lower('Chateau Pichon Longueville Comtesse de Lalande'));
 producer_sim
--------------
      0.55102
```

0.55 >> the gate's 0.3 producer floor. This matches the prompt's claim about the C24 finding —
I verified it directly rather than trusting the claim.

I then ran the actual attack through the actual code paths (script, deleted after the run, restored
repo state confirmed clean via `git status`/`git diff`):

**Path A — the real RPC, as two real signed-in tenants (`resolve_wine_variants_bulk`, 0099):**

1. Inserted two real `lwin_catalog` rows: Baron (`9100001`) and Lalande (`9100002`), both with
   correct, real producer/display_name text.
2. Tenant A calls `resolve_wine_variants_bulk` submitting **Lalande's own correct producer/cuvée
   text**, but Baron's `lwin7`. Result:

   ```json
   {
     "producer": "Chateau Pichon Longueville Comtesse de Lalande",
     "lwin7": "9100001",
     "identity_status": "lwin_verified"
   }
   ```

   The gate **accepted** it — no downgrade. `>>> GATE FAILED: mis-bound LWIN was accepted as
   lwin_verified — Lalande's text now owns Baron's LWIN.`

3. Tenant B (different tenant, never interacted with tenant A) later submits **Baron's own
   correct producer/cuvée text** with Baron's real `lwin7`. Because LWIN-exact deterministically
   wins over producer/cuvée text (by design), tenant B's import binds to the **same canonical row
   tenant A created** — a row whose producer field says "Chateau Pichon Longueville Comtesse de
   Lalande."

   ```
   Tenant A canonical_wine_id: 36e4353f-...
   Tenant B canonical_wine_id: 36e4353f-...  (same row)
   >>> HIJACK CONFIRMED: Tenant B's correct Baron import bound to Tenant A's
       Lalande-labeled row via LWIN-exact match.
   ```

This is exactly the cross-tenant identity-hijack chain D9's own migration comments describe as
the vulnerability being closed — except no attacker is required, only an honest mis-pairing
(which is also exactly what C24 says the *system's own matcher* produces).

**Path B — the raw RLS `INSERT` policy directly (0097), bypassing the RPC entirely:**

```
Direct insert (Lalande's own correct text, but a lwin7 whose catalog entry is Baron's):
ACCEPTED: {"producer":"Chateau Pichon Longueville Comtesse de Lalande DIRECT 2", "lwin7":"9100003","identity_status":"lwin_verified"}
```

`WITH CHECK` in `0097_canonical_wines.sql:139-151` admitted it directly — confirming the RLS
copy of the gate has the identical hole, independent of the RPC.

**Path C — the 0101 backfill's independent copy of the gate**, exercised by inserting a
pre-P2-style `wines` row (`wine_variant_id is null`, `lwin_id` = Baron's code, `producer`/`name`
= Lalande's real text) and running the actual `0101_wine_identity_backfill.sql` body directly
against the live DB (idempotent by its own design — confirmed only my one fixture row had
`wine_variant_id is null` before running it):

```sql
update _identity_backfill_norm n set lwin7 = null where ... not exists (...);
-- UPDATE 0   <- did NOT strip the mismatched lwin7
```

Resulting row: `producer='Chateau Pichon Longueville Comtesse de Lalande', lwin7='9300001'
(Baron), identity_status='lwin_verified'`. All three enforcement copies fail identically — they
are *internally consistent* (probe 2's "do they disagree" question: no, they agree, they're just
all wrong the same way, because they all inline the same 0.3/0.21 literals).

Cleanup verified: `git status`/`git diff --stat` clean after removing the two scratch scripts I
added under `scripts/local/_critic_*.mjs` and running them; all inserted `restaurants`,
`canonical_wines`, `lwin_catalog`, `wines`, `wine_variants`, and `auth.users` fixture rows deleted
by each script's own cleanup step, spot-checked via psql afterward.

### Root-cause confirmation (single-variable contrast, not a harness artifact)

Before finalizing, I re-attacked my own finding: could this be an artifact of my test setup
(wrong table, stale auth, a caching layer) rather than a real gate defect? Cheapest
discriminating probe: compute `similarity()` for the *existing passing* D9 test's fixture data
(`tenant-isolation.test.ts`'s "P2 D9 Garbage Import Co" vs. catalog producer "P2 D9 Real
Producer") side by side with my Pichon pair, using the exact same function the gate calls:

```
              case               | producer_sim | cuvee_sim
----------------------------------+--------------+-----------
 existing passing test (garbage) |     0.162162 |         0
 my Pichon case (real mismatch)  |      0.55102 |   0.55102
```

Same code path, same SQL clause, same three enforcement copies — the only variable between the
case that correctly fails (0.16/0, below the 0.3/0.21 floor) and the case that incorrectly
passes (0.55/0.55, above it) is the trigram similarity of the input strings. This rules out a
setup/harness artifact and confirms the root cause precisely: **the gate's only discriminator is
a similarity score against a threshold tuned for candidate ranking; any real pair of distinct
wines whose names cross that threshold defeats it.** This is not a one-line plumbing bug fixable
by patching the query — it's the wrong mechanism reused from a different problem domain (ranking
tolerates false positives; a permanent, cross-tenant, unforgeable-once-set identity claim cannot).

### Why the round-4 test suite didn't catch this

I read every test that was supposed to cover D9 and ran them live:

- `supabase/tests/0097_canonical_wines_lwin_corroboration.sql` test 2 ("a real lwin7 attached to
  non-corroborating producer/cuvee text is rejected") uses `'Totally Different Producer'` /
  `'Totally Different Wine'` against a catalog entry `'Chateau Corroboration'` — near-zero
  similarity. It never tests a realistic mis-pairing anywhere near the 0.3/0.21 boundary.
- `src/domains/identity/tenant-isolation.test.ts`'s dedicated D9 test uses
  `producer_raw: "P2 D9 Garbage Import Co"` against a real catalog producer `"P2 D9 Real
  Producer"` — again, obviously unrelated garbage, not a realistic near-threshold pairing.
- `supabase/tests/0099_resolve_wine_variants_bulk.sql`'s own header comment (lines 33-37) admits
  the fixture's `lwin_catalog` row was deliberately built with similarity **0.54/0.45 and
  0.42/0.39 to BOTH of that test's two submissions** — i.e., the test author already knew, and
  wrote down, that two textually different submissions can both clear this gate against the same
  catalog row. That fact was used to make a different assertion pass (LWIN-exact wins over minor
  spelling differences) rather than flagged as the corroboration gate's actual weakness.

So every test that name-checks D9 exercises only the "garbage forgery" half of the threat model
this migration's own comments describe (paragraph "closing BOTH forgery ... and mis-binding");
none exercises the "real wine, wrong wine" half, which is the half that's broken. I ran all five
of these live (after temporarily installing the `pgtap` extension, then dropping it — confirmed
`drop extension pgtap;` succeeded, leaving the DB as found) and confirm they all currently pass —
they are not broken tests, they are tests of the wrong scenario.

### Why this isn't a minor gap

Reusing `match_lwin`'s threshold was explicitly a **design contradiction**, not an oversight I'm
imputing after the fact. The untracked plan document every one of these migrations cites by
section number (`docs/plans/2026-08-23-p2-identity-spine.md` — see process note below) states in
§12, "What P2 deliberately does not do":

> "Does not touch `find_or_create_wine`, `find_or_create_wines_batch`,
> `match_lwin`/`match_lwin_batch`/`match_lwin_bulk` — C01 and C24's fixes belong to the audit fix
> lane. **P2's contract is that its own new functions don't repeat their mistakes, not that it
> repairs them.**"

D9's fix imports C24's exact broken threshold values into three brand-new pieces of code (a new
RLS policy, a new RPC, a new backfill) — the literal opposite of that stated contract. `match_lwin`
was tuned as a **ranking** threshold for a human/algorithm-reviewed candidate list, where a false
positive is tolerable (someone looks at the suggestion). D9 repurposes the same number as a
**hard security gate** governing a permanent, cross-tenant, unforgeable-once-set identity claim
with no repair path (`canonical_wines` has no UPDATE/DELETE policy). Those are different
correctness requirements; "reuse the already-tuned number" is the wrong move even though it reads
as responsible engineering in the migration's own comments.

### Coupling to P3

Per the brief: C24 is assigned to a different piece (P3) to fix at the matcher level. Today, P2's
security gate is calibrated against the exact threshold P3 is going to change. That coupling is
**not safe as currently built** — not because the number will change (a looser-to-stricter change
would only help), but because:

1. P2 has no test that would notice if P3's fix changes `match_lwin`'s constants without someone
   remembering to also touch the three hardcoded `0.3`/`0.21` literals duplicated across
   `0097`/`0099`/`0101`. There is no shared constant, view, or function — they're copy-pasted SQL
   literals in three files with no build-time link back to `0007_lwin_matching.sql`.
2. Even a fully correct P3 fix to `match_lwin` does not, by itself, fix P2's gate, because the
   underlying category error (reusing a ranking threshold as a security threshold) survives any
   number P3 picks unless P3's fix happens to also satisfy P2's much stricter correctness bar for
   a one-way, cross-tenant, permanent claim.

**What should happen when P3 lands:** P2 (or whoever owns this gate next) needs to revisit
whether *any* single fuzzy-similarity threshold is an appropriate replacement, independent of
what number P3 picks — and if a threshold approach is kept, it should not be a silent copy of
`match_lwin`'s value, but a deliberately chosen (and probably much stricter, likely
paired-with-manual-confirmation-for-anything-below-near-certainty) value, verified against
adversarial real-world near-duplicate producer pairs the way I did here, not just against
"garbage vs. real."

---

## 2. Other directed probes

### Probe 1 — can the golden-vector test fail?

Yes, correctly. `src/domains/identity/normalize.test.ts`'s two "frozen, no sibling dependency"
tests each assert `expect(goldenVectors.*.length).toBeGreaterThan(0)` before iterating — this is
not an empty-array-passes-trivially shape.

Verified by mutation: backed up
`src/domains/identity/__fixtures__/normalization-golden-vectors.json`, emptied both arrays, reran
`npx vitest run src/domains/identity/normalize.test.ts` — both frozen-vector tests failed
(`AssertionError: expected 0 to be greater than 0`), 17 other tests in the file still passed.
Restored the file from backup; `git status`/`git diff` on the file confirmed byte-identical, no
diff.

Coverage: 17 producer/cuvée vectors (possessive apostrophes, curly vs. straight quotes, period
abbreviations, accent stripping, œ/æ ligature folding, word-order invariance, real Bordeaux/
Burgundy/Spanish producer names) and 7 vintage-text vectors (NV, roman numerals, "circa 1998",
"'98", "202X", "not sure", "19-something"). This is a real, non-trivial adversarial slice, not an
easy subset — though it is hand-picked by the same team that wrote the normalizer, so it proves
"doesn't regress on known-hard cases," not independent adversarial coverage.

### Probe 2 — three copies of one gate

The three copies (`0097` RLS policy, `0099` RPC pre-insert step, `0101` backfill) use identical
literal thresholds (`0.3`, `0.21`) and identical `exists`/`not exists` shape against
`lwin_catalog`. I could not construct an input one accepts and another rejects — they are
consistent with each other. (See §1: consistent, but consistently wrong.)

Confirmed `0099`'s downgrade behavior directly: ran a 3-row batch through
`resolve_wine_variants_bulk` where the middle row carried a `lwin7` with **no** matching catalog
row at all (pure garbage, not a mis-pairing). Result: `error: null`, all 3 rows returned, row 1's
canonical row landed as `{identity_status: 'unverified', lwin7: null}`, rows 0 and 2 succeeded
normally. The "downgrade, don't abort the chunk" claim holds for this case.

### Probe 3 — the backfill

Ran `0101_wine_identity_backfill.sql`'s actual SQL body directly against the live DB (idempotent,
scoped to `wine_variant_id is null`; confirmed exactly one such row existed before running: my
own fixture). It reproduced the identical mis-binding as the RPC and RLS paths (see §1, Path C) —
its gate is "genuinely equivalent" to the other two only in the sense that it shares their bug.
Cleaned up afterward; confirmed `select count(*) from wines where wine_variant_id is null` back to
0, and `canonical_wines`/`lwin_catalog` back to the counts they had before this probe.

### Probe 4 — regression on rounds 1-3

- `wines_variant_tenant_fk` is `on delete restrict` at this tip (`0098_wine_variants.sql:130-134`).
- Installed `pgtap` temporarily (`create extension pgtap;` — later `drop extension pgtap;`,
  confirmed dropped) and ran `supabase/tests/0098_wine_variants_restrict_safety.sql` live: all 4
  assertions pass, including the decisive forced-trigger-OID-reversal test (`ok 3`, `ok 4`) that
  proves RESTRICT survives even when the wines/wine_variants sibling CASCADE-delete triggers are
  forced to fire in the reversed order. The file wraps in `rollback;` — no state change.
- `down/0100_wine_identity_merge.down.sql`'s inlined `merge_wines` body: diffed against
  `0055_lineage_verify_fixes.sql`'s original function definition
  (`diff <(sed -n '/create or replace function public.merge_wines/,/^\$\$;/p' 0055...) <(same range in down/0100...)`)
  — **empty diff**, byte-identical. The round-1 failure mode this file's own header describes
  (claims to restore a function, contains no such SQL) does not recur here.
- Also ran `supabase/tests/0097_identity_spine_grants.sql` (14/14 pass, including the D4
  column-grant restriction), `supabase/tests/0097_canonical_wines_trgm_index.sql` (2/2 pass, GIN
  index actually used), and `supabase/tests/0100_merge_completeness.sql` (1/1 pass — every FK
  referencing `wines`/`canonical_wines`/`wine_variants` is named in `merge_wines` or
  `merge_canonical_wines`, "uncovered: none").
- `supabase/tests/0099_resolve_wine_variants_bulk.sql` initially failed 1 statement with
  `new row violates row-level security policy for table "wine_variants"` — traced this to the
  local stack's dev-login seed user (`devlocal@terroir.test`) not existing yet on this instance
  (this test's fixture reuses that seed user by design, per `docs/runbooks/local-stack.md`). Ran
  `node scripts/local/seed-local.mjs` (idempotent, local-only, matches the documented bring-up
  procedure) and reran: all 11 assertions pass. This was an environment gap on my part, not a
  code defect in P2.

### Probe 5 — the flakes

Could not independently verify the specific claim ("two test files failed once under concurrent
load, passed in isolation, unmodified") — the round-4 builder report that names them lives outside
this git tree (in another session's scratchpad, not committed to this repo or branch; confirmed
via `git log --all` that no such report file is tracked). I ran the four live-DB "MANDATORY"
identity/tenant-isolation suites that are the most likely candidates
(`src/domains/identity/tenant-isolation.test.ts`, `src/domains/identity/merge.test.ts`,
`src/domains/import/tenant-isolation.test.ts`, `src/lib/jobs/tenant-isolation.test.ts`) three
times — twice individually, once together under vitest's default concurrent file execution — and
observed zero failures each time (28, 28, 16 tests passed). This doesn't contradict the "flaked
once" claim (a rare race wouldn't necessarily reproduce in 3 runs) but I cannot confirm it either.
Flag as **unverified, not confirmed**, rather than accepted on trust.

---

## 3. Process finding (not scored, but load-bearing for traceability)

Every migration in 0097-0101 cites `docs/plans/2026-08-23-p2-identity-spine.md` by section number
(§0, §1, §3, §5, §6, §8, §9, §12, §14) as its design rationale. That file **does not exist
anywhere in the `terroir-vw` worktree's git history** (`git log --all -- <path>` returns nothing
on this branch or any other). It exists only as an **untracked** file
(`git status --porcelain` shows `??`) in a sibling checkout of the same repo,
`/Users/zero/projects/terroir/docs/plans/2026-08-23-p2-identity-spine.md` — never committed to
any branch. I was able to read it (and used §12 above), but only because that stray working copy
happens to still be on disk; a fresh clone or a cleaned working tree would make every one of these
citations a dead reference. This should be committed to the branch it documents.

---

## 4. The single largest remaining gap

**The corroboration gate reuses a ranking threshold as a security threshold, and no test in this
round exercises the boundary where that category error actually bites.** Every test written
against D9 — the dedicated pgTAP regression file, the dedicated vitest RPC test, even the fixture
comment in `0099`'s own test file that explicitly computed similarity scores for its fixture data
— stops at "garbage text is rejected" and never asks "what about a real, different, similar-named
wine?" That is precisely the question this round's brief asked first, and it breaks on the first
real pair tried (Pichon Baron vs. Pichon Longueville Comtesse de Lalande), live, through both
enforcement paths that matter (the RPC tenants actually call, and the RLS policy protecting direct
inserts), and through the backfill's independent copy. This is the same failure shape called out
in this run's history — a fix accepted on the strength of a test that was never pointed at the
case that mattered — recurring at a different layer (SQL literal reuse instead of always-true
conditions or skipIf no-ops).

---

## Appendix — commands / evidence trail

- Similarity check: `psql -c "select similarity(...)"` → `0.55102`
- Attack script (RPC + RLS paths): written to `scripts/local/_critic_pichon_attack.mjs` inside the
  worktree (required for `@supabase/supabase-js` module resolution), run via
  `node scripts/local/_critic_pichon_attack.mjs`, then deleted; `git status`/`git diff --stat`
  confirmed clean afterward.
- Chunk-abort probe: `scripts/local/_critic_probe2_chunk.mjs`, same pattern, deleted after use.
- Backfill probe: raw `psql -f supabase/migrations/0101_wine_identity_backfill.sql` against a
  hand-inserted pre-P2-style fixture row, then manual cleanup via `delete` statements, verified
  row counts back to pre-probe baseline.
- Golden-vector mutation test: backed up/emptied/restored
  `src/domains/identity/__fixtures__/normalization-golden-vectors.json`;
  `npx vitest run src/domains/identity/normalize.test.ts` before/during/after.
- pgTAP: `create extension pgtap;` → ran `supabase/tests/0097_*.sql`, `0098_*.sql`, `0099_*.sql`,
  `0100_*.sql` via `psql -f` → `drop extension pgtap;`.
- Dev-login seed: `node scripts/local/seed-local.mjs` (idempotent, local-only).
- No `supabase db push`/`link`/`db reset` run. No production host contacted. No git commits made.
  No other worktrees touched. `terroir-vw-local` stack left running, unmodified in schema (down
  migrations were reviewed/diffed statically, not executed against the live stack, to avoid
  disrupting shared state — the one exception, `0098`'s restrict-safety pgTAP file, wraps itself
  in `rollback;`).

---

## ADDENDUM — a round-5 fix began landing, uncommitted, while this audit was still in progress

While finishing this report I re-ran `git status`/`git diff` (my normal end-of-session cleanliness
check) and found the working tree **no longer clean**, despite my having made no edits of my own
to any migration file:

```
 M supabase/migrations/0097_canonical_wines.sql
 M supabase/migrations/0099_wine_identity_resolution.sql
 M supabase/migrations/0101_wine_identity_backfill.sql
```

I did not author these changes — I never called Edit/Write against any of these three files this
session. I confirmed this is a real, external, currently-active process rather than a tool error
or something I triggered indirectly:

- The diffs themselves are self-describing: their new comments explicitly cite
  `scratchpad db-audit/verify/P2-critic-r4.md` (this report's own path, mid-write) and quote my
  exact reproduction — the 0.55 similarity value for Pichon Baron vs. Comtesse de Lalande, the
  two-tenant hijack narrative, even the phrase "no attacker cleverness... needed."
- Polling the file mtimes twice, three minutes apart, showed the diff *growing* — `0097` first,
  then `0099` newly modified, then `0101` newly modified on the next check — consistent with an
  active agent working through the three-copies structure this report's Probe 2 described, not a
  one-shot artifact.
- No process I ran (vitest, psql, the two throwaway scripts, `pgtap` install/drop, `seed-local.mjs`)
  touches these three files. I did not run `supabase db reset`, `db push`, `db diff`, or any
  migration-generation command.

**What the in-progress round-5 diff appears to do** (read, not verified — see below): replaces the
round-4 `pg_trgm similarity()` threshold with a new `identity_normalize_text()` SQL function
(unaccent + lowercase + token-sort, mirroring `0101`'s existing normalization) and switches the
corroboration check from a similarity *score* to *exact equality* of normalized text — which would
indeed separate "Baron" from "Lalande" (different token sets) while still tolerating pure
formatting differences (accents/case/punctuation) for a genuine data-entry variant of the *same*
wine. It also adds a new table-level `CHECK` constraint
(`canonical_wines_lwin7_requires_verified`: `lwin7 is null or identity_status = 'lwin_verified'`)
that the comments say closes a **second, separate hole** the round-5 author says they found: an
`unverified` row could squat a real `lwin7` with the corroboration check never running at all,
because round 4's gate only guarded the `lwin_verified` insert branch and `0099`'s phase-1
LWIN-exact match had no `identity_status` filter — meaning a squatted `unverified` row would still
capture every later legitimate import of that LWIN, corroboration or not. If real, that second hole
is at least as severe as the one this report centers on, and I have **not verified it myself** —
I'm relaying what the in-progress diff's own comments assert, not a finding I reproduced.

**What I did about it: nothing to the files, by design.** This worktree and its uncommitted state
are not mine to adjudicate mid-flight:

- I did not revert, stash, checkout, or otherwise touch these three files.
- I did not commit them (I was never going to; I'm the critic).
- I did not attempt to evaluate or test the in-progress round-5 logic — it is unstaged, was still
  changing while I watched it, and evaluating a moving, uncommitted target would not produce a
  reliable verdict. It is also out of this task's assigned scope (tip `08a665c`).

**My verdict above (DOES-NOT-MEET) stands, unchanged, and is scoped exactly as assigned: tip
`08a665c`.** That is the artifact I was asked to audit, and it is what I tested. The round-5
changes I'm describing here did not exist, committed or otherwise, at the point where I ran every
test in this report — I confirmed the repo was clean at `08a665c` with no diff at multiple points
earlier in this session, before this uncommitted activity appeared near the very end.

**Recommendation to whoever reads this next:** once round 5 is committed, it needs its own fresh,
independent critic pass — ideally not a continuation of this same session, both because
independence is the point of this process and because I have already seen (and now partially
described) the fix's own reasoning, which would bias rather than sharpen a re-review. Two things
that pass should specifically re-check, based on what I could see of the in-progress diff:
1. Does `identity_normalize_text()`'s token-sort-based equality reopen any of the normalization
   collision classes `src/domains/identity/normalize.test.ts` already guards against in
   TypeScript (e.g. the D3 possessive-apostrophe collision) — since it's a *new*, independent SQL
   implementation of similar logic, not a call into the existing TS function or `0101`'s exact
   temp-table SQL?
2. Is the new `canonical_wines_lwin7_requires_verified` CHECK constraint's own claimed second
   vulnerability (the "unverified-squat" path) real and actually closed — that needs the same
   live, adversarial reproduction this report gave D9's original threshold, not a read-through.
