# TER-021G security evidence

Reviewed source checkpoint: `315e9b68034479c50e8d2a43d8bee8e9d2d76408`

## Command evidence

`CMD-001` ran `git diff --name-only 235a88dead961453b886928a9e68e8a358084d8e...315e9b68034479c50e8d2a43d8bee8e9d2d76408` from the repository root and exited 0. It returned the 33 paths recorded in the JSON report's `changed_paths` and `captured_diff_paths` arrays.

`CMD-002` ran `gitleaks detect --source . --no-banner --redact --log-opts 235a88dead961453b886928a9e68e8a358084d8e..315e9b68034479c50e8d2a43d8bee8e9d2d76408` from the repository root and exited 0. Gitleaks reported one commit scanned, approximately 82.82 KB scanned, and no leaks found.

`CMD-003` ran `pnpm exec vitest run src/lib/wine-intelligence/enrich-claude-worker.test.ts` with Node 24.16.0 and pnpm 10.33.2 and exited 0. One file and seven tests passed, including strict malformed-response retry and telemetry redaction checks.

`CMD-004` ran `pnpm exec vitest run src/app/api/wines/enrichment-worker-routes.test.ts src/domains/wine-intelligence/wine-enrichment-job-service.test.ts src/lib/jobs/wine-enrichment-worker-rollout.test.ts src/lib/wine-intelligence/enrich-claude-worker.test.ts src/test/contracts/wine-enrichment-worker-migration.test.ts src/worker/handlers.test.ts src/worker/wine-enrichment-handler.test.ts` with the pinned toolchain and exited 0. Seven files and 32 tests passed.

## Surface review

Prompt injection is reviewed. Restaurant wine fields remain untrusted user-role message data at the existing Anthropic boundary; they cannot select a model or tool, and provider output must pass the bounded enrichment schema before any tenant-bound database effect. The new strict worker path converts malformed output into a safe retryable error.

Secrets are reviewed. Both flags default off, the worker continues to receive its service-role credential only through process configuration, examples contain no value, and the exact changed-commit range passed gitleaks.

Authentication and authorization are reviewed. Both HTTP routes authenticate and require `wine:manage` before enqueue. Single-wine enqueue checks the wine and restaurant together. The worker validates type, subject table, UUIDs, restaurant scope, and strict metadata. Migration 0084 grants only the three required RPC signatures to `service_role`; the functions retain tenant predicates and manual-field locks, while staff denial and anonymous denial are acceptance-tested.

Untrusted input is reviewed. Route params use the UUID schema, the idempotency header uses the bounded shared validator, the durable enqueue response and metadata use strict schemas, and malformed worker jobs fail terminally before business work. Provider output is bounded before database writes, and error bodies are reduced to fixed codes.

Exports are reviewed. The durable Supabase job contains IDs plus the allowlisted scope only. The existing Anthropic destination receives the same bounded wine fields as synchronous enrichment. Strict worker Sentry and Railway telemetry contain safe codes and aggregate counts, not wine fields, prompts, provider bodies, credentials, tenant IDs, or raw errors. The opt-in staging browser trace uses synthetic data, is encrypted before GitHub artifact upload, and retains the existing 14-day limit.

The review found one pre-report high-severity telemetry issue: strict worker failures passed raw provider errors and wine identifiers to the existing Sentry calls. The regression test in `CMD-003` failed before the fix and now proves those values are absent; malformed single-wine provider output is also retryable rather than a successful no-op.

No production or staging service was contacted, changed, or activated. Missing TER-021F soak evidence remains a deployment blocker rather than a source-security finding because both activation flags are default off.
