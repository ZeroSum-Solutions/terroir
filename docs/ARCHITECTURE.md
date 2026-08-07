# Terroir Architecture

Terroir stays a modular monolith. Route handlers should own HTTP lifecycle only:
auth, request parsing, validation, and response mapping. Domain modules own
business workflows. Adapter modules own external provider mechanics.

## Current Boundaries

- `../src/domains/scanning/invoice-scan-service.ts`: invoice OCR and LLM
  extraction orchestration.
- `../src/domains/wine-lists/wine-list-pdf-service.ts`: wine-list PDF generation
  workflow.
- `../src/domains/pours/pour-service.ts`: pour transaction orchestration around
  `record_pour`.
- `../src/domains/cellar/reconcile-service.ts`: reconcile transaction
  orchestration around `reconcile_open_bottles_batch`.
- `../src/adapters/ocr/index.ts`: Azure Document Intelligence boundary.
- `../src/adapters/llm/index.ts`: Anthropic invoice extraction boundary.
- `../src/adapters/pdf/index.ts`: Puppeteer HTML-to-PDF boundary.
- `../src/lib/supabase/server.ts`: Supabase server-client creation boundary.
- `../src/components/background-job-progress.tsx`: shared authenticated-shell
  progress, refresh recovery, and manager retry UI for durable jobs.

## Database Contracts

- Transactional inventory, pour, undo, and reconcile writes stay in Supabase
  RPCs. App code calls RPCs through domain services.
- Public wine-list reads stay explicitly protected by RLS policies and contract
  tests.
- Long-running OCR, wine enrichment, and PDF workflows have
  `public.background_jobs` as the durable retry and status model. Authenticated
  staff enqueue through `enqueue_background_job`; creators can read their own
  current-tenant jobs, and managers can read every job in their tenant. Direct
  client inserts, updates, and deletes are revoked.
- Worker processes claim due jobs through `claim_background_jobs`. A claim is
  atomic, increments the attempt count, and returns a worker-bound lease token.
  Only that active token can heartbeat, complete, or fail the job. Retryable
  failures and expired leases use bounded exponential backoff; attempt-exhausted
  or non-retryable failures enter the visible `failed` dead-letter state.
- `cancel_background_job` revokes queued or active work for the creator or a
  tenant manager. `requeue_background_job` is manager-only and resets a failed
  dead letter without changing its idempotent job identity.

## Background Job Progress UI

- The authenticated layout reads the 20 most recently updated jobs for the
  active restaurant. Database RLS remains authoritative: creators see their
  own jobs, while owners and managers can see all jobs in that tenant.
- The shared client surface names queued, running, retrying, failed,
  dead-lettered, succeeded, and cancelled states without exposing provider
  error text. It links each supported job type back to its invoice, cellar, or
  wine-list surface.
- Active jobs refresh every five seconds and idle discovery refreshes every 15
  seconds. Automatic polling stops after five minutes; a manual 44-pixel
  refresh control restarts it. Focus, page-show, visibility, and reconnect
  events immediately reconcile stale pages.
- Retry appears only for roles with the shared `job:retry` capability. The
  database `requeue_background_job` RPC independently requires a current-tenant
  owner or manager and binds both restaurant and job IDs. An ambiguous retry
  response triggers a read before the UI reports failure.
- This UI does not enqueue work or require a running worker. PDF, invoice OCR,
  and wine enrichment remain on their existing synchronous paths until their
  separately scoped TER-021 migration tasks pass staging soak tests.

## Remaining Handoffs

- TER-003's pinned staging smoke and promotion workflow are in the repository,
  but live isolation and synthetic stateful workflow evidence remain required
  before staging can become a production promotion gate. See
  [`STAGING-SETUP.md`](STAGING-SETUP.md).
- Deploy the TER-021C worker or scheduled processor that consumes the
  `background_jobs` lease RPCs. The lifecycle control plane is present, but the
  worker still needs an operational owner, non-production service-role
  credentials, queue health telemetry, and a kill-and-restart staging drill
  before OCR, enrichment, or PDF routes move off their synchronous paths.
- Finish extracting `auth`, remaining `cellar`, `insights`, and `storage`
  workflow code as those routes are touched.
