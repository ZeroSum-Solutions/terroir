# Background job runner: invoice_extract (G1-6)

A single-job-type background worker for invoice extraction. Owner decision
(plan Q3): a Railway worker process, not a serverless/cron trigger. This is
deliberately not a generic job platform — it claims and executes exactly
one job type, `invoice_extract`. If a future slice adds a second job type
to this table (a ledger event emitter has been proposed), it gets its own
runner logic; the schema below was designed to be reusable, the code was not
made generic speculatively.

## Schema

Extends the existing `public.background_jobs` table (added in migration
0052, previously unused by any application code) rather than creating a
parallel jobs table — see migration `0075_invoice_extract_jobs.sql` /
`down/0075_invoice_extract_jobs.down.sql`.

Added:

- `invoice_extract` joins the `job_type` check constraint (same pattern
  0058/0065 used to add their own job types).
- `dead` joins the `status` check constraint as the terminal failure state.
- `idempotency_key text` + unique index `background_jobs_idempotency_key_uniq`
  on `(job_type, idempotency_key)` where the key is non-null. This is the
  enqueue-idempotency guarantee, enforced in the database.
- `claimed_at timestamptz`, `claimed_by text` — who owns an in-flight
  attempt and since when. Used for the stuck-job reclaim sweep and as a
  fencing token on completion writes.
- `background_jobs_claim_idx (job_type, status, run_after)` and
  `background_jobs_claimed_idx (status, claimed_at) where status = 'processing'`
  — support the claim and reclaim queries.
- Two SQL functions, `SECURITY INVOKER` (the default — `service_role`
  already has full table DML via 0074's grants and bypasses RLS, so no
  elevated privilege is needed), `EXECUTE` revoked from `PUBLIC` and
  granted only to `service_role`:
  - `claim_invoice_extract_job(p_worker_id text)` — atomically claims the
    single oldest runnable job via `FOR UPDATE SKIP LOCKED`. PostgREST's
    query builder can't express `SELECT ... FOR UPDATE`, so this has to be
    an RPC.
  - `reclaim_stuck_invoice_extract_jobs(p_stuck_after_seconds integer)` —
    sweeps every job claimed longer than the threshold ago and requeues it
    with `attempt_count` incremented, or marks it `dead` once
    `max_attempts` is exhausted.

### Down-migration data policy

