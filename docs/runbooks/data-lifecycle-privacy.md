# Data lifecycle and privacy runbook

TER-024 defines Terroir's application-level data lifecycle. It is an operational
control, not legal advice: an operator must reconcile these defaults with the
restaurant contract, applicable law, and each provider's active retention
setting before production use.

## Operating rules

- Storage object names are tenant-scoped. New invoice objects use
  `<restaurant-id>/<scan-id>[_pageN].<extension>` and wine images use
  `<restaurant-id>/<wine-id>.<extension>`. Generated wine-list PDFs use the
  bounded path `<restaurant-id>/<list-id>_<template>.pdf`.
- `invoice-images`, `wine-images`, and `generated-exports` are private. The
  application stores no public wine-image or export URL. It issues authenticated
  image signed URLs for five minutes and streams PDF artifacts only after a
  fresh tenant/job check.
- `0076_private_media_bucket_provisioning.sql` creates either governed bucket
  when an older environment is missing it and idempotently reapplies the
  private ten-mebibyte MIME allowlist. Run the TER-024 SQL acceptance after
  `0075` and `0076`. Migration `0077_wine_list_pdf_artifacts.sql` provisions
  `generated-exports` with its tenant policy and PDF-only limit. A missing
  governed bucket is a failed privacy rollout.
- A tenant deletion removes all three bucket prefixes before the database cascade.
  It fails before the database deletion if Storage cleanup fails. A retry is
  safe because the removal calls are idempotent. Cleanup recursively covers
  legacy nested paths with an eight-level and 10,000-entry fail-closed bound.
  Provider-returned names must remain single safe path segments under the
  tenant prefix; malformed, absolute, or traversal-like paths fail closed.
  Migration `0079` orders pour events, list items, and receipt inventory ahead
  of the root cascade so their individual-wine history guards cannot strand the
  tenant database graph.
- Deleting one wine list makes its generated PDFs unreadable immediately because
  the Storage policy requires the referenced list to exist. Its bounded physical
  objects remain until tenant deletion removes the restaurant prefix.
- A wine deletion removes the associated image variants after its atomic
  database deletion. If Storage is temporarily unavailable, the API returns a
  failure and a keyed retry repeats only the cleanup.
- An Auth-user deletion cascades memberships and short-lived control records.
  It nulls restaurant-owned audit attribution rather than preserving an orphan
  user identifier. The Auth operator must transfer or delete restaurants owned
  solely by that user first; this repository does not hold an Auth admin key or
  expose an account-deletion endpoint.
- No retention job runs automatically in production. A destructive run needs
  explicit owner approval and a verified current backup. Never use logs,
  telemetry, screenshots, or tickets to copy invoice text, images, email
  addresses, signed URLs, tokens, or provider responses.

## Data map and defaults

| Data class | System owner | Default retention | Deletion or tombstone behavior |
| --- | --- | --- | --- |
| Supabase Auth account and login email | Supabase Auth operator | Until an authorized account deletion | Auth removes the account; app memberships and idempotency/rate-limit records cascade, while restaurant audit attribution becomes `NULL`. |
| Restaurant, memberships, cellar, pours, lists, and pricing data | Restaurant owner | Active tenant plus contractual recordkeeping period; product default review at least annually | Owner-initiated restaurant deletion cascades tenant rows after Storage cleanup. Historical wine deletion remains restricted by business references. |
| Invoice image, OCR JSON, supplier/invoice fields, and line items | Restaurant owner | 365 days for images/OCR; invoice metadata requires a contract/legal review before any purge | Tenant deletion removes the Storage prefix then cascades rows. No automatic per-scan purge is enabled because it must coordinate image and database deletion. |
| Wine hero image (including a bottle image uploaded as the hero) | Restaurant owner | While its wine exists | The manager image endpoint removes all image variants. Wine deletion repeats object cleanup after the atomic row deletion. There is no separate bottle-image bucket. |
| Invitation email and token | Restaurant owner | 30 days after expiry or cancellation | Expired invitations cannot be accepted. A manually approved cleanup may delete the row; never emit the email or token to telemetry. |
| API idempotency and rate-limit records | Application operator | 24 hours / configured rate-limit window | Existing cleanup removes them; Auth-user deletion cascades user-bound records. |
| Background-job metadata and result | Restaurant owner and worker operator | 30 days after terminal status, once a worker-owned cleanup is deployed | PDF results contain a canonical tenant path and safe filename only. Do not place raw invoice content, signed URLs, credentials, or personal data in JSON payloads. The current worker lifecycle has no row-retention runner. |
| Generated CSV export response | Requesting authenticated member | Request lifetime only | The application returns the CSV directly and does not persist it in application Storage. The recipient controls any downloaded copy. |
| Generated wine-list PDF artifact | Restaurant owner | Latest snapshot per list/template until replacement or tenant deletion | The private bucket holds at most one classic, modern, and minimal artifact per list. List deletion revokes reads immediately; bounded physical objects remain until tenant deletion removes the prefix. Worker retries and later requests upsert the same canonical path. |
| Railway logs and Sentry telemetry | Platform operator | Provider-configured; record the live setting in the staging evidence | Application events are redacted before egress. Sentry removes request/user/context/breadcrumb/exception payloads and replay masks all text and blocks media. |
| Azure OCR and Anthropic extraction payloads | Provider account owner | Provider-configured; confirm account controls before production | Invoice data is sent only for the authorized scan. Do not claim a provider retention period without current account evidence. |
| GitHub backup and workflow artifacts | GitHub workflow operator | Backup artifacts: 90 days; staging-smoke artifacts: 14 days | Artifacts contain no application secrets or customer payloads; backup lifecycle is governed by the database backup runbook. |

