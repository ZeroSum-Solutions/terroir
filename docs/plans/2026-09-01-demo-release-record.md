# Demo release record — 2026-09-01 (for the 2026-09-02 demo)

**Status:** FINAL — every item below landed, deployed and verified on 2026-09-01/02 UTC
**Scope:** everything landed, deployed and verified tonight to get Terroir to demo quality
**Deploy contract:** merging to `main` deploys the same SHA to Railway production and
staging; migrations are applied by hand (`docs/runbooks/production-migrations.md`).

## 1. Chosen approach

The demo runs on **both surfaces**, as decided: the in-depth walk on the local stack's
seeded tenant (LOCAL SEED - Osteria Scala: 252 wines, 250 label photographs, all
corpus-linked), and the deployed app for "it is live" on production's DEMO tenant.
Production got the schema it was missing (0145, 0146, and a new 0147) and the
LWIN ↔ X-Wines linkage run the owner approved; the code path got the fixes the browser
audit and the adversarial review surfaced. Invoice scanning stays out of the live script
until Azure Document Intelligence exists again (#116). Authenticated passes on production
and the competitors could not run: 1Password never connected on this machine.

## 2. What changed (all on `main`, all deployed)

| PR | Change | Why it matters tomorrow |
|---|---|---|
| #183 | Scans page knows the `review` status (chip + All count) | Scan history no longer miscounts |
| #184 | Bottle-scan one-tap Confirm disabled on unidentifiable results | A non-wine photo cannot commit garbage |
| #185 | Full-E2E workflow seeds the production-shaped tenant | The nightly suite stops failing on a missing fixture (#158) |
| #186 | Search API returns a vocabulary-free companion hint; palette offers "Ask the companion" above results for price/pairing queries | "something under $40 for fish" now has a path instead of 16 noise rows |
| #187 | Migration 0147: `lower(name)` trigram index on `xwines_catalog` | Corpus search on production: 1,459 ms → 244 ms (measured) |
| #188 | Demo cellar inventory filed by colour and origin, not round-robin; shared section rule | `/cellar` opened on "Sparkling" holding a red |
| #189 | Seed statuses in the app's vocabulary; no invented guest-menu names; dev-only API error logging; dev-local.sh key warning; runbook rewritten | Scan chips read 60/56/4 not 0; guest menu shows Pol Roger not "Trellis Road Reserve Pour"; a local 500 says why |
| #190 | Deterministic miss corpus (180 cases) + measurement module + ratchet + report; five parser bugs fixed | Evidence for the tier-2 decision; "no reds tonight" no longer filters to reds |
| #191 | Review follow-ups: bottle-scan Confirm also disabled when producer AND wine name are both flagged; regression pin that the companion hint is whole-token (no "porto"→"pork"); corpus case gat-14 corrected and re-measured (98 answered, 0 missed); runbook operational lines | Closes the B-class items from the final review |
| #192 | Guest-menu override fixture: the seed slot keeps the owner's "Reserve Pour" wording and the list fixer renames its producer half to the real producer instead of clearing it; spec asserts the wording | Repairs the one full-E2E failure tonight's #189 caused, without putting an invented name back on the menu |

PR #189's first CI run failed two Playwright specs (invoice journey, pour flow) with
an HTML 404 from the dev server; the identical served code passes on `main`, the
spec passes locally against #189's tree, and the re-run passed unchanged — a runner
flake, recorded rather than hidden.

The local demo database was corrected in place with the same scripts the seeders now
use: 335 inventory items re-filed by colour, 60 scan statuses rewritten to the app's
vocabulary, 12 seeded "Reserve Pour" name overrides cleared. Do not re-seed before the
demo (runbook).

Production database, applied by hand per the runbook (backup 12:14 UTC verified; each
migration dry-run in a rolled-back transaction, then one transaction with its
`schema_migrations` row; objects verified after):

- `0145_lwin_xwines_links` — link, run and tombstone tables, read policy, grants
- `0146_xwines_search` — the RPC the deployed search route had been calling into a void
- `0147_xwines_catalog_name_lower_trgm_index` — 2.1 s to build
- Linkage run `f883e605` against production (22:41 → 23:23 UTC, rule
  `lwin-xwines-linkage/3`): 211,498 LWIN rows decided — **16,194 accepted, 13,738
  review, 181,566 abstained** (identical to the local rehearsal run 07bc54ff, as the
  corpora are identical); 0 tombstones; `canonical_wines.xwines_wine_id` propagated to
  4 of 665 rows (only four production canonical rows carry an LWIN id that resolved
  to an accepted link — the tenant cellars' own identities are the WS-IDENT P1 problem,
  not this run's). Report: `docs/plans/ws-ident-runs/2026-09-01-f883e605/report.md`.
  No active sessions left behind; 12 idle pool connections, all the app's own.

## 3. Verification evidence

- PR gate (18 gates) green on every merge; the full local gate set (tsc, eslint, vitest,
  design, file-size, control-rows, api-contract, feature-ledger, product-conformance,
  downs, manifest, snapshot, eval:vwp) run and green on each branch before landing.
- Browser audit, local demo tenant, 375 px and a 1280 px measurement: insights, cellar
  list, palette (`esporao`, `a crisp white from Portugal`, `2016 douro`, `pol roger`,
  `something under $40 for fish`), companion (`a bold red that pairs with beef` → 74),
  wine detail (Esporão Reserva Tinto: label, structure, pairings, vintage table), LWIN
  catalogue page, public guest menu, bins, lists, scan, scan history, reconcile queue,
  atlas, team. API probes via dev-login cookie for the same queries.
- Deployed smoke, production, unauthenticated: `/login` 200, `/api/health` ok at the
  merged SHA, `/list/demo-full-list` and `/list/demo-by-the-glass` 200, `/api/search`
  and `/api/assistant` 401 without a session, `/cellar` → `/login`. Staging smoke
  workflow green on the last merge.
- Production `xwines_search` EXPLAIN before/after 0147: 1,459 ms → 244 ms
  (`esporao reserva`), 83 ms (`pol roger`).
- After PR #190's parser fixes reached `main`, the demo-script queries were re-probed on
  the updated local server: unchanged answers for the search box (20 Portuguese
  whites; vintage-filtered Douro; Esporão first; companion hint on the price/pairing
  query) and the companion (74 beef reds; the Argentine Malbec; Narnia and "isn't
  cabernet" reported as not understood).
- Code SHAs `3aa37fa0` (PR #191) and the final `1512c3f9` (PR #192) deployed to
  production and staging, `/api/health` ok on both.
- **Full E2E workflow on `3aa37fa0`: 44 passed, 22 failed, 27 skipped** (run
  33571734965; before tonight: 42 / 23 / 28). The production-shaped fixture now seeds
  in CI (PR #185), so the specs get past `enterProdShape()` and fail further in, on
  things the CI database does not hold: label imagery in storage ("no wine image on
  screen"), the X-Wines corpus, and bottle placements ("no bin on /bins holds any
  bottles"). Those are CI-fixture gaps, not product regressions — every one of those
  journeys was walked by hand tonight on the local stack, which has all three. One
  failure WAS caused tonight: the guest-menu override spec lost its seeded fixture when
  #189 cleared the invented "Reserve Pour" names; PR #192 restores the seed
  slot and renames the producer half to the real producer instead (spec passes locally
  against the demo tenant). The 22 → real-coverage gap is tracked by the open issues
  #158 and #99; closing it means seeding a small imagery/placement fixture in CI or
  self-skipping those assertions when the corpus is absent.

## 4. Grok 4.6 review — findings and dispositions

Two passes, both via OpenRouter `x-ai/grok-4.6`, prompts and outputs kept in the
session scratchpad.

**Path review (before work started).** Ranked P0–P2. Dispositions:

| Finding | Disposition |
|---|---|
| Do not run the linker on production tonight; unbundle 0145/0146 | **Overruled by the owner's explicit, informed answer** ("migrations + linkage run"). Applied per runbook; recorded as accepted risk. Linker writes only the three 0145 tables and propagates `canonical_wines.xwines_wine_id` where null. |
| Use the direct URI, not the transaction pooler; dry-run locks | Vault URL is the **session** pooler (DDL-safe); dry-runs rolled back in seconds; no `CONCURRENTLY` in 0145/0146 (checked before `--single-transaction`). |
| EXPLAIN the 0146 RPC | **Supported and acted on**: `lower(name)` half seq-scanned 100,646 rows (1,459 ms on production). Migration 0147 added the missing index; 244 ms after. |
| Four auto-landing PRs = four production deploys; freeze after one verified SHA | Adopted as a freeze **after** verification rather than a total freeze (the request asked for fixes, merges and deploys). Every merge passed the 18-gate check; both environments verified at the final SHA. |
| Companion hint (d) is demo risk | Reviewed in the final pass: vocabulary-free, token-equal, additive strip above results; false-positive class is an extra strip, never a wrong row. Kept. |
| Deployed product ≠ runbook; decide the exact production tenant | Runbook now scripts both surfaces and names DEMO — Osteria Dimostrativa (not My Restaurant). |
| Invoice scan dead; "owner will provision Azure" is not a plan | Invoice scan cut from the live script; bottle scan is the scan beat. |
| Hotlink stampede | Palette shows only `label`-kind corpus images (514 on production); detail pages one image each. Low. |
| Per-image kill switch missing | **Confirmed not implemented** anywhere in `src`; deferred and recorded (§7). |
| 100k professional images | Told the owner plainly; recorded in §7. |
| Do not touch `staging` | Kept. |

**Final review (after landing).** Verdict: "conditionally ready for a local investor walk;
not a production-release verdict". No A-class code defect. Dispositions:

| Finding | Class | Disposition |
|---|---|---|
| Companion hint false positives ("porto" vs "pork") only if the matcher is substring-based | B | Matcher is token-equality (`phraseWordIndex` over normalised words); regression test pinned tonight. |
| Bottle-scan Confirm floor 0.1 is weak; all-but-one identity field flagged still confirms | B | Identity-field rule tightened tonight: producer + wine name both flagged disables one-tap Confirm regardless of vintage. Floor left at 0.1 deliberately: a real label at moderate confidence must not be blocked in the room. |
| Handler dev logging could print provider error objects | B/C | Dev-only, redacted client envelope unchanged; "do not debug-scan on the big screen" added to the runbook. |
| Re-seeding from a tree without #189 brings the fake menu names back | A (operational) | #189 landed; runbook says do not re-seed before the demo. |
| `railway variables` in the room; key export before starting | A (operational) | Runbook: export before the room, or add the key to `.env.local` (the production-credential file). |
| No authenticated production pass | A (operational) | Could not be done from this machine (1Password not connected). Presenter logs in once before the room; stays local if it fails. |
| Old World set: Serra Gaúcha is Brazil → New World | C | `wine-sections.mjs` classifies by colour, then reds by an explicit Old World country set; Brazil is not in it, so Serra Gaúcha files under Reds - New World (verified in the fixed cellar: 43 New World reds). |

## 5. Deterministic miss corpus (PR #190)

The evidence the tier-2 ops spec (§6 decision 4) asked for before any provider call is
built: `src/lib/wine-intelligence/fixtures/deterministic-miss-corpus.json` — 180
hand-written queries across six lenses (sommelier at service, guest at table,
buyer/manager, colloquial and typos, occasion/comparative, multi-constraint), each with
the struct a perfect parse would produce — measured against BOTH deterministic parsers
with the demo tenant's real vocabulary, offline and deterministic
(`npx tsx scripts/measure-deterministic-misses.ts`). Report:
`docs/plans/2026-09-01-deterministic-miss-corpus.md`.

| classification | count | share |
|---|---|---|
| answered (every expected field) | 98 | 54.4% |
| partial | 26 | 14.4% |
| tier 2 — paraphrase only ("zippy", "easy sipper", "champers") | 9 | 5.0% |
| tier 3 — occasion / comparative / open question | 45 | 25.0% |
| missed | 0 | 0.0% |
| wrong (a parser contradicting the query) | 0 | enforced by the acceptance test |
| known wrong, excused with a reason on the case | 2 | postposed negation; a price comparator regex |

A ratchet test pins these (answered may not fall, wrong must be 0, missed + tier 2 may
not rise). Building the corpus found and fixed **five real parser bugs**, each with its
own failing test first: the search parser had no negation handling ("no reds tonight"
filtered TO reds); trailing punctuation broke every gazetteer and vintage match
("Rioja," parsed as nothing); "$100" was read as the "100%" single-varietal idiom;
"another"/"too" ended a negation walk one step short and "nothing"/"nothin" were not
negation words; "cured meats" fell through to the generic meats pairing. Two skeptic
agents then re-ran the parsers independently on 20 cases each to refute the
classifications: skeptic 1 refuted none of 20 answered/partial cases; skeptic 2
refuted one — "a port for after dinner" was listed as missed only because the
fixture expected the type "Fortified", a word the assistant's type vocabulary does
not contain (it answers "Dessert/Port"). The case was corrected and the corpus
re-measured in the follow-ups PR: 98 answered, 0 missed; baseline ratcheted to the
measured counts. Both skeptics also noted two design choices worth knowing when
reading the table: a negation-only query with no concrete field counts as
"answered" when the parser asserts nothing (a deliberately low bar), and pairing is
scored on a non-empty intersection, not equality.

**What it says about tier 2.** The residual a provider could recover is the 9 tier-2
cases plus the paraphrase halves of some partials — roughly 5–10% of realistic queries.
The 25% tier-3 block (occasion, comparison to another wine, open questions) is not
struct-compile work at all. That is the decision input; the decision itself stays with
the owner.

## 6. Branches

**Merged tonight (all squash-merged to `main` through the 18-gate check):** #183, #184,
#185, #186, #187, #188, #189, #190, #191, #192, plus the docs PR carrying this record. Each
PR's branch was deleted by the landing tool on merge.

**Executed 2026-09-02 ~00:05 UTC.** Local: sixteen branches deleted (seven with git's
own merged check, nine squash-merged tips with the explicit force the request
authorised). Remote: seven heads deleted. The remote now holds `main` and `staging`
only; local holds `main`.

**Stale branches deleted (each fully merged, no unique commits, unprotected, no open
PR).** The rule applied: a branch is deleted only when its tip is exactly the head of
a merged PR, or it is an ancestor of a branch that was merged that way, or it is an
ancestor of `main`. `feat/xwines-corpus-and-labels` (merged as #163) was already gone
from the remote.

| Branch | Where | Tip | Evidence | Decision |
|---|---|---|---|---|
| chore/refactor-prep-docs | local | 0c0bc756 | merged PR #152 head 0c0bc756 (tip == PR head) | delete |
| chore/tidy-post-refactor | local+remote | 69be62c8 | merged PR #160 head 69be62c8 (tip == PR head) | delete |
| feat/identity-resolution-on-write | local+remote | 0f107e85 | merged PR #157 head 0f107e85 (tip == PR head) | delete |
| fix/backfill-blank-producers | local+remote | cc6369bb | merged PR #161 head cc6369bb (tip == PR head) | delete |
| fix/wine-ownership-write-policies | local+remote | 9989a0e6 | merged PR #154 head 9989a0e6 (tip == PR head) | delete |
| phase0/adapter-contract-tests | local+remote | 84f1a884 | merged PR #155 head 84f1a884 (tip == PR head) | delete |
| phase2/integration | local+remote | a8b1d285 | merged PR #156 head a8b1d285 (tip == PR head) | delete |
| phase2/cellar-list | local | c11a07d7 | contained in phase2/integration (merged as #156) | delete |
| phase2/import-client | local | ee4b331e | contained in phase2/integration (merged as #156) | delete |
| phase2/insights | local | 9bdf8b3a | contained in phase2/integration (merged as #156) | delete |
| phase2/price-comparison | local | 3d697eed | contained in phase2/integration (merged as #156) | delete |
| phase2/scan-views | local | 144c95be | contained in phase2/integration (merged as #156) | delete |
| phase2/team-and-landing | local | d8073455 | contained in phase2/integration (merged as #156) | delete |
| phase2/wine-list-editor | local | f223d020 | contained in phase2/integration (merged as #156) | delete |
| phase2/wine-detail-drawer | local | 33ef6ffa | contained in phase2/integration (merged as #156) | delete |
| probe/worktree-feasibility | local | 8c777d57 | ancestor of main (0 unique commits) | delete |
| staging | remote | a94b196a | 208 unique commits, no PR | KEEP |

`staging` (remote, 208 unique commits, no PR) is untouched: it is not merged and it is
referenced by open issue #108.

## 7. Remaining demo risk

- Azure Document Intelligence is still gone (#116): do not scan an invoice live.
- `ANTHROPIC_API_KEY` must be exported before `dev-local.sh` or bottle scan 500s (runbook).
- No authenticated pass on production tonight (1Password not connected). Log in once
  before the room and open DEMO — Osteria Dimostrativa, not My Restaurant.
- Per-image kill switch from the imagery risk memo is not implemented; corpus images
  have been served from production since the hosted seeder ran.
- Every LWIN row does not have a professional label photograph and cannot by tomorrow:
  no open licensed source exists at 211k scale; the X-Wines set covers the corpus with
  honest label / producer / representative captions.

## 8. Addendum — model-provider cutover to OpenRouter (2026-09-01, after §7)

Asked after the record above was written: route the app's model calls through a
gateway with access to more than one vendor. Done on branch `feat/openrouter-gateway`.

- **Shape.** The Anthropic SDK stays; only its base URL moves to OpenRouter's
  Anthropic-compatible Messages endpoint (`src/lib/ai/anthropic-client.ts`). Probed
  live before the change with the project's own SDK: Zod structured output on
  Sonnet 5 and Haiku 4.5, `effort` honoured (thinking tokens rise low → high), an
  image call, plain `create` on Sonnet 4.5, and the same structured call answered by
  GPT-5 nano and Gemini 3.5 Flash Lite. A bad model id surfaces as the SDK's
  `BadRequestError`, so every route's error mapping holds unchanged.
- **Models.** Unchanged, re-addressed by OpenRouter id (`anthropic/claude-sonnet-5`,
  `anthropic/claude-sonnet-4.5`). No eval in the repo ranks another vendor above the
  current pins; a labelled bottle-reading comparison runs after this lands and any
  re-pin will be its own PR with the numbers.
- **Key.** `OPENROUTER_API_KEY` set on Railway production and staging (staging can
  now scan; it never carried the Anthropic key) and as the GitHub Actions secret the
  scoring workflow reads. `ANTHROPIC_API_KEY` remains on production, unread; the
  owner deletes it. The §7 item "export the Anthropic key before starting
  `dev-local.sh`" is gone: the shell carries the OpenRouter key from the vault, and
  `.claude/launch.json` now starts the preview through `zsh` so the same holds there.
- **Consequences to know.** Spend moves to the owner's OpenRouter credits. Photos and
  invoice text transit OpenRouter as well as the model vendor, and OpenRouter may
  serve Anthropic models via Bedrock or Vertex at its discretion; no provider pin in
  this change.

### 8.1 Grok 4.6 review of the cutover — findings and dispositions

Grok 4.6 reviewed the diff and said "do not ship" until five things were shown. Each
was checked live the same night; three produced code changes on the same branch.

| # | Finding | Evidence gathered | Disposition |
|---|---|---|---|
| 1 | The production key was never exercised; a bad paste or empty wallet 500s every model route | `railway run --environment production` with the stored variable reached OpenRouter (Haiku answered). Credits endpoint: **$8.35 remaining** of $231 at 03:30 | **Owner action: top up OpenRouter credits before the demo.** Code unchanged; a 402 maps to the SDK's generic `APIError`, which every route already turns into a friendly 502 |
| 2 | Unpinned routing could land Claude on Bedrock/Vertex without feature parity | Default routing measured: Sonnet 5 → "Claude Platform on AWS" (5/5), Sonnet 4.5 → Amazon Bedrock (3/3); every probe above ran there and passed. OpenRouter's endpoint list shows Google Vertex for the same models **without** structured outputs | **Fixed:** `provider: { require_parameters: true }` injected into every Messages request (`anthropic-client.ts`), so an endpoint lacking a requested parameter is never chosen. All four paths re-run live through the wrapper |
| 3 | 100 s SDK timeout × 2 retries behind the bottle route's `maxDuration = 60` | Pre-existing; `maxDuration` is a Vercel export and has no effect on Railway (the route's own comment says so) | Not changed; recorded |
| 4 | 402/429/5xx mapping | SDK maps by HTTP status: 429 → `RateLimitError`, 402 and 5xx → `APIError`; routes already handle both classes | No change; the real mitigation is #1 |
| 5 | Three of four product paths not live-tested after the cutover | Ran `extractFromOcr` (both profiles), `generateMenuThemes`, `enrichWinesWithClaudeBatch`/single through OpenRouter with the real modules | Invoice and enrichment passed. **Menu design was broken before the cutover:** `HexColorSchema`'s `.transform()` made the SDK's Zod→JSON-Schema converter throw before any request (unit tests mock that converter, so nothing caught it; `/api/brand-kit/propose` has been failing since the `.transform` landed in #73). **Fixed** with `.overwrite()` and a test that runs the real converter; four themes generated live afterwards |
| 6 | Enrichment reads `content[0]` and a thinking block may come first | Measured: Sonnet 5 via OpenRouter returns a `thinking` block first (2/3 calls); Sonnet 4.5 (enrichment's pin) returns text first (3/3) | **Fixed** anyway: text block selected by type, pinned by `enrich-claude.blocks.test.ts`, so a future re-pin cannot silently null every drink window |
| 7 | `parsed_output` null under load-balancing | Covered by #2 | — |
| 8 | Demo laptop launch path | The vault exports the OpenRouter key; the preview server started through the new launch config scanned a label successfully | No change |
| 9 | Floating model ids | `anthropic/claude-sonnet-4.5` is the only Sonnet 4.5 snapshot; contract test requires namespaced ids | No change |
| 10–11 | Prompt caching, `:batch` suffixes | Not used; no suffixes appended | No change |

CI note: the first run of PR #194 failed only at `types:check:local`, where the Supabase
CLI exited on a PostHog telemetry timeout with no drift printed; re-run.

### 8.2 Bottle-scan model re-pin (2026-09-02)

Landed after #194 as its own PR. A five-model screening and a like-for-like
confirmation on the shipped request shape (`docs/plans/2026-09-02-bottle-scan-model-eval.md`,
harness `scripts/eval-bottle-labels.ts`) moved `BOTTLE_SCAN` to
`google/gemini-3.7-flash` without `effort`: on 40 labelled corpus label images
producer 36 / name 40 / country 40 against Sonnet 5's 35 / 38 / 34 with one parse
error; on 16 degraded copies 14 / 16 / 16 against 12 / 13 / 13 with one parse error;
same latency, 40 % of the cost; the non-wine photo still gates Confirm through the real
route. `effort` is omitted because OpenRouter translates it into a parameter Gemini's
endpoints do not advertise, which under `require_parameters` left no eligible endpoint
(instant 502 in the route until removed). Invoice extraction, menu design and enrichment
keep their Claude pins — no evidence against them. Rollback is one string in
`src/lib/ai/models.ts`.

## 9. Demo-day moves (2026-09-02, after §8)

Asked for "the next five highest-leverage moves, done autonomously until green".
Chosen on evidence, not preference: Azure's endpoint no longer resolved from
production, and the production demo tenant had 42 wines with no colour, no section,
no corpus link and one scan stuck in "processing" since May.

| # | Move | Landed as | Evidence |
|---|---|---|---|
| 1 | Invoice scanning without Azure: the pipeline falls back to reading the photo with the vision model (`invoice-extraction-stage.ts`, `extractFromImages`), Sentry-visible, `INVOICE_VISION_FALLBACK=off` restores OCR-or-nothing; the SDK's structured-output parse failure maps to a 422 instead of a 500 | #196 | 7 fixture invoices through the real local route: 3 wine documents extracted (9, 9, 3 lines), 4 non-wine receipts answered "no wines" — no invented lines. Under production's own environment: the Astor receipt, 9 lines in 39 s |
| 2 | Production demo tenant made demonstrable (`scripts/polish-demo-tenant-hosted.ts`, dry run by default, every write only-where-empty) | this PR (script + docs) | 22 of 42 wines linked to the corpus (11 deterministic, 11 by model adjudication among the producer's own rows, each reason printed and read before applying); 42 colours; 6 section names and 41 bottles filed; 35 tasting excerpts written; the stuck scan settled as failed. The 22 pictures are producer/representative kind — production's corpus has 514 label-kind images in total |
| 3 | Demo assets and runbook: which fixture invoices extract cleanly, timings for both scans, the production tenant's new state | this PR | `docs/runbooks/investor-demo.md` § Scanning and § Two surfaces |
| 4 | Stalled scans settle: processing rows older than 15 min become failed / `stalled` when the scans page loads | #197 | Unit tests on the query shape; live on the local stack a 20-minute-old row flipped and a 2-minute-old one did not |
| 5 | CI: the Supabase types generator retries once on failure (it exited on a telemetry timeout with no drift printed and blocked #194) | #197 | Three tests on the injected runner |

Not done, and why: nothing was deleted (the demo tenant's "Test Producer / Test Wine"
row is junk and is left for the owner); the 20 picture-less demo wines have no corpus
row for their cuvée, and a wrong picture is worse than none; the public guest menus
render no images by design, so the pictures show in the cellar and detail pages.
