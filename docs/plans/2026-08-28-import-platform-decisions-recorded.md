# Import & Platform — Recorded Decisions

Date: 2026-08-28

## Provenance

These decisions were delegated by the repo owner on 2026-08-28 with the instruction
to record the adjudicator's answer "instead of my decision". The adjudicator was
**GPT-5.6 Sol at high reasoning effort**, run read-only against this repository at
`origin/main` `0e9351c`.

The **Supabase migration lock** — a standing constraint through the preceding work,
under which every fix was forced into the TypeScript layer — was lifted for the
purpose of these decisions, since the whole point of the delegation was to settle
whether those migrations should exist. Both were adjudicated SHIP.

---

## D-A1 — Deterministic tie-break in `match_lwin` · **SHIP** (high confidence)

`0078_match_lwin_trgm_fastpath.sql:110` ranked candidates with a bare
`order by score desc`. Two catalogue rows tying on score had no defined winner, so
preview and confirm — which deliberately re-runs `buildImportPreview` from scratch
rather than trusting a client-supplied preview — could select different LWIN ids for
the same row. The operator approves one wine; a different one persists.

**Shipped as** `0127_match_lwin_deterministic_tiebreak.sql`: `order by score desc,
lc.lwin_id asc`. `lwin_id` is `lwin_catalog`'s primary key
(`0003_wine_intelligence.sql:21`), so it is non-null and unique — a total order.
`match_lwin_bulk` (`0076:265`) and `match_lwin_batch` (`0079:186`) both delegate to
`match_lwin` rather than ranking candidates themselves, so both inherit the fix.

**This was not a theoretical defect.** Before the migration the new test returned
`TIEBREAK99` — the higher id, which happened to be insertion order. After it, the
lower id, every call.

**What was explicitly NOT deleted on the strength of this migration.** The original
hope was that fixing the SQL would let the compensating TypeScript machinery go. It
does not, and the adjudication was pointed at that question specifically:

- The ascending flat-index reducer in `preview-service.ts` chooses among *separate
  producer-query variants*, not among tied catalogue rows inside one query. SQL
  ordering cannot express that choice.
- The LWIN approval veto in `batch-service.ts` defends against a strictly larger set
  of causes than tie ordering: the catalogue itself can change between preview and
  confirm — a row added, edited, removed, or newly crossing the threshold. The
  operator's approval is a statement about the wine they were shown.
- The bare / `overrides-v1` … `overrides-v4` digest namespaces encode materially
  different effective confirms. Re-keying any of them would orphan batches already
  written in production. Forbidden.

## D-A2 — Cross-batch apply race · **SHIP** (high confidence)

The invariant "at most one applied batch per underlying file" had no enforcement
point. `apply_import_batch_chunk` (0108) takes `for update` on its *own*
`import_batches` row only, so sibling batches never serialised; the route guard
`findSiblingWithAppliedRows` ran in a separate transaction, making it a TOCTOU check;
and the RPC is `GRANT EXECUTE`d directly to `authenticated`, so a direct RPC call
skipped the route guard entirely. Previously documented as an accepted residual.

**Shipped as** `0128_apply_import_batch_chunk_sibling_lock.sql`: normalise the
batch's `content_sha256` to the underlying file identity, take
`pg_advisory_xact_lock(hashtextextended(restaurant_id || ':' || file_digest))`, then
re-check for an applied sibling *under that lock*, raising `P0004`. Because the lock
is transaction-scoped and the check happens beneath it, two concurrent sibling
applies serialise and exactly one wins.

**Rejected alternatives**, with reasons:
- *Partial unique index* — applied truth lives in the child `import_batch_rows`, and
  a partial-index predicate cannot depend on child rows. Indexing live batch status
  instead would prohibit valid multi-live confirmation and adoption workflows.
- *Persistent claim column/table* — workable, but adds ownership, duplicate
  arbitration, RLS/grants, release-on-revert, and down-migration machinery without
  closing anything beyond what the lock plus atomic re-check already closes.

**Deliberate departures from the adjudicated plan**, both recorded rather than
silent:

1. **The route guard is retained**, where the plan called for deleting it along with
   `findSiblingWithAppliedRows`. The plan's own risk register requires
   migration-first deployment ("removing the route guard early reopens the race"),
   and its order of work puts the database migration before the application build.
   No CI step applies migrations here — they reach production out-of-band — so a
   build carrying the guard's removal can go live before 0128 does, which would
   leave production with *no* protection in that window. The guard stays until 0128
   is confirmed applied in production; the runbook carries the SQL to verify that
   and the instruction to delete it afterwards. Deleting it is the only outstanding
   piece of this decision.
2. **Both migrations were generated from the authoritative migration text**, not
   from the adjudicator's retyped copy. It had reproduced 0108's ~250-line plpgsql
   body by hand; a token-level diff confirmed the executable code was faithful, but
   re-deriving from 0108 removes transcription risk entirely and preserves 0108's
   inline C03/C16/C24/C11 documentation, which the retyped copy had stripped. The
   `0128` down migration is byte-identical to 0108's body; the forward differs from
   it only by the barrier.

**Existing violations are not repaired by the migration.** It is function-only and
never fails on data that already violates the invariant. A restaurant that already
has two applied batches for one file will see the next apply in that group refused
with `P0004` until an operator reverts all but one survivor.