## Provider retention register

The repository does not have live provider-account access, so it must not
invent provider retention periods. Before production use or a retention run,
the named account owner records the current setting, evidence timestamp, and
next review date in the redacted release evidence:

| Provider | Data category | Required current-setting evidence | Owner |
| --- | --- | --- | --- |
| Supabase Storage and database backups | Private object and database copies | Bucket versioning/lifecycle, deleted-object recovery, backup retention, and region | Supabase project owner |
| Azure Document Intelligence | Invoice image/OCR request payload | Training/content logging, diagnostic-log retention, and region | Azure account owner |
| Anthropic extraction | Structured invoice-extraction prompt/response | API data-retention setting, abuse-monitoring exception, and region | Anthropic account owner |
| Railway | Application logs | Log retention and export destinations | Railway project owner |
| Sentry | Redacted error events and masked replay metadata | Event retention, replay retention, and allowed project members | Sentry project owner |
| GitHub Actions | Database backup and staging-smoke artifacts | Artifact retention and repository-access review | GitHub workflow owner |

A record may contain setting names, boolean controls, durations, region,
account owner, and timestamps. It must not contain customer content, URLs,
credentials, raw provider responses, tokens, or object paths.

## Approved deletion procedure

1. Confirm an owner approved the tenant or retention operation and that the
   latest backup health evidence is successful. This approval is mandatory for
   production retention work, even when the target is a single restaurant.
2. Use a synthetic staging tenant first. Verify the authenticated caller is an
   owner, then delete through `DELETE /api/restaurant/{id}`. Do not invoke SQL
   directly to bypass the Storage cleanup.
3. Confirm all three Storage bucket prefixes are empty using an authorized staging
   session, and confirm the tenant cannot be read through the database or
   signed-image endpoints. Record only environment, release SHA, operation
   result, counts, and timestamps.
4. For an Auth-user deletion, first transfer or delete each owned restaurant.
   Delete the Auth user through Supabase's approved operator procedure, then
   confirm memberships and short-lived user-bound records are absent and audit
   attribution columns are null.
5. Keep customer content out of the evidence. A suitable record contains no
   raw names, emails, object names, invoice numbers, OCR text, signed URLs, or
   provider error values.

## Rollback boundary

`0075_privacy_storage_lifecycle.down.sql`,
`0076_private_media_bucket_provisioning.down.sql`,
`0077_wine_list_pdf_artifacts.down.sql`, and
`0079_restaurant_delete_dependents.down.sql` are intentionally fail-closed,
non-executable rollback records. Reverting or deleting the private buckets,
broadening their old prefix-only policies, or dropping the dependency-order
trigger would re-expose, lose, or strand tenant data. If application code must
roll back, keep the private paths, signed-URL contract, and deletion trigger;
rehearse the target revision against a restored staging backup, and introduce
any necessary compatibility change as a new forward migration.

A web rollback disables `PDF_WORKER_ENABLED`; it does not make exports public
or delete artifacts while queued work may still reference them.
