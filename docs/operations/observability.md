# Observability and incident response

## Health contract

The public health endpoint is always HTTP 200 while the web process can answer. This is the Railway liveness contract and must not be changed to a dependency-sensitive status code.

The JSON body separates `readiness` from liveness. `readiness: "ready"` requires a configured core runtime and a successful non-billed Supabase database probe. `readiness: "degraded"` gives names-only configuration failures and dependency states. It never returns credentials, error text, request payloads, user identities, or invoice content. `environment` and `release` are deployment identifiers used by the staging SHA gate; neither contains customer data.

The service currently has no distinct email-delivery service or background worker. Their `not_configured` state is intentional truth, not a passing check. Storage is `unknown` while the database is reachable because the application has not yet gained a safe, independent storage probe.

## Configuration and providers

Railway runs `pnpm validate:env` before `pnpm build`, and `pnpm start` repeats the same gate before the server accepts traffic. The centralized Zod schema blocks a missing or malformed core Supabase, application-origin, or cookie-signing variable and rejects malformed optional values without printing their contents. Invoice scanning, Wine-Searcher, and Sentry are surfaced as `configured` or `degraded`; the health endpoint does not call paid providers. `.env.example` coverage is enforced by a test against the schema's app-owned variable inventory.

## Metrics and structured events

The server emits redacted JSON events with `event`, environment, service, request ID, restaurant ID, operation, and outcome. The metric names currently emitted are `auth_failures`, `scan_latency_ms`, `scan_errors`, `list_generation`, and `reconciliation`. Sentry metric calls are used when available, with the same events retained for Railway log-derived metrics. Jobs and invitation delivery have no real producer yet because the app has no worker or email-delivery integration.

Do not add email addresses, tokens, raw URLs, request bodies, provider responses, invoice text, headers, stack traces, or secret values as structured fields. Sentry is a second privacy boundary: request, user, context, breadcrumb, free-text, transaction, span, error-message, exception-value, and frame-local payloads are removed before send. Browser replay masks all text and inputs, blocks all media, and disables network-body capture; invoice images, OCR text, and scanner edits therefore never enter replay.

## Approved observability destinations

Only these destinations are allowlisted for application telemetry:

- Railway service logs may receive the structured, redacted event fields documented above. Railway access and retention follow the project environment's operator controls.
- The configured Terroir Sentry project may receive scrubbed errors, traces, metrics, and privacy-masked replay. Sentry is disabled when its DSNs are absent.

No observability event may be sent to an arbitrary URL, customer-controlled destination, email address, or webhook. Both destinations fail open for application traffic: an unavailable telemetry exporter must not change a route response. The redaction boundary runs before either export and tests cover secret, email, invoice/OCR, request, and replay-media suppression.

## Alert policy

Configure these production and staging alerts from the named metrics and events:

| Signal | Threshold | Severity | Runbook |
| --- | --- | --- | --- |
| `readiness=degraded` | 2 consecutive checks in 5 minutes | high | this document, Health contract |
| `auth_failures` | 20 in 5 minutes | medium | this document, Triage |
| `scan_errors` | 5 in 10 minutes | high | this document, Triage |
| `scan_latency_ms` | p95 above 90 seconds for 10 minutes | high | this document, Triage |
| `reconciliation` error outcome | 3 in 10 minutes | high | this document, Triage |
| `alert_drill_failure` | 1 event in 5 minutes, staging only | high | this document, Alert drill |

Every alert message must include environment, severity, service, event name, first occurrence, last occurrence, count, a request or job correlation ID, and a link to this runbook. Do not include a user, email, secret, request body, or provider response. Notification rules live in Sentry or Railway rather than source control; an operator must create and exercise the corresponding staging rule before claiming the runtime drill complete.

## Alert drill

The drill forces only the current health response to `readiness: "degraded"`; it does not alter the database, provider configuration, or any persistent service state. It is accepted only on localhost/test/development, or when both `OBSERVABILITY_DRILL_ENABLED=1` and the Railway environment name is exactly `staging`, and only when the request token hashes to `OBSERVABILITY_DRILL_TOKEN_SHA256`. Production refuses the mechanism even if the enable flag and digest are accidentally present.

1. Generate a random token without printing it, set the staging service's `OBSERVABILITY_DRILL_ENABLED=1`, store only the token's SHA-256 digest as `OBSERVABILITY_DRILL_TOKEN_SHA256`, and retain the raw token in the approved secret boundary for the invocation.
2. Set `ALERT_DRILL_BASE_URL` to the staging origin and `ALERT_DRILL_TOKEN` to the raw token in the invoking process environment. Do not put the token in an argument, URL, shell history, screenshot, or committed file.
3. Run `pnpm drill:alerts`. The command refuses a non-staging remote hostname, requires HTTPS remotely, follows no redirects, times out after ten seconds, and fails unless the response contains the full safe alert envelope without reflecting the token.
4. Verify the Sentry or Railway notification contains the same environment, severity, service, event name, first/last occurrence, count, request ID, and runbook link. Capture the dashboard and delivered notification with credentials and personal data masked.
5. Remove or rotate the staging digest after the drill. Record the release SHA, UTC time, alert-rule identifier, delivery result, and evidence paths in the release record.

The unit and local executable drills prove the code path and redaction contract. They are not evidence that an external staging rule delivered a notification; that final operator-owned proof remains required after deployment.

## Triage

1. Read the safe correlation ID from the alert and filter the structured logs or Sentry event by that ID.
2. For `readiness=degraded`, distinguish `database` from names-only `missingConfiguration`; correct Railway variables only through the service's secret manager, then redeploy.
3. For scan errors or latency, inspect the provider phase and metric trend. Do not replay a customer invoice or paste its contents into an incident channel.
4. For auth failures, look for an authentication or capability-denied spike, then inspect deploy and identity-provider changes. Treat a broad spike as a possible security incident.
5. For reconciliation events, pause the affected workflow if failures persist and preserve the correlation IDs for follow-up. Email delivery cannot be remediated here because no delivery provider exists.
6. Record the first and last occurrence, count, environment, operator action, and resolution in the incident tracker without copying sensitive payloads.