Rolling back this migration necessarily discards invoice_extract job
history: any row with `job_type = 'invoice_extract'` (in ANY status —
queued, processing, succeeded, or dead) or `status = 'dead'` (a status only
this feature's code ever sets) cannot exist under the constraints the down
file restores, so those rows are deleted before the constraints are
re-added. This is a deliberate, destructive rollback choice, not an
oversight — there is no non-destructive way to revert a vocabulary this
feature's own rows already use. Non-invoice_extract rows, and rows in any
status other than `dead`, are left untouched. The down file is wrapped in a
single transaction (`begin; ... commit;`) so a failure at any step rolls
back the whole file instead of leaving `background_jobs` with the new
columns/indexes/functions gone but no status/job_type check constraint at
all (a corrupted half-revert) — the failure mode a first version of this
migration actually hit before this policy and the transaction wrap were
added.

The down migration was rehearsed against a local Supabase instance with
rows present in **every** state before rolling back — queued, processing,
succeeded, dead, plus a control row of a different job_type (`wine_enrichment`,
status `queued`) to prove non-invoice_extract data survives untouched:
applied up, exercised claim / idempotency-conflict / stuck-reclaim-to-requeue
/ stuck-reclaim-to-dead against real rows, inserted one row in each of the
four invoice_extract statuses plus the control row, applied down (all four
invoice_extract rows removed, the control row intact), diffed `\d
public.background_jobs` against the pre-migration schema (exact match), then
re-applied up.

## State machine

```
queued --[claim]--> processing --[success]--> succeeded
                         |
                         +--[retryable failure, attempts remain]--> queued (run_after = now + backoff)
                         |
                         +--[retryable failure, attempts exhausted]--> dead
                         |
                         +--[non-retryable failure]--> dead (immediately, no wasted retries)

processing --[claimed_at older than stuck threshold]--> queued (attempt_count++) or dead (if exhausted)
```

Backoff is exponential, deterministic (no jitter — a single worker process
doesn't need it): `min(30s * 2^(attempt-1), 15min)`. See
`src/lib/jobs/backoff.ts`.

## Idempotent enqueue and double-bill avoidance

Three distinct guarantees, at three different layers. The first two guard
against double-*enqueuing* and double-*calling after a completed attempt*;
the third guards against the harder case — a reclaim racing a still-alive
worker — which an earlier version of this runbook understated.

1. **Enqueue is idempotent.** `enqueueInvoiceExtractJob` uses the scan id as
   the job's `idempotency_key`. A second enqueue call for the same scan
   (client retry, double form submit) hits the unique index and the
   function returns the existing job instead of inserting a second one —
   the same scan can never have two `invoice_extract` jobs racing to call
   Anthropic on it. Enforced by `background_jobs_idempotency_key_uniq`, not
   application-level de-duplication.
2. **A requeued/reclaimed job that already persisted a result skips
   re-calling the provider.** Before invoking `processInvoiceScanOnce`,
   `runInvoiceExtractJob` checks `invoice_scans.status` against
   `{"complete", "review"}` — both are already-persisted signals that
   OCR+LLM already ran and wrote a result for this scan (`"review"` is
   G1-12's arithmetic-mismatch outcome: the extraction succeeded and
   persisted, HTTP 200, just flagged for manual review of the numbers —
   not a reason to re-run it). If the scan is in either state, the job is
   marked `succeeded` without touching Azure or Anthropic. This is the
   case a stuck-job reclaim can hit *after* a worker has actually crashed:
   it dies after `processInvoiceScanOnce` finishes writing but before the
   job row is marked `succeeded`; the reclaim sweep requeues the job; the
   next attempt sees the persisted status and short-circuits.
3. **A worker that is slow but still alive — not crashed — must not be
   treated the same as a dead one.** `processInvoiceScanOnce`'s underlying
   Azure/Anthropic calls have no configured timeout, so a legitimate call
   can run long enough to cross `STUCK_AFTER_SECONDS` (5 minutes) on its
   own. Without anything addressing this, the stuck-job reclaim sweep would
   reclaim that job out from under the still-working original worker, a
   second worker would claim it, and — since neither has written
   `invoice_scans.status = "complete"` yet — *both* would call Anthropic on
   the same job. Claim atomicity (`FOR UPDATE SKIP LOCKED`) does not by
   itself prevent this: it only guarantees two workers can't claim the
   *same row at the same instant*, not that a reclaim can't hand an
   in-flight job to a second worker later. Two mechanisms close this,
   implemented in `src/lib/jobs/heartbeat.ts`:
   - **Heartbeat / lease renewal.** While the extraction call is in flight,
     `withClaimHeartbeat` renews `claimed_at` every
     `HEARTBEAT_INTERVAL_MS` (a third of the stuck threshold). As long as
     the worker is alive and these renewals succeed, the reclaim sweep's
     `claimed_at < now() - threshold` condition never matches this job —
     it is never spuriously reclaimed in the first place. This is the
     primary fix, and covers the common case (any call duration, as long
     as the process is alive).
   - **Pre-call fencing check.** Immediately before invoking
     `processInvoiceScanOnce` — the expensive, billed call —
     `isStillClaimed` does a fresh read verifying this worker still holds
     the claim (id + restaurant_id + claimed_by + status='processing'). If
     the lease is already gone (the job was reclaimed and a second worker
     already owns it), the call is never made: the outcome is `retry` /
     `claim_lost_before_extraction`, and the corresponding completion
     write is a fenced no-op (the new owner is already responsible for the
     job). This is what makes "a reclaimed-away worker cannot bill" an
     enforced check rather than a hope, and is exactly what
     `src/lib/jobs/invoice-extract-handler.test.ts`'s
     `"aborts WITHOUT calling the extraction service when the claim was
     lost before extraction started"` case and
     `src/lib/jobs/tenant-isolation.test.ts`'s live-DB
     `"aborts WITHOUT calling the extraction service when another worker
     has already stolen the claim"` case prove.

   **What this does not close:** a worker cannot cancel
   `processInvoiceScanOnce`'s in-flight network call once started —
   it is an external black box with no cancellation hook. So there is a
   genuine, narrow TOCTOU window between the pre-call check succeeding and
   the call actually starting (milliseconds, not the multi-minute stuck
   threshold) during which a reclaim could still theoretically race in.
   Closing that residual window completely would require either adding
   real timeouts/cancellation to `processInvoiceScanOnce` (out of bounds
   for this slice — it's owned by G1-12 and treated as a black box here)
   or an idempotency key on the provider call itself. Documented here
   rather than silently narrowed: the fix reduces the double-bill window
   from "any reclaim of a live worker, i.e. effectively guaranteed on slow
   calls" to "a race measured in milliseconds around the start of the
   call," not to zero.

See `src/lib/jobs/invoice-extract-handler.ts` and `src/lib/jobs/heartbeat.ts`.

## Tenant isolation

The worker runs with the Supabase service role, which bypasses RLS
entirely. Tenant scoping is therefore a property of the runner's own
queries, not of any policy — enforced at exactly one point: before calling
the extraction service, `runInvoiceExtractJob` fetches the subject scan
with `.eq("id", job.subjectId).eq("restaurant_id", job.restaurantId)`. If a
job's `restaurant_id` doesn't actually own its `subject_id` (nothing in the
schema prevents constructing such a row — `subject_id` has no FK to
`invoice_scans`), that fetch returns nothing and the job is marked `dead`
with `tenant_mismatch_or_missing_subject` before any read or write touches
the other tenant's data.

`src/lib/jobs/tenant-isolation.test.ts` is the mandatory fixture proof:
two restaurants, real Postgres, real service-role client, 5 cases. It
asserts a crafted cross-tenant job is rejected with the other tenant's row
left byte-for-byte unchanged, that a legitimate same-tenant job never
touches a control row belonging to the other tenant, the two enqueue/replay
idempotency guarantees above, and — against real Postgres, not a mock —
that a worker whose claim has been stolen by another worker aborts before
calling the extraction service (see "double-bill avoidance" above). It
requires a live local Supabase and is skipped otherwise
(`NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` unset) — the same
convention `e2e/reconcile-queue.test.ts` and its siblings use for fixture
tests that can't run on a bare CI runner. Run it locally:

```bash
supabase start   # or: point the env vars at any local Postgres with 0075 applied
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:<api-port> \
SUPABASE_SERVICE_ROLE_KEY=<local service-role key from `supabase status`> \
pnpm exec vitest run src/lib/jobs/tenant-isolation.test.ts
```

## Files

- `supabase/migrations/0075_invoice_extract_jobs.sql` / `down/0075_invoice_extract_jobs.down.sql`
- `src/lib/jobs/*` — enqueue, claim, reclaim, completion (fenced writes),
  heartbeat (claim-lease renewal + pre-call fencing check), backoff, the
  invoice_extract handler, and the claim-run-complete orchestration
  (`run-once.ts`)
- `src/worker/index.ts` — the long-poll worker entrypoint (`pnpm run
  worker`, run via `tsx`; no build step, no compiled output)
- `railway.worker.toml` — config-as-code for the Railway worker service

## Railway deployment

**Current state of the `terroir-worker` service** (project
`industrious-courtesy`, checked 2026-08-22):

- **Production**: the service exists but has **zero deployments** — it has
  never run any code.
- **Staging**: has one active deployment, but from `integration/ter-020d25-on-d22`
  — an old, abandoned branch never merged to `main` (it doesn't share
  `main`'s migration history; its `0084_*` migration doesn't fit `main`'s
  current sequence). Its `pnpm worker` runs a generic multi-job-type
  framework (`src/worker/{handlers,runtime,supabase-job-store}.ts`) for
  `wine_enrichment` and `wine_list_pdf` — **not** `invoice_extract`, and not
  present anywhere on `main`. This PR does not touch or depend on that
  branch or that deployment.

**To run this slice's worker**, once this PR is approved and merged:

1. Apply migration `0075_invoice_extract_jobs.sql` to the target Supabase
   project (same path as any other migration).
2. In the Railway dashboard, open the `terroir-worker` service -> Settings
   -> Config-as-code, and set the Config Path to `railway.worker.toml` (at
   the repo root, alongside the web service's `railway.toml`).
3. Copy `terroir-web`'s service variables to `terroir-worker` for the same
   environment: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `OPENROUTER_API_KEY`, `AZURE_DOC_INTELLIGENCE_ENDPOINT`,
   `AZURE_DOC_INTELLIGENCE_KEY`. No new variables are introduced by this
   slice.
4. Redeploy `terroir-worker` from `main` (or whichever branch this lands
   on). It will start `pnpm run worker` and begin polling for
   `invoice_extract` jobs — of which there are currently none, since
   nothing enqueues them yet (see Follow-up below).

This runbook documents the change; it was not applied to any Railway
environment as part of this PR.

## Follow-up: wiring enqueue into the live scan path

This slice ships `enqueueInvoiceExtractJob` fully implemented and tested,
but does not call it from `src/app/api/scan/route.ts` or any other
scan-intake route — those are out of bounds for this slice (owned by
another in-flight agent, and `fix/m0-1-scan-intake` may touch the same
files). The integration point for a follow-up slice: after a scan's image
is uploaded to storage and its `invoice_scans` row is created with
`raw_image_path` set, call `enqueueInvoiceExtractJob({ supabase,
restaurantId, scanId })` instead of (or behind a flag alongside)
`processInvoiceScanOnce`'s synchronous call. G1-7 ("moves extraction onto
the runner") is expected to make this switch.
