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

The down migration was rehearsed against a local Supabase instance: applied
up, exercised claim / idempotency-conflict / stuck-reclaim-to-requeue /
stuck-reclaim-to-dead against real rows, applied down, diffed `\d
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

## Idempotent enqueue — cannot double-bill Anthropic on retry

Two distinct guarantees, at two different layers:

1. **Enqueue is idempotent.** `enqueueInvoiceExtractJob` uses the scan id as
   the job's `idempotency_key`. A second enqueue call for the same scan
   (client retry, double form submit) hits the unique index and the
   function returns the existing job instead of inserting a second one —
   the same scan can never have two `invoice_extract` jobs racing to call
   Anthropic on it. Enforced by `background_jobs_idempotency_key_uniq`, not
   application-level de-duplication.
2. **A requeued/reclaimed job that already persisted a result skips
   re-calling the provider.** Before invoking `processInvoiceScanOnce`,
   `runInvoiceExtractJob` checks `invoice_scans.status`. If it's already
   `"complete"` (the existing, already-persisted signal that OCR+LLM
   already ran and wrote a result), the job is marked `succeeded` without
   touching Azure or Anthropic. This is the case a stuck-job reclaim can
   hit: a worker crashes after `processInvoiceScanOnce` finishes writing
   but before the job row is marked `succeeded`; the reclaim sweep requeues
   the job; the next attempt sees `status = "complete"` and short-circuits.

See `src/lib/jobs/invoice-extract-handler.ts`.

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
two restaurants, real Postgres, real service-role client. It asserts a
crafted cross-tenant job is rejected with the other tenant's row left
byte-for-byte unchanged, that a legitimate same-tenant job never touches a
control row belonging to the other tenant, and the two idempotency
guarantees above. It requires a live local Supabase and is skipped
otherwise (`NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` unset)
— the same convention `e2e/reconcile-queue.test.ts` and its siblings use
for fixture tests that can't run on a bare CI runner. Run it locally:

```bash
supabase start   # or: point the env vars at any local Postgres with 0075 applied
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:<api-port> \
SUPABASE_SERVICE_ROLE_KEY=<local service-role key from `supabase status`> \
pnpm exec vitest run src/lib/jobs/tenant-isolation.test.ts
```

## Files

- `supabase/migrations/0075_invoice_extract_jobs.sql` / `down/0075_invoice_extract_jobs.down.sql`
- `src/lib/jobs/*` — enqueue, claim, reclaim, completion (fenced writes),
  backoff, the invoice_extract handler, and the claim-run-complete
  orchestration (`run-once.ts`)
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
   `ANTHROPIC_API_KEY`, `AZURE_DOC_INTELLIGENCE_ENDPOINT`,
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
