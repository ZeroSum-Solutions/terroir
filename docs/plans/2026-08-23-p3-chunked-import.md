# P3 — Chunked CSV Import: Duplicate Prevention, Re-upload Idempotency, Session Orchestration

Status: design only. No code, no migrations, no Supabase stack touched by this pass.

> **Migration-number reservation.** Tip on `main` (`225fbfb`) is `0076_csv_import_batches.sql`.
> Claimed ranges on in-flight branches: `0077`–`0096` (four `fix/db-audit-2026-08-23` lanes),
> `0097`–`0101` (P2, `2026-08-23-p2-identity-spine.md`). **P3 takes `0102`–`0111`.** Re-verify
> `ls supabase/migrations/ | sort | tail` against `main` and every live worktree immediately
> before creating files — this is exactly the failure mode `docs/runbooks/migration-numbering.md`
> documents from 2026-05-23, and three pieces are now writing migrations concurrently.

## 0. The decision and what it retires

Devin: *"I am completely open and happy to process in 4,000 or 5,000 row chunks. I think
that's actually a better idea."* This piece is built entirely on top of that decision, not
around raising `MAX_ROWS`.

**Retired, and why re-opening them would be a regression:**

- **Raising `MAX_ROWS` past 5,000.** Stays at `5000` (`src/domains/import/constants.ts:12`).
  The partner's ~20,050-row file ships as 4–5 batches of ≤5,000 rows each, applied exactly
  the way the app already applies one batch today — `apply_import_batch_chunk` in 100-row
  sub-chunks via repeated `POST /apply` calls (`APPLY_CHUNK_SIZE = 100`, already resumable).
- **A background worker.** The Railway worker service (`railway.worker.toml`, G1-6) is not
  deployed anywhere (`docs/runbooks/csv-import.md`). Chunking removes the reason to build it:
  every route handler in this piece still only ever touches ≤100 rows per call.
- **C31 (unchunked `revert_import_batch` times out at 20k rows).** V2-import.md measured
  the exact boundary: **5,000 rows → 1.60s**, **10,000 rows → 3.49s**, **20,000 rows → HTTP
  500 / 57014 (statement timeout)**. At ≤5,000 rows per batch this is comfortably inside
  Postgres's default statement timeout and the route's `maxDuration`. **C31 does not need a
  chunked revert loop.** It does need a *relaxed* status guard (§5, C-new-1) and a
  *session-level* orchestration layer (§3) — those are new work, not a revival of C31.
- **C02 (5MB byte cap).** V2-import.md measured a realistic 20k-row CSV at 1.81MB — the byte
  cap doesn't bind until ~55,000 rows. At ≤5,000 rows/chunk (~450KB) it is not a live concern
  and needs no change.

**What replaces them, restated from the charter (state.md, "DEVIN DECISION" entry) and
elaborated below:** (a) inventory-level duplicate prevention — effectively unimplemented
today, not merely chunk-unsafe; (b) re-upload idempotency — the genuinely new risk chunking
introduces; (c) a multi-batch onboarding session — grouping, progress, resume, revert-as-a-unit;
(d) six inherited per-row bugs that live in code this piece touches regardless of chunking:
C03, C09, C16, C18, C24, C10.

**One correction to the charter, stated plainly.** The charter frames C31 as fully "defused."
I agree it's no longer a blocker at the *individual-batch* level — the 1.60s/5k-rows number is
solid and I re-derive nothing new there. But I disagree that it's therefore irrelevant to P3:
`revert_import_batch`'s *other* guard — `status <> 'completed'` → hard reject — has a live gap
independent of row count (§5, C-new-1) that becomes materially more likely to bite with five
batches instead of one, and it directly blocks the "revert a session as a unit" requirement in
§3. I'm treating that as new P3-owned scope, not a re-opening of C31.

## 1. Duplicate prevention

### 1.1 What's actually missing, restated precisely

