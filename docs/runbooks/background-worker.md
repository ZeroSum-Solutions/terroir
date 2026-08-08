# Background worker operations

## Current scope and safety boundary

TER-021C provides a standalone process that consumes the lease-token RPCs from
migration `0074_background_job_lifecycle.sql`. It atomically claims only the
available concurrency, heartbeats active leases, applies a per-job timeout,
records retryable or terminal failures through the database state machine,
and stops taking claims before a bounded signal drain.

TER-021E registers the `wine_list_pdf` handler. TER-021G's idempotent
`wine_enrichment` handler is source-ready but remains unregistered unless its
literal handler flag is enabled. Its web enqueue has a separate default-off
flag. Keep both off until the canonical TER-021F invoice-OCR soak is recorded
and this runbook's TER-021G staging evidence is complete. A row whose type has
no deployed handler records `unsupported_job_type` as a non-retryable failure;
the worker never guesses or runs a synchronous web path.

The source-ready runtime is not deployment proof. Creating a Railway worker
service or paying for queue infrastructure requires the product owner's
approval. Production deployment and production data access are outside this
runbook's autonomous authority.

## Process and credential configuration

Create a distinct non-production Railway service from the same repository and
set its Config-as-Code path to `railway.worker.toml`. The web service continues
to use `railway.toml`. Both processes use Node 24.16.0 and pnpm 10.33.2 from
`package.json`.

The worker receives only the isolated environment's
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Despite the legacy
public prefix on the URL name, both values remain worker process configuration;
the service-role key must never enter the web client, a command argument, a
committed file, health output, or a log. A staging worker must use the staging
Supabase project. Never copy the production key into staging.

| Variable | Default | Contract |
| --- | ---: | --- |
| `TERROIR_RELEASE_SHA` | Railway Git SHA | Exact commit for local CLI deployments; overrides provider metadata in release logs. |
| `WORKER_ID` | generated host/replica ID | 1-128 safe identifier characters |
| `WORKER_CONCURRENCY` | 4 | maximum active jobs, 1-20 |
| `WORKER_CLAIM_LIMIT` | 4 | per-poll claim bound, never above concurrency |
| `WORKER_POLL_INTERVAL_MS` | 1000 | delay between claim cycles |
| `WORKER_LEASE_SECONDS` | 120 | database lease, 15-3600 seconds |
| `WORKER_HEARTBEAT_INTERVAL_MS` | 30000 | less than half the lease duration |
| `WORKER_DATABASE_TIMEOUT_MS` | 10000 | less than heartbeat interval |
| `WORKER_DATABASE_ERROR_BACKOFF_MAX_MS` | 30000 | maximum poll delay during a DB outage |
| `WORKER_JOB_TIMEOUT_MS` | 900000 | handler execution deadline |
| `WORKER_SHUTDOWN_GRACE_MS` | 25000 | signal drain before retryable abort |
| `WORKER_BACKOFF_BASE_SECONDS` | 30 | database exponential-backoff base |
| `WORKER_QUEUE_HEALTH_INTERVAL_MS` | 10000 | aggregate queue sample cadence |
| `WORKER_HEALTH_STALE_AFTER_MS` | 60000 | readiness fails after stale DB success |
| `WORKER_QUEUE_AGE_ALERT_MS` | 300000 | action-required queue-age threshold |
| `WORKER_DEAD_LETTER_ALERT_COUNT` | 1 | action-required terminal-job threshold |

The web service separately owns `PDF_WORKER_ENABLED`. Missing, `0`, or any
value except literal `1` keeps PDF generation synchronous. Do not put this flag
on the worker as a handler kill switch: queued and retrying work must remain
processable during web rollback.

Wine enrichment uses two independent flags. Set
`WINE_ENRICHMENT_HANDLER_ENABLED=1` only on a worker after the dependency gate,
deploy it, and confirm `wine_enrichment` appears in `registered_handlers` before
setting `WINE_ENRICHMENT_WORKER_ENABLED=1` on the web service. Missing, `0`, or
any value except literal `1` preserves synchronous enrichment. Never enable web
enqueues before a compatible handler is healthy. During rollback, disable web
enqueues first and leave the handler enabled until queued, retrying, and active
wine-enrichment jobs drain.