**Historic digests stay grandfathered.** Null (pre-0103) or unparseable
`content_sha256` takes no lock and gets no check — the file identity cannot be
recovered, and refusing those batches would break existing production imports rather
than protect anything.

## D-A3 — Migration numbering · **Reserved band (0127/0128)**

The first adjudication allocated 0112/0113 and shifted the unlanded Visual Wine
Platform rows 0112–0126 up by two, honouring the spec-list's stated invariant
"Numbering = landing order."

Re-adjudicated after surfacing what that renumber actually collides with: `0112` is
written into **VWP-FR-005** (a functional requirement,
`visual-wine-platform-prd.md:124`), into **PRD acceptance criterion 1**
(`:261`), and into a **CI-gated eval assertion** (`docs/evals/vwp-evals.yaml:41`)
that traces to that criterion. The renumber would therefore have amended a
functional requirement and an acceptance criterion for work that has not started.

**Decision: allocate from the reserved band.** The manifest's final row is
explicitly `reserved … per decision`, which is what this is. The PRD, VWP-FR-005,
the eval, the synthesis, and the P4 document are all untouched, and no planned
migration is renamed.

**The ordering hazard was checked, not assumed.** Under the reserved band, a
rebuilt-from-scratch database replays 0112–0126 *before* 0127/0128, while production
applies 0127/0128 first. That only matters if a planned migration redefines the same
functions. Every planned row's contents were checked: 0112 (editions), 0113–0120
(P4 imagery), 0121–0123 (containers/slots/placements/bins move), 0124–0126 (ratings).
None redefines `match_lwin`, `match_lwin_bulk`, `match_lwin_batch`, or
`apply_import_batch_chunk`. Neither order overwrites either fix.

The spec-list's numbering paragraph was rewritten to stop claiming an invariant it no
longer holds: numbers now define deterministic replay order, not landing chronology.

## D-B1 — Import wait vs. file-size capacity · **Keep the raised ceiling** (medium confidence)

`LWIN_MATCH_UX_CEILING_SECONDS` stays at 120 with the up-front wait disclosure;
`MAX_ROWS` stays at 5,000. **No code changes.**

A phase that genuinely takes 120 s does not approach Railway's five-minute no-data
timeout, and `maxDuration = 60` is inert here because `railway.toml` runs a
long-lived `pnpm start`. Lowering the ceiling or capping file size would reject an
ordinary 5,000-row file without reducing the underlying work, and would not help the
realistic 20,000-row partner export the fixtures already anticipate.

**Recorded caveats — the decision is "ship as-is", not "this is fine forever":**
- 120 s is an *estimate*, not an enforced deadline. It derives from inherited 4.4 s
  measurements plus 9% concurrency inflation; the RPC workers have no elapsed-time
  deadline of their own (`lwin-matching.ts:74`).
- There is no streaming or keep-alive. Preview awaits all matching before returning
  JSON, and confirm does the same. A backgrounded or suspended mobile tab can
  interrupt preview; confirm is more recoverable because it persists a session id.

**Scheduled next, explicitly not shipped here:** durable background preview matching
with polling and stored-result reuse — enqueue a tenant-scoped job, persist
server-owned per-row match results, survive reload/backgrounding, and let confirm
consume the stored result instead of performing a second full match. SSE-only
streaming is *not* an acceptable substitute: it keeps the connection alive but makes
preview neither durable nor single-pass.

## D-B2 — Feature-ledger representation · **Ledger stays at 269** (high confidence)

Later features are represented in neither the ledger nor a new registry. **No code
changes.**

`app_spec.txt:8` fixes the contract at 269 enumerated core features. The README
(`:44`) defines the ledger as the completion tracker for those source requirements.
The verifier parses only `<core_features>` bullets, requires exactly 269, and
enforces one ordered entry per source assertion; its tests explicitly reject a 270th.
Per-row LWIN review and inline row correction are implementation evolution,
documented by their code, tests, and runbook. A second registry would be an ownerless
competing inventory with no verification consumer.

Adding a 270th ledger item without an approved `app_spec.txt` amendment must keep
making the verifier red. Do not weaken it to turn that state green.

---

## Verification performed

- **Red before, green after, for both migrations.** The new live-Postgres suite
  (`src/domains/import/import-hardening-live.test.ts`) fails 7 of 9 against the
  pre-migration schema and passes 9 of 9 after. The tie-break test returned the
  wrong LWIN id before the fix.
- **Down rehearsal.** Applying both down migrations brings 6 failures back; the
  forwards restore green. The downs are load-bearing, not decorative.
- **Route mapping mutation-tested.** Disabling the `P0004` branch turns exactly the
  two new route tests red; restoring it returns 11/11.
- **`0128`'s down is byte-identical to 0108's function body**, verified by diff.
  `0127`'s down is byte-identical to 0078's.
- Manifest, down-migration, and snapshot gates pass.

## Outstanding

1. **Apply 0127 and 0128 to production Supabase.** No CI step does this. Until then
   production runs the old functions and keeps only the route-level guard.
2. **After that, delete the route guard** and `findSiblingWithAppliedRows`, leaving
   the `P0004` → 409 mapping. See the runbook for the verification SQL.
3. **Schedule durable background preview matching** per D-B1.