Verified independently against the live code (matches state.md's own investigation):

- **Wine-level identity dedup works and is batch-agnostic.** `apply_import_batch_chunk`
  (`0076_csv_import_batches.sql`, the `insert into public.wines (...) on conflict (restaurant_id,
  lower(producer), lower(name), coalesce(vintage, 0), size_ml) do update set ...`) is a
  database-level unique constraint (`wines_dedup_idx`, `schema.snapshot.sql:185`). It cannot
  care which batch a row arrived in. **No chunking regression here — confirmed, not assumed.**
- **`inventory_items` has zero unique constraints.** Confirmed against
  `supabase/schema.snapshot.sql:254-293`: three plain (non-unique) btree indexes
  (`restaurant_id`, `wine_id`, `invoice_scan_id`) plus a fourth added later
  (`inventory_items_bin_id_idx`). Nothing prevents two, or two hundred, structurally identical
  rows.
- **The insert is unconditional.** `apply_import_batch_chunk`'s `insert into
  public.inventory_items (...)` (0076) has no `on conflict`, no pre-lookup. One CSV row → one
  `inventory_items` row, every time, forever.
- **`buildImportPreview` (`src/domains/import/preview-service.ts`) does zero cross-row
  comparison.** Parse → validate → LWIN-match, row by row, independently. Confirmed by reading
  the whole file — there is no group-by, no accumulator, no lookahead.

So the correct framing is not "chunking breaks dedup" — it's "dedup at the inventory level
never existed, chunking just makes the five-uploads-instead-of-one shape more likely to expose
it, and the acceptance bar's 'duplicate prevention' dimension requires it regardless."

### 1.2 The nuance that rules out a blanket unique constraint

Two `inventory_items` rows for the same `wine_id` can be legitimate: `bin_location` and
`section` differ (the same wine held in two physical locations — a working cellar and an
overflow rack, say). A bare `unique (wine_id)` would reject real, correct data. The dedup key
must include location.

### 1.3 Exact vs. near duplicates — the P2/P3 seam, stated precisely

This is the most important boundary in this design, because getting it wrong either duplicates
P2's work or leaves a gap between the two pieces.

**P2 owns:** collapsing *text variance* into one wine identity — accents, casing, punctuation,
NFC/NFD, word order, and NV-literal detection (`src/domains/identity/normalize.ts`,
`resolve_wine_variants_bulk`, 0099). Two CSV rows spelled `"Château Margaux"` and `"Chateau
Margaux"` resolve to the same `canonical_wine_id`/`wine_variant_id` *before* P3's layer ever
sees them. **This is where "accented/NV/adjacent-vintage near-duplicates" get caught** — it is
explicitly a text-identity problem, not an inventory-row problem, and P2's own §6 states the
boundary the same way: vintage and size are never fuzzy-matched, only producer/cuvée text is,
and only to *suggest*, never to silently merge.

**P3 owns:** once two rows agree on **wine identity + physical location**, deciding whether
they're the same *inventory record*. That's a structural/set question (do these two rows name
the same (wine, bin, section) triple?), not a text-similarity question, and it operates strictly
*after* P2's resolution step. Concretely:

```
Two CSV rows are an EXACT duplicate (P3's problem) iff:
  same wine_variant_id (P2-resolved, or the pre-P2 fallback key — see 1.4)
  AND same normalized bin_location
  AND same normalized section

Two CSV rows are a NEAR duplicate (P2's problem) iff:
  they'd be the same wine_variant_id only after producer/cuvée text normalization,
  accent-folding, NV-literal collapsing, or word-order sorting
```

If P2 does its job, every near-duplicate the partner's file contains arrives at P3's layer
already collapsed to one `wine_variant_id` — P3 never needs its own fuzzy-text layer, and
deliberately doesn't have one. This is the direct answer to "distinguish exact from near and
say which layer catches which": **P2 catches near, by construction only P2 ever touches
producer/cuvée text; P3 catches exact, by construction P3 never compares text, only resolved
identity + normalized location.**

### 1.4 The identity key P3 actually computes, and the P2-dependency it has

At **preview time**, before any `wines` row exists, P3 needs a wine-identity key per row to
group on. Two modes:

- **With P2 merged:** call `resolve_wine_variants_bulk` (0099) once per batch of unique
  `(producer_norm, cuvee_norm, vintage, size_ml)` tuples — exactly the call P2's own §12 states
  is its interface to P3 ("called on a pre-deduplicated batch of unique variants before the
  existing per-row loop"). Use the returned `wine_variant_id` as the identity component of the
  dedup key.
- **Without P2 (P3 ships first, or independently):** fall back to the *same four-tuple the DB
  wine-upsert conflict key already uses* — `(producer.toLowerCase(), name.toLowerCase(),
  vintage ?? 0, size_ml)`, computed in TypeScript from the already-parsed `RawRowFields`. This
  is deliberately the exact same key as `wines_dedup_idx`, just evaluated pre-insert instead of
  as a DB constraint, so the two layers can never disagree about what counts as "the same wine"
  even before P2 lands.

Either way, the **location half** of the key is `(normalize_bin(bin_location),
normalize_section(section))`, where `normalize_bin`/`normalize_section` = `trim().toUpperCase()`
— the identical normalization the C11 fix sketch (V2-import.md) uses for its own `bins.code`
upsert (`upper(btrim(raw->>'bin'))`). This is a deliberate alignment: C11 is being fixed in the
audit lane (not P3's file), and once it lands, `inventory_items.bin_id` starts getting set from
the same normalized text P3's dedup key already uses — so the two keys agree the moment C11
ships, with zero coordination needed. **Named limitation, not hidden:** until C11 lands, this
key compares *text*, not `bin_id` — two spellings of the same physical bin that survive
`trim().toUpperCase()` differently (`"Bin A-1"` vs `"A1"`) will not be recognized as the same
location. See §7's residual-risk section — this is the largest data-quality unknown in this
design, and it can only be settled against the real file.

### 1.5 The decision procedure — three tiers, mirroring P2's own shape

1. **Intra-batch exact match → auto-merge, no operator involved.** Two (or more) rows *within
   the same batch* that share `(wine_identity_key, bin_norm, section_norm)` **and** agree on
   `unit_cost` **and** agree on `currency` are collapsed into **one** `import_batch_rows` record
   at preview/confirm time, with `quantity` summed. Requiring cost+currency agreement (not just
   wine+location) is deliberate: `inventory_items` has no per-lot cost tracking, so merging two
   rows with *different* costs would silently average or overwrite a real financial fact with no
   way to reconstruct it later. Rows that match on wine+location but disagree on cost/currency
   fall through to tier 3 instead of being auto-merged — this is a real "two lots, same bin" case
   and the safe move is to ask, not guess.

   *Why this is safe to do without a human:* the two source rows are provably from the same
   upload, the same operator action, the same instant — there is no cross-batch/cross-session
   ambiguity to resolve, and revert-cleanliness is preserved (see below).

2. **Cross-batch/cross-session match → surface, never silently merge.** If the resolved
   `(wine_identity_key, bin_norm, section_norm)` already has either (a) an **applied**
   `inventory_items` row from a *different, already-confirmed* batch (any session, including
   pre-existing manual inventory), or (b) a **not-yet-applied** row in a *sibling batch of the
   same session* (closes the TOCTOU gap described in §3.3 — chunks 1–5 may all be confirmed
   before any of them is applied) — the row is held out with **`resolution = 'pending'`**, the
   existing enum value, no new state invented. A new `duplicate_reason jsonb` column
   (§4, 0104) records what triggered it: `{type, matchedInventoryItemId | matchedRowId,
   existingQuantity}`, for the operator-facing UI to render "you already have 6 of this in bin
   A1 from batch #2 (applied 2026-08-23)."

   *Why surface instead of merge here:* merging quantity into an *existing* `inventory_items`
   row breaks `revert_import_batch`'s traceability contract (`applied_inventory_item_id` names
   the *one* row a *specific* `import_batch_row` created — a merged row would have absorbed
   quantity from two sources, and reverting one batch would then have to *decrement* a shared
   row instead of *delete* one it uniquely owns, which no code here does and which risks
   corrupting a quantity that also came from manual entry or a different batch). Surfacing costs
   the operator one click per genuine cross-batch duplicate; silently merging costs an
   unrecoverable revert.

3. **Human-confirmed resolution.** The existing `resolveImportBatchRow` (`batch-service.ts`)
   already handles this shape with zero changes needed: `include` (proceed — a genuine second
   lot, same bin) or `exclude` (drop it — a genuine duplicate). This is the same function that
   already resolves unmatched-LWIN and missing-cost rows; `resolution = 'pending'` now has three
   distinct *causes* (`lwin_status='unmatched'`, `cost_status='missing'`,
   `duplicate_reason is not null` — plus a fourth from §5/C16, `last_error_message is not
   null` for apply-exhausted rows), distinguished by which column is populated, not by a new
   enum value. The resolve endpoint's `action` parameter (`include`/`exclude`) is unchanged.

**Reject outright is explicitly not chosen for tier 2.** The brief names a real legitimate case
— restocking the same wine into the same bin is completely normal in a working cellar — and a
hard reject would make the importer actively wrong for that case. Surfacing preserves both
correctness and revert-safety, at the cost of some operator attention on a file the partner
already told us contains "intentional duplicates" (which will *mostly* resolve via `include`,
correctly).

## 2. Re-upload idempotency

### 2.1 The risk, restated

Re-*applying* is already safe: `apply_import_batch_chunk`'s eligibility filter
(`apply_status = 'not_applied'`) plus `for update skip locked` make repeated `/apply` calls
idempotent — confirmed, unchanged by this design. Re-*uploading* the same bytes is not: it goes
through `confirmImportBatch` → a brand-new `import_batches` row → every row `not_applied` →
the entire chunk's inventory gets created a second time the moment someone applies it. Five
chunk uploads instead of one gives the partner five independent chances to double-click, retry
a flaky connection, or resubmit "just to be safe" — and `import_batches` today records only
`filename` + `total_rows`, neither of which detects identical content.

### 2.2 The mechanism: hash the bytes, not the decoded text

Add `import_batches.content_sha256 text` (nullable — see §4 for why), computed **server-side,
over the raw uploaded `Buffer`, before `decodeCsvBuffer()` ever runs.** This ordering is not
incidental: `decodeCsvBuffer` (`csv-parser.ts`) does a *non-fatal* UTF-8 decode — any invalid
byte sequence silently becomes U+FFFD. P1's own round-5 fix (`validate-bulk-import.ts`,
`detectEncodingIssue`) treats this as a CRITICAL finding for exactly the reason it matters here
too: hashing *after* a lossy decode would let two byte-for-byte-different uploads (one with a
mangled encoding, one clean) collide on the same hash, or worse, let the *same* file hash
differently across two decode passes if decoding isn't perfectly deterministic. Hash the bytes
Node received on the wire, full stop — `createHash("sha256").update(buffer).digest("hex")`,
mirroring exactly how P1's own `detectEncodingIssue` inspects the raw buffer before decode, for
the same reason.

**Constraint:** `unique (restaurant_id, content_sha256) where content_sha256 is not null and
status <> 'reverted'` (partial, so historical rows with `content_sha256 = null` never collide,
and a reverted batch's hash is freed for a legitimate re-run). `confirmImportBatch` catches the
`23505` violation and — instead of a bare rejection — **returns the existing batch's id, status,
and counts**, so the client can offer "this file is already uploaded as batch `{id}`
(status: applying, 3,200/5,000 applied) — resume it?" rather than a dead-end error. This
directly answers the brief's question: **hard-reject the *create*, but surface enough
information that the operator/UI never actually dead-ends** — because resuming an
already-confirmed batch never requires re-uploading in the first place (apply is already
idempotent per §2.1), so a rejected re-upload never blocks legitimate progress, only prevents a
redundant one.

**The "genuinely needs to re-run a partly-failed chunk" case, resolved:** if the chunk is stuck
mid-apply, the fix is "call `/apply` again on the *existing* batch" (already resumable), not
"upload again." If the chunk is broken in a way that requires a truly fresh start (e.g., the
operator fixed a data error in the source and needs to replace the whole chunk), the sanctioned
path is **revert the existing batch first** (§5, C-new-1 relaxes the revert guard so a
partially-applied batch, not just a fully-completed one, can be reverted) — which frees the
hash, and *then* re-upload. No case requires bypassing the uniqueness check while the original
batch is still live.

### 2.3 What P1's manifest needs to supply, and where I disagree with the premise

The brief describes P1 as "building the splitter and a validating oracle right now" that emits
"chunk files + a per-chunk manifest with row count, byte size, sha256, row range." **I checked
this directly against the P1 worktree (`terroir-vw-p1` @ `7647c6b`, latest commit as of this
writing) and it does not match current reality**, and the gap matters enough to name precisely
rather than design around silently:

- `scripts/fixtures/generate-partner-cellar.mjs` generates **one** monolithic CSV file (plus
  `--extras`/`--dirty` variants) and **one** whole-file manifest (`total_rows`,
  `clean_row_count`, `dirty_row_count`, `csv_sha256`, `columns`, `dirty_rows`, ...). It does not
  split anything.
- `scripts/validate-bulk-import.ts` (the "oracle") re-chunks that **one** file's raw text into
  `MAX_ROWS`-sized groups **entirely in memory**, purely to call the real `parseCsv()` once per
  group and aggregate statistics — it **never writes a chunk file to disk**, and produces no
  per-chunk manifest of any kind (row range, byte size, or hash). `grep -n "writeFileSync"` on
  `validate-bulk-import.ts` returns zero relevant hits; there is no `--split`/`--write` mode.

So: **the "chunk files + per-chunk manifest" contract this design's §2 and §3 lean on does not
exist yet — it is a requirement I am placing on P1's next round, not an interface I am
consuming today.** state.md's own charter is consistent with this reading (under the
DEVIN DECISION entry: "R2 — a real splitter... a one-command path so the same split reruns
against the real CSV" is listed as new, not-yet-built work, and "R4 — the oracle must validate
the CHUNK PLAN, not just the file" is explicitly deferred to "See P1 amendment"). I am not
second-guessing that P1 *should* build this — I'm flagging that P3 cannot verify it against a
live artifact today, and stating the exact shape needed so the eventual contract test (below)
has something concrete to check.

**What I'm specifying P1 must emit, per chunk file:**

```jsonc
{
  "chunk_index": 1,            // 1-based
  "chunk_total": 5,
  "row_start": 1,               // 1-based, inclusive, in the ORIGINAL file's data-row numbering
  "row_end": 5000,               // inclusive
  "row_count": 5000,
  "byte_size": 471382,
  "chunk_sha256": "<hex>",       // sha256 of THIS CHUNK FILE'S RAW BYTES ON DISK
  "source_csv_sha256": "<hex>"   // sha256 of the ORIGINAL, PRE-SPLIT file's RAW BYTES — identical across all N chunk manifests of one split run
}
```

**The one correction P1's existing hashing convention needs, named explicitly because the brief
asked "is the sha256 P1 emits the right value, or must they agree on something else":**
`generate-partner-cellar.mjs`'s existing `sha256Hex()` hashes a **JS string** it just generated
in memory (`createHash("sha256").update(text, "utf8").digest("hex")`) — correct for that
context, since the string was authored directly and never round-tripped through a lossy decode.
A **splitter reading a real file from disk** must not repeat that pattern: it must hash the
**raw `Buffer`** read from disk (`createHash("sha256").update(readFileSync(chunkPath))`), never
a string obtained by decoding those bytes first — for the identical reason §2.2 hashes P3's
`content_sha256` before `decodeCsvBuffer` runs. If P1's chunk-level hash and P3's
`content_sha256` are computed on different representations of the "same" file, they will only
agree by coincidence (valid-UTF-8, no BOM quirks) and will silently diverge on exactly the
messy real-world files this whole exercise exists to handle. **`chunk_sha256` is the right value
for chunk-level re-upload detection — but only if P1 hashes bytes, not text.**

`row_count`/`byte_size` are informational (progress UI, sanity-checking a manual upload against
what the splitter promised) — P3 does not gate any logic on them beyond a soft warning if a
confirmed batch's actual parsed row count disagrees with the manifest's claim (a legitimate
data-integrity signal, not a hard reject, since it doesn't affect correctness on its own).

### 2.4 The pinning test this contract needs before either side can trust it

A shared, versioned fixture-based test (small, deterministic — e.g. a 23-row CSV split at
`MAX_ROWS=10` for a fast 3-chunk case, not the full 20k fixture) asserting, run from **either**
worktree against **both** implementations once they exist:

1. `chunk_total == ceil(total_data_rows / MAX_ROWS)`, and `MAX_ROWS` is read from the shared
   `constants.ts` export, never hardcoded, so this test stays correct after any future cap
   change.
2. Every chunk's `row_start`/`row_end` are contiguous and non-overlapping:
   `chunk[i].row_end + 1 == chunk[i+1].row_start`, and `chunk[last].row_end ==
   total_data_rows`.
3. Every chunk file's **first line** equals the original file's header line, byte-for-byte
   (header replicated into every chunk).
4. `source_csv_sha256` is **identical across every chunk's manifest** and equals
   `sha256(original_file_bytes)` computed independently by the test.
5. Each chunk's `chunk_sha256` equals `sha256(that_chunk_file's_bytes)` computed independently
   by the test (re-hashing the actual file on disk, not trusting the manifest's self-report).
6. Concatenating all chunk files' data rows (stripping the replicated header from chunks 2..N)
   reproduces the original file's data rows exactly, in order — the record-boundary-safety
   property (a quoted field with an embedded newline must never be split mid-record).
7. P3's session-creation endpoint (§3), given these manifests: accepts all N chunks into one
   session; rejects a chunk whose `source_csv_sha256` doesn't match the session's first chunk's
   value (wrong-file-mixed-in); accepts re-uploading a chunk with an identical `chunk_sha256`
   for the same `chunk_index` as a no-op pointing at the existing batch (§2.2's resume path).

This test is the actual deliverable that "pins" the contract — until it exists and passes on
both sides, P1 and P3 are each independently guessing at the other's byte-level behavior.

## 3. Multi-batch onboarding session

### 3.1 New table: `import_sessions`

One logical 20k-row onboarding = one session, grouping N `import_batches` rows.

| column | type | notes |
|---|---|---|
| `id` | uuid | PK |
| `restaurant_id` | uuid not null | `references restaurants(id) on delete cascade` |
| `created_by` | uuid | `references auth.users(id) on delete set null` |
| `label` | text | operator-supplied, e.g. "Partner cellar onboarding — Aug 2026"; optional |
| `source_sha256` | text | sha256 of the pre-split original file (§2.3); **nullable** — a session can exist without it if the operator's tooling doesn't supply one yet, degrading to "no cross-chunk source-consistency check," never a hard failure |
| `declared_chunk_total` | int | operator/manifest-supplied expected chunk count; `check (declared_chunk_total is null or declared_chunk_total > 0)`; informational for the progress UI, never a hard gate — a 6th corrective chunk must still be addable |
| `status` | text | `check in ('in_progress','completed','reverted')`, convenience projection like `import_batches.status`, recomputed after every batch state change — not independent source of truth |
| `created_at`, `updated_at` | timestamptz | standard |

RLS: same shape as `import_batches` — select/insert/update via `is_member`/
`is_member_with_role(restaurant_id, 'staff')`, no delete policy (permanent audit trail, same
posture as `import_batches` itself).

### 3.2 `import_batches` gains session context

New nullable columns (nullable because a plain, non-chunked, single-file upload — the common
case for a small restaurant's routine CSV — remains completely valid with none of these set):

- `session_id uuid references import_sessions(id) on delete set null`
- `chunk_index int check (chunk_index is null or chunk_index > 0)`
- `chunk_total int check (chunk_total is null or chunk_total > 0)`
- `content_sha256 text` (§2.2)

`confirmImportBatch` (extended, not replaced) accepts optional `{ sessionId, chunkIndex,
chunkTotal }` alongside the file. When `sessionId` is present: validate the session belongs to
this restaurant (RLS makes a foreign session's id simply invisible, same fail-closed pattern
0076 already uses); reject if another **non-reverted** batch in the session already claims the
same `chunk_index` (returning that batch's info, same resume-pointer pattern as §2.2); if the
session has a `source_sha256` and the client supplies one for this chunk, reject a mismatch
with a clear "this chunk belongs to a different source file" error.

### 3.3 Progress across all five batches, and the TOCTOU gap this closes

`GET /api/import/sessions/[id]` aggregates every child batch's `count_import_batch_rows` result
(§5, C-new-2) into one payload: total rows, applied, pending, eligible-not-applied, per-chunk
status list, `allChunksPresent` (a batch exists for every `chunk_index` in
`1..declared_chunk_total`, if declared), `allApplied`.

**The real reason this needs to be session-aware, not just batch-aware, is §1.5 tier 2's cross-
batch dedup check.** If the operator uploads (confirms) all five chunks before applying any of
them — a completely reasonable workflow ("stage everything, then go") — a wine appearing in
both chunk 1 and chunk 4 has **no applied `inventory_items` row yet** when chunk 4 is confirmed;
checking only *applied* inventory would miss it. The cross-batch check in §1.5 therefore queries
**both** applied inventory **and** not-yet-applied rows in sibling batches of the *same session*
— this is exactly what makes session-scoping load-bearing rather than cosmetic.

### 3.4 Reverting a session as a unit

New function `revert_import_session(p_session_id uuid) returns jsonb`, `security invoker`,
looping the session's batches **in reverse chunk order** (5, 4, 3, 2, 1) and calling the existing
per-batch `revert_import_batch` logic for each, with **per-batch exception isolation** (same
philosophy as `apply_import_batch_chunk`'s per-row exception blocks — one batch's revert failure
must never block the other four). Batches not in a revertible state (§5, C-new-1 relaxes this to
`applying` or `completed`) are skipped and reported, not treated as errors.

**Why reverse chunk order, stated rather than assumed:** it isn't required for correctness —
`revert_import_batch` only ever deletes the `inventory_items` rows *its own*
`applied_inventory_item_id` column names, so no batch's revert can touch another batch's rows,
regardless of order. Reverse order is chosen because it's the more intuitive undo direction for
an operator watching a progress log ("last thing in, first thing out"), and because it means a
revert interrupted partway through always leaves the *earliest*, most-likely-correct chunks
still applied rather than the *latest*, least-reviewed ones.

**The FK-direction concern, addressed directly.** `inventory_items.wine_id references
wines(id) on delete restrict` — the brief flags this as something session revert must not
violate. Session revert **never deletes `wines` rows at all**, for the same reason single-batch
`revert_import_batch` doesn't (documented in `docs/runbooks/csv-import.md`'s "Reversibility"
section): a wine created during this session may legitimately still be referenced by
inventory outside the reverted scope — a sibling chunk that wasn't reverted, a manual entry, or
inventory from a completely different session. Attempting to delete such a wine would correctly
fail against the `restrict` FK the moment anything still points at it, and if genuinely nothing
does, there's no orphan-`wines`-row problem to begin with (an unreferenced wine row is inert —
no query path surfaces it, it costs nothing). **Session revert deliberately does not attempt
wine cleanup.** Naming this is the point: a design that *did* try to "garbage-collect" wine rows
after a session revert would immediately hit this FK the first time any other row still
referenced the wine, which is the FK doing exactly its job.

## 4. Migration set (0102–0111)

Every forward migration gets a paired `down/NNNN_<name>.down.sql`. None uses `create index
concurrently` — every new index here is on a table this migration itself creates (empty at
creation time) or, where an existing table's index changes, follows the `0012` precedent (plain
form, sub-second lock, comment naming the `concurrently` statement an operator should run by
hand if the table has grown significantly by deploy time — see `down/0048`/`down/0014` as the
counter-examples of *not* leaving that note).

| # | file | one line |
|---|---|---|
| 0102 | `import_sessions.sql` | new table, RLS, grants (§3.1) |
| 0103 | `import_batches_session_columns.sql` | add `session_id`, `chunk_index`, `chunk_total`, `content_sha256` to `import_batches`; partial unique index on `(restaurant_id, content_sha256) where content_sha256 is not null and status <> 'reverted'` (§2.2, §3.2) |
| 0104 | `import_batch_rows_apply_tracking.sql` | add `apply_attempts int not null default 0`, `last_error_message text`, `duplicate_reason jsonb` to `import_batch_rows` (§1.5, §5 C16) |
| 0105 | `wines_lwin_match_score.sql` | add `lwin_match_score real` to `wines` (§5, C24) |
| 0106 | `count_import_batch_rows.sql` | new aggregate RPC replacing `countBatchRows`'s uncapped `.select()` (§5, C03) |
| 0107 | `create_import_batch.sql` | new `security invoker` RPC: batch + rows insert in one transaction, replacing `confirmImportBatch`'s two separate client calls (§5, C09); accepts session/chunk/hash params (§3.2) |
| 0108 | `apply_import_batch_chunk_v2.sql` | `create or replace`: status-lock guard (§5 C-new-1/C03), `apply_attempts`/`last_error_message` tracking + pending-transition on exhaustion (§5 C16), confidence-aware `lwin_id` coalesce via `lwin_match_score` (§5 C24) |
| 0109 | `revert_import_batch_v2.sql` | `create or replace`: relax the status guard from `= 'completed'` to `in ('applying', 'completed')` (§5 C-new-1) — deletion logic itself unchanged |
| 0110 | `revert_import_session.sql` | new session-level revert, reverse chunk order, per-batch exception isolation (§3.4) |
| 0111 | `inventory_items_bounds_and_currency_checks.sql` | `CHECK` upper bounds on `quantity`/`unit_cost` matching new TS constants; `CHECK` on `currency` against a closed ISO-4217-ish allowlist (§5, C18) |

`row-validator.ts` and `constants.ts` changes (C18's strict-numeric-literal validation,
`MAX_QUANTITY`/`MAX_UNIT_COST`/currency allowlist constants) are TypeScript-only, no migration.

## 5. Inherited bugs — fix approach + regression test

Per-bug detail (mechanism, blast radius, exact repro) lives in V2-import.md; this states the fix
and its proof, not the audit.

**C03 — PostgREST's 1,000-row default (`max_rows`) truncates `countBatchRows`'s full-table
`.select()`, causing a false `status='completed'` persisted to the DB, and `apply_import_batch_chunk`
never checks `import_batches.status` at all so a reverted batch can be re-applied into.**
*Fix:* replace `countBatchRows` (`batch-service.ts:106-126`) with the new `count_import_batch_rows`
aggregate RPC (0106) — a single-row `select count(*) filter (...)` result is immune to
PostgREST's row cap by construction (it returns one row regardless of table size). Separately,
`apply_import_batch_chunk_v2` (0108) adds `select status from import_batches where id =
p_batch_id for update` at its top and no-ops (returns zero rows) when `status = 'reverted'` —
this is new, not a restatement of the existing behavior. *Regression test:* integration test
reproducing V2-import.md's exact scenario — 1,500 rows, apply in 100-row chunks past the
1,000-row mark, assert the RPC (not the old `.select()`) reports `eligibleNotApplied=500`
correctly; then revert, then call `applyImportBatchChunk` again on the reverted batch, and
assert zero rows process and zero new `inventory_items` rows are created.

**C09 — no idempotency key; `confirmImportBatch`'s batch-insert and rows-insert are two separate
client-side statements, so a rows-insert failure leaves an orphaned batch that a REVOKEd DELETE
can't clean up and that later self-reports `status='completed'` (vacuous truth: 0 of 0 rows
"complete").**
*Fix:* this is mostly subsumed by §2.2's `content_sha256` unique constraint (kills "fire confirm
twice with identical bytes" outright — the second insert hits `23505`, caught and turned into a
resume-pointer response). The orphan-on-partial-failure half is fixed by `create_import_batch`
(0107): one `security invoker` PL/pgSQL function wrapping the batch insert and the rows insert
in its own implicit transaction — if the rows insert fails, Postgres rolls back the whole
function call automatically, so there is never a batch row without its rows, and the REVOKEd
`DELETE` grant becomes irrelevant (nothing needs deleting). `confirmImportBatch` changes from two
`.insert()` calls to one `supabase.rpc('create_import_batch', {...})` call.
*Regression test:* (1) fire `confirmImportBatch` twice concurrently with byte-identical content
— assert exactly one `import_batches` row exists, the second call returns the first's `batchId`,
and applying doesn't double inventory quantities (the exact C09 Part-1 repro, asserted to no
longer reproduce). (2) inject a rows-insert failure inside `create_import_batch` (a row violating
a NOT NULL/CHECK) and assert **zero** `import_batches` rows exist afterward — no DELETE grant
needed to prove it.

**C16 — a permanently-failing row (e.g. `numeric field overflow`) is re-selected by every
`apply_import_batch_chunk` call forever (same `LIMIT` window, no state change on error),
starving every row behind it and never persisting the error anywhere.**
*Fix:* `apply_attempts`/`last_error_message` (0104) tracked in the exception handler; on the
`MAX_ROW_APPLY_ATTEMPTS`th failure (new constant, `= 3`, in `constants.ts` — three chosen because
V2-import.md's own repro shows the identical failure on every retry with no transient-recovery
path, so further retries buy nothing but the count still tolerates one genuinely transient
error), flip `resolution` to `'pending'` (existing enum value, no new state) in the same
transaction. The row then falls out of `apply_import_batch_chunk`'s eligibility filter
(`resolution in ('auto','include')`) automatically — no index change needed. It surfaces through
the *same* pending-row UI/`resolveImportBatchRow` path §1.5 tier 3 already uses, distinguished by
`last_error_message is not null`.
*Regression test:* exact V2-import.md repro — 101 rows, 100 permanently overflow
`numeric(10,2)`, row 101 is clean; call `applyImportBatchChunk` up to `MAX_ROW_APPLY_ATTEMPTS + 1`
times; assert row 101 applies on the 4th call (once the 100 poison rows exhaust their attempts and
exit eligibility) instead of never; assert each poison row's final state is
`apply_status='not_applied', resolution='pending', apply_attempts=3,
last_error_message='numeric field overflow'`.

**C18 — `Number.parseInt`/`parseFloat` accept a numeric prefix and silently ignore trailing
garbage (`'2015abc'`→2015, `'750ml'`→750, `'12.5.7'`→12.50); `quantity`/`unit_cost` have no
upper bound at either layer; `currency` accepts arbitrary free text.**
*Fix:* in `row-validator.ts`'s `validateRow()`, before calling `parseInt`/`parseFloat` on
vintage/size_ml/quantity/unit_cost, test the trimmed raw string against a whole-string literal
regex — reusing, verbatim, the exact patterns P1's own oracle independently defined for this
purpose (`INTEGER_LITERAL = /^[+-]?\d+$/`, `FLOAT_LITERAL =
/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/`, `validate-bulk-import.ts`) — reject as a
field error on any non-match, before the numeric parse ever runs. Add `MAX_QUANTITY` (100,000)
and `MAX_UNIT_COST` (1,000,000) named constants (`constants.ts`) with matching app-side checks
and DB `CHECK`s (0111). Add a small closed currency allowlist (ISO-4217 codes actually relevant
to a wine cellar — USD/EUR/GBP/CAD/AUD/CHF/JPY — not a full ISO-4217 library, YAGNI) as both an
app-side check and a DB `CHECK` (0111).
*Regression test:* table-driven unit test asserting each of the four adversarial cells
V2-import.md used (`'2015abc'`, `'750ml'`, `'12.5.7'`, and a `quantity` prefix case) now returns
`state: 'error'` with a field-attributed message; plus `quantity: '99999999'` and
`unit_cost: '99999999'` rejected by the new upper bound; plus `currency: 'Freedom Bucks'`
rejected. A DB-contract test asserting the new `CHECK`s reject an out-of-band direct insert that
bypasses the app layer entirely.

**C24 — `match_lwin`'s 0.3 threshold auto-applies an ambiguous match (two real, distinct
wines both clear it); `apply_import_batch_chunk`'s `coalesce(wines.lwin_id, excluded.lwin_id)`
locks in whichever value arrived first, permanently, even when a much higher-confidence match
arrives later in the same import.**
*Split ownership, stated explicitly:* the *matching* threshold/margin logic lives in
`match_lwin` (0007) — out of scope for both P2 (its own §12 says so) and P3; that's the audit fix
lane's job. **P3 owns only the coalesce inside `apply_import_batch_chunk`, because that function
is 0076, P3's own file.** *Fix:* adopt P2's own stated contract (§6 of the P2 doc) as the shared
number rather than guessing independently — `apply_import_batch_chunk_v2` only forwards
`v_row.lwin_id` into the `wines` insert when `v_row.lwin_score >= LWIN_APPLY_MIN_SCORE` (new
constant, `0.6`, matching P2's bar exactly so the two pieces never disagree on one threshold).
Add `wines.lwin_match_score real` (0105) and change the upsert's `on conflict` clause to prefer
the *higher-scoring* match: `lwin_id = case when excluded.lwin_id is not null and
(wines.lwin_id is null or excluded_score > wines.lwin_match_score) then excluded.lwin_id else
wines.lwin_id end` (and the matching update for `lwin_match_score` itself), so a later
higher-confidence match can overwrite an earlier lower-confidence one — the exact gap
V2-import.md proved (0.95 losing to 0.31 purely by insertion order).
*Regression test:* the exact V2-import.md repro (row 1: `lwin_id='WRONG', score=0.31`; row 2,
same wine: `lwin_id='CORRECT', score=0.95`) — assert final `wines.lwin_id='CORRECT'`. **Negative
case, the one a naive "always overwrite" fix would get wrong:** reverse the order (0.95 applied
first, then 0.31) — assert `wines.lwin_id` stays `'CORRECT'`, i.e. a later *lower*-confidence
match must never downgrade a higher-confidence one already in place. Also assert a row with
`lwin_score=0.45` (between the old 0.3 bar and the new 0.6 bar) never sets `wines.lwin_id` at
all — the direct proof that P2's stricter number is actually enforced at the one point P3
controls.

**C10 — the per-identity `pg_advisory_xact_lock` in `derive_wine_lineage` (0056) genuinely
serializes concurrent transactions sharing a wine identity, but V2-import.md's own measurement
refutes the alleged consequence: ~800 rows/sec measured throughput (≈25s DB time for 20,000
rows total, well under any timeout), and the app's `applyAll()` loop
(`import-client.tsx`) is strictly sequential by construction, so the lock's contention case never
triggers under normal use. Re-graded LOW; V2-import.md's own fix sketch is "none required for the
20k target as shipped."**
*Fix approach:* **no functional change to the locking mechanism itself** — I agree with the
verifier's re-grading and see no new evidence to overturn it. The one thing chunking changes is
that C03's fix (§ above) already adds a `select ... for update` lock on `import_batches` at the
top of `apply_import_batch_chunk_v2`; that lock, acquired anyway, incidentally also bounds C10's
one *named* residual risk ("two different batches for the same restaurant applied concurrently
with overlapping wine identities" — now plausible with five batches instead of one) to "one
call briefly waits," never "corruption," because the deeper `wines_derive_lineage` advisory lock
was already proven directly (V2-import.md's two-`psql`-session test) to serialize correctly at
the SQL level regardless of which higher-level function is calling it.
*Regression test:* keep V2-import.md's own two-concurrent-`psql`-session `pg_advisory_xact_lock`
contention test as a standing "must not regress" check that the lock still exists and still
blocks (not a new fix's proof — a tripwire on an already-proven mechanism). New test: apply two
*different* batches of the same session, deliberately sharing one wine identity, concurrently via
`Promise.all` — assert exactly one `wines` row results (no duplicate from a lost race) and
wall-clock time isn't catastrophically worse than sequential (a coarse throughput guard, since
concurrent multi-batch apply becomes a realistic operator action under this design in a way it
wasn't when only one batch could exist).

**C-new-1 (found while designing §3.4, not in the original audit) — `revert_import_batch`'s
guard (`if v_status <> 'completed' then raise exception ... using errcode = 'P0001'`) means a
batch that got *partially* applied and then abandoned (a pending row nobody resolved, an operator
who walked away mid-apply) can never be reverted — its convenience `status` sits at `'applying'`
forever, and the guard accepts nothing but `'completed'`.** With one batch this was a narrow
edge case; with five, it's five independent chances for one chunk to get stuck, and it directly
blocks §3.4's "revert a session as a unit" requirement the moment any single chunk in that
session is stuck mid-flight. *Fix:* `revert_import_batch_v2` (0109) relaxes the guard to `status
in ('applying', 'completed')` — the function body itself is already safe on any batch with *any*
applied rows (its loop is scoped to `apply_status = 'applied'` regardless of the batch's
convenience label), so this is a pure guard relaxation, not a change to what gets deleted.
*Regression test:* apply 60% of a 5,000-row batch, stop (simulating an abandoned import),
call `revertImportBatch` — assert it succeeds (today: asserts it currently fails with
`not_completed`, then asserts the fix flips that), deletes exactly the applied 60%'s inventory,
and leaves the batch `status='reverted'`.

**C-new-2 (a naming note, not a new bug) — `count_import_batch_rows`.** Not a bug fix on its
own; called out here because C03's fix *is* this RPC, and it's referenced from §3.3 as the
building block for session-level progress aggregation. No separate regression test beyond C03's.

## 6. Test plan

**Unit (TypeScript, no DB):**
- `row-validator.test.ts`: the four literal-vs-coerced adversarial cells (C18); the upper-bound
  cases; the currency allowlist.
- New `dedup-key.test.ts` (or co-located in `preview-service.test.ts`): the intra-batch merge
  grouping logic — same wine+bin+section+cost+currency merges with summed quantity; any single
  field mismatch (cost, currency, bin, section) does *not* merge; the fallback four-tuple key
  matches the DB's `lower()`-based conflict key byte-for-byte on a table of mixed-case inputs.

**Integration (live two-tenant Postgres, `signedInClient()` pattern from
`tenant-isolation.test.ts` — that file's own header calls this MANDATORY):**
- Cross-batch dedup: chunk 1 confirmed + applied with wine W in bin A1; chunk 4 confirmed with
  the same W/A1 — assert chunk 4's row lands `resolution='pending'` with
  `duplicate_reason` populated, not silently applied.
- The TOCTOU case from §3.3: chunks 1 and 4 both *confirmed* (neither applied yet) with the same
  W/A1 — assert the *later-confirmed* chunk's row is flagged, without requiring chunk 1 to have
  been applied first.
- Re-upload rejection + resume pointer (§2.2): confirm a chunk, confirm the identical bytes
  again, assert `23505`→resume-pointer response, not a second batch.
- Session revert (§3.4): five-batch session, revert as a unit, assert reverse-order processing,
  assert zero `wines` rows are touched, assert a `wine_id` still referenced by a sibling
  unreverted batch is untouched (proves the FK-direction reasoning in §3.4 empirically, not just
  by argument).
- All six inherited-bug regression tests from §5.

**DB-contract (pgTAP, following `supabase/tests/0074_public_api_grants.sql`):**
- RLS enabled + correct base grants on `import_sessions` and every altered table.
- The new partial unique index on `content_sha256` actually rejects a duplicate and actually
  permits a null.
- `CHECK` constraints from 0111 reject direct out-of-band inserts.
- `count_import_batch_rows`'s `EXPLAIN` never shows a sequential scan on `import_batch_rows`
  past a few thousand rows (the direct proof it doesn't reintroduce C03's shape in a new form).

**Fault injections:**
- Kill the process mid-`apply` (simulate a Vercel/Railway timeout) after 60% of a chunk — resume
  via `/apply` again, assert no double-application, matches existing resumability plus the new
  session progress view reflecting the interruption correctly.
- Kill mid-`confirmImportBatch` (simulate a rows-insert failure) — assert atomic rollback (C09).
- Re-upload the identical chunk after a full session revert — assert it succeeds as a genuinely
  new batch (the hash was freed).
- Two browser tabs applying two different chunks of the same session concurrently, sharing one
  wine identity — assert no duplicate `wines` row (C10's new test).

**Performance, with target numbers (reusing V2-import.md's own measured baselines where they
apply, and naming what's new/unmeasured honestly):**
- Apply throughput: **[MEASURED, V2-import.md]** ~800 rows/sec via 100-row chunk calls →
  ~6.25s DB time for one 5,000-row chunk, ~25s DB time total for a full 5-chunk/20,000-row
  session. Target: stays within this order of magnitude after C16/C24's added per-row work
  (an extra `UPDATE` on the exception path, one extra `CASE` in the upsert) — **[ESTIMATE,
  unmeasured]**, cheap to check with the same harness V2-import.md already built.
- Revert: **[MEASURED, V2-import.md]** 1.60s for 5,000 rows on a 23,426-row table. Target:
  session-level revert of 5 batches stays under ~10s total (5× the single-batch number plus
  per-batch RPC overhead) — **[ESTIMATE, unmeasured]**.
- **New, unmeasured:** the cross-batch dedup query (§1.5 tier 2) — checking sibling-session
  not-yet-applied rows plus already-applied inventory for a match — must not degrade as chunks
  accumulate. Target: p95 under 200ms per unique wine+location key checked, backed by an index on
  `(restaurant_id, wine_identity_key, bin_norm, section_norm)` sized for this exact query. This
  is genuinely new code with no prior measurement to lean on — the cheapest experiment to settle
  it is running the same 20k-fixture-derived batch through the real function once implemented,
  before calling this piece done.
- Preview/LWIN-match at 5,000 rows: unchanged from today's reasoning
  (`docs/runbooks/csv-import.md`) — `LWIN_MATCH_BATCH_SIZE=300` keeps even the largest single
  chunk's preview well inside one request.

## 7. What could still go wrong

**The largest residual risk: this design's most novel piece (session grouping + re-upload
detection) is built against a manifest contract that does not exist yet.** §2.3 established,
by direct inspection of the P1 worktree at `7647c6b`, that no chunk-splitter and no per-chunk
manifest currently exist — only a whole-file fixture generator and an in-memory validation
oracle. Everything in §2 and §3 that depends on `chunk_sha256`/`source_csv_sha256`/
`chunk_index`/`chunk_total` is a *specification P3 is placing on P1's next round*, not a verified
interface. If P1's eventual splitter emits a differently-shaped manifest, hashes text instead of
bytes (§2.3's named correction), or lands after P3's migrations are already written against an
assumed shape, the session/re-upload feature either ships in a degraded mode (batch-level
`content_sha256` re-upload detection still works standalone — that doesn't depend on P1 at all —
but session auto-grouping and cross-chunk source-consistency checking would not) or blocks on
renegotiation. This is a cross-team integration risk, not a data-quality edge case, which makes
it the least boundable item in this design. Mitigation: build and land the §2.4 pinning test
*first*, against a small fixture, before either side writes the real 20k-scale logic — that test
existing and passing is the actual signal this risk has been resolved, not this document.

**Second-largest, and unlike the first, this one is bounded by measurement rather than
coordination: bin/section text-matching fuzziness.** §1.4 named this — the cross-batch dedup key
compares `trim().toUpperCase()` text, not `bin_id` (that fix, C11, lives in a different audit
lane and isn't done). If the partner's real export spells the same physical bin differently
across the file's own two-hundred-line stretches (`"Bin A-1"` in one row, `"A1"` in another for
what a human would recognize as the same location), the dedup key produces a **false negative** —
a real duplicate slips through uncaught, silently, which is the worst failure mode this whole
piece exists to prevent. Unlike the P1 dependency above, this is fully settleable once the real
file (or even P1's synthetic 20k fixture) is available: compute the distinct normalized
`(wine_identity_key, bin_norm, section_norm)` tuples against the raw `bin`/`section` text
verbatim, and manually check whether any wine's bin/section spelling actually varies across
occurrences that are otherwise identical. That's a single offline script, cheap to run, and it
should run before this design is treated as sufficient rather than after a real onboarding run
surfaces the gap in production.

**Named, smaller, not blocking:** (1) the P2 dependency in §1.4 — if P2's `resolve_wine_variants_bulk`
interface shape changes before merge, P3's dedup key falls back to the raw four-tuple, which
still works but forgoes P2's accent/spelling collapsing at the dedup layer specifically (P2's own
wine-identity resolution is unaffected either way — this only affects whether P3's *location*
merge sees two spellings of one wine as the same row-group before wines exist). (2) `resolveImportBatchRow`
needs zero code changes for the new `pending` causes (§1.5, §5 C16) beyond exposing
`duplicate_reason`/`last_error_message` in the batch-detail `GET` response for the UI to render —
confirmed by reading the function, not assumed, since `include`'s only special-cased branch is
the missing-cost path and neither new cause touches cost.