`pnpm validate:worker` validates names and shapes before build. Its error only
lists invalid variable names. The `GET /health` response is 200 only after a
successful database operation and before that success becomes stale. A 503
causes Railway to withhold readiness or replace a failed replica.

Before enabling the first handler, inspect staging's aggregate queue state. A
non-empty queue is a stop condition until every queued type has an owning
handler or an approved cleanup disposition. Health exposes
`registered_handlers` and `accepting_jobs` so an idle control-plane deployment
cannot be mistaken for active job processing.

The repository's `railpack.json` installs Debian's `chromium` package in both
the build and final runtime images and sets Puppeteer's executable to
`/usr/bin/chromium`. Both web and worker manifests run
`pnpm validate:worker-browser`; the web fallback needs the same executable as
the asynchronous worker. The command fails the image build unless that path is
an executable file and can launch headless with the worker's sandbox flags,
load a local data document, and emit its DOM. `.puppeteerrc.cjs` disables
Puppeteer's archive downloads, so a provider cache or incomplete extraction
cannot silently determine runtime readiness. Do not enable the PDF queue when
the build omitted this gate, even if the control-plane health check is
otherwise ready.

## Wine-list PDF pilot

Migration `0077_wine_list_pdf_artifacts.sql` creates the private
`generated-exports` bucket. The worker accepts only a tenant UUID, a
`wine_lists` subject UUID, and an optional allowlisted template from durable
job input. It re-queries the list through the service-role client, renders the
PDF, and upserts exactly one canonical object per restaurant, list, and
template. The job result contains only that canonical path, filename, list ID,
and template; it never contains PDF bytes, a signed URL, restaurant content,
or a credential.

The authenticated `POST /api/pdf` route keeps its synchronous binary response
while the flag is off. With the flag on, a generation request requires an
`Idempotency-Key`, returns `202` with the durable job ID, and lets the client
poll the same route with that job ID. Completed downloads re-check tenant
scope, job type, subject, result shape, and the exact artifact path before
Storage read. Disabling the flag stops new enqueues but deliberately keeps
completed-job downloads available.

Before setting the flag to `1`, apply migration 0077, deploy this handler,
confirm worker health reports one registered handler, and verify the queue has
no unsupported types. Confirm the compatible web release is live and have pilot
sessions reload so they can handle the `202` polling response before enabling
the flag. Then run the PDF browser proof and required worker drill against
synthetic staging data.

## Lifecycle and recovery

One poll requests at most the smaller of free capacity and
`WORKER_CLAIM_LIMIT`. Migration 0074 recovers expired leases inside the next
claim transaction: an attempt below its limit moves to `retrying` with
exponential backoff; an exhausted attempt becomes a visible dead letter. Only
the worker ID and opaque lease token returned by the claim may heartbeat,
complete, or fail that attempt.

A timed-out completion RPC is an ambiguous outcome: the runtime does not issue
a contradictory failure transition. It records `job_completion_unknown` and
lets the durable row show whether completion committed or the lease later
expired. Handler output idempotency makes the eventual retry safe.

Consecutive database failures exponentially slow the polling loop up to
`WORKER_DATABASE_ERROR_BACKOFF_MAX_MS`. Error logs are emitted on the first and
power-of-two failures so an outage remains visible without flooding Railway.

`SIGTERM` and `SIGINT` stop new claims and retain health as `draining`. Active
handlers receive the configured grace period. Work still active at the
deadline receives an abort signal and is recorded as retryable
`worker_shutdown` when the lease remains valid. An abrupt kill cannot run that
cleanup; its lease expires and the next worker recovers it through the claim
RPC. Every business handler must therefore make its output idempotent by the
durable job ID or business idempotency key and honor its abort signal.

## Wine-enrichment rollout

TER-021G is dependency-gated. Before any staging activation, attach the
canonical TER-021F completion record proving the invoice-OCR soak. Source,
unit, SQL, or build evidence does not satisfy that dependency.

After the dependency is closed, use only synthetic tenant-owned wines and:

1. Apply migration `0084_wine_enrichment_worker_authority.sql`, run its SQL
   acceptance test, and verify authenticated staff remain denied while the
   worker service role can invoke only the tenant-bound enrichment RPCs.
2. Deploy the handler flag first. Confirm the exact candidate SHA is healthy,
   the handler is registered, and no unsupported queued type exists.
3. Enable the web enqueue flag and prove bulk and single-wine routes return one
   durable job for the same idempotency key while cross-tenant subjects remain
   undisclosed.
4. Prove a successful job preserves every manual-field lock, applies its
   handler-owned wine effect once, and records no provider body, prompt, tenant
   ID, or secret in result data or logs.
5. Exercise a retryable provider failure through bounded backoff and a terminal
   provider failure into the dead-letter state. Record only safe error codes.
6. Repeat the kill/restart and duplicate-delivery drill below for
   `wine_enrichment`, proving one business effect after lease recovery.
7. Set the web flag back to `0`, prove new requests use synchronous enrichment,
   and drain durable work before considering the rollout complete.

Retain the exact SHA, deployment IDs, job IDs, attempt/state transitions,
effect counts, redacted queue/health evidence, and rollback result. Until all
items exist, the handler and enqueue flags remain `0` and production is out of
scope.

## Metrics, alerts, and triage

Railway logs are the approved worker telemetry destination. Events use an
allowlist and exclude metadata, result bodies, tenant IDs, provider responses,
URLs, credentials, and raw errors. Configure the thresholds listed in
[`observability.md`](../operations/observability.md) before calling staging
observation complete.

For a dead letter, filter by the safe job correlation ID, inspect only its
error code and attempt history, and identify the owning handler. Do not copy
the job payload into logs or an incident. A manager may requeue only after the
underlying defect is fixed. A rising queue age with no dead letters usually
means insufficient healthy capacity or a stuck provider; lease-loss spikes
usually mean database latency, event-loop starvation, or replica churn.

## Required staging kill/restart and dead-letter drill

This drill is mandatory after TER-021E registers the first synthetic-safe,
idempotent handler and after the approved staging worker service exists. It is
not executable from source alone and must never use a customer job.

1. Record the candidate SHA, staging web and worker deployment IDs, migration
   0074 presence, and redacted variable-name inventory. Confirm the worker and
   web services use the staging Supabase project without recording key values.
2. Enqueue one synthetic handler-owned job through its authenticated staging
   test harness. Record only the job ID and intended idempotent effect count.
3. Wait for `running`, terminate the staging worker replica through the
   approved Railway control, and keep it stopped beyond the lease duration.
4. Start a fresh replica. Prove the same job transitions through lease timeout
   recovery and reaches `succeeded`, its attempt count increases, and the
   handler-owned business effect exists exactly once.
5. Enqueue one synthetic poison job whose handler returns a safe retryable
   failure. Prove exponential `run_after` growth, termination at
   `max_attempts`, non-null `dead_lettered_at`, and delivery of the configured
   dead-letter alert with no payload or secret.
6. Requeue the poison job only after switching the synthetic handler to
   success. Prove the same job ID succeeds, then remove all synthetic rows and
   artifacts through the handler-owned teardown.

Retain timestamps, job IDs, state transitions, attempt counts, effect counts,
deployment IDs, alert-rule ID, and redacted screenshots. A unit-test pass, a
green source build, or a 200 worker health response is not a substitute for
this drill.

## Rollback

Set `PDF_WORKER_ENABLED=0` and `WINE_ENRICHMENT_WORKER_ENABLED=0` on the web
service before stopping the worker. This immediately restores synchronous
generation and enrichment for new requests. Let queued, retrying, and active
PDF and wine-enrichment jobs drain with their handlers still deployed, then
remove the worker service or roll it back to the prior known-good SHA.
Queued and retrying rows remain durable; do not delete or rewrite them during
an application rollback. If a handler is rolled back, keep its enqueue path
disabled until a compatible handler is deployed and the queue is inspected.
