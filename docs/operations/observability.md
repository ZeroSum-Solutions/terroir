# Observability and incident response

## Health contract

The public health endpoint is always HTTP 200 while the web process can answer. This is the Railway liveness contract and must not be changed to a dependency-sensitive status code.

The JSON body separates `readiness` from liveness. `readiness: "ready"` requires a configured core runtime and a successful non-billed Supabase database probe. `readiness: "degraded"` gives names-only configuration failures and dependency states. It never returns credentials, error text, request payloads, user identities, or invoice content.

The service currently has no distinct email-delivery service or background worker. Their `not_configured` state is intentional truth, not a passing check. Storage is `unknown` while the database is reachable because the application has not yet gained a safe, independent storage probe.

## Configuration and providers

Railway runs `pnpm validate:env` before `pnpm build`. It blocks deployment when a core Supabase or cookie-signing variable is missing, malformed, or too short. Invoice scanning, Wine-Searcher, and Sentry are surfaced as `configured` or `degraded`; the health endpoint does not call paid providers.

## Metrics and structured events

The server emits redacted JSON events with `event`, environment, service, request ID, restaurant ID, operation, and outcome. The metric names currently emitted are `auth_failures`, `scan_latency_ms`, `scan_errors`, `list_generation`, and `reconciliation`. Sentry metric calls are used when available, with the same events retained for Railway log-derived metrics. Jobs and invitation delivery have no real producer yet because the app has no worker or email-delivery integration.

Do not add email addresses, tokens, raw URLs, request bodies, provider responses, invoice text, headers, stack traces, or secret values as structured fields. Sentry is a second privacy boundary: request, user, and context payloads are removed before send.

## Alert policy

Configure these production and staging alerts from the named metrics and events:

| Signal | Threshold | Severity | Runbook |
| --- | --- | --- | --- |
| `readiness=degraded` | 2 consecutive checks in 5 minutes | high | this document, Health contract |
| `auth_failures` | 20 in 5 minutes | medium | this document, Triage |
| `scan_errors` | 5 in 10 minutes | high | this document, Triage |
| `scan_latency_ms` | p95 above 90 seconds for 10 minutes | high | this document, Triage |
| `reconciliation` error outcome | 3 in 10 minutes | high | this document, Triage |

Every alert message must include environment, severity, service, event name, first occurrence, last occurrence, count, a request or job correlation ID, and a link to this runbook. Do not include a user, email, secret, request body, or provider response. There is no configured notification destination or staging service in this repository; an operator must create the corresponding Sentry or Railway rules and test them before claiming the staging drill complete.

## Triage

1. Read the safe correlation ID from the alert and filter the structured logs or Sentry event by that ID.
2. For `readiness=degraded`, distinguish `database` from names-only `missingConfiguration`; correct Railway variables only through the service's secret manager, then redeploy.
3. For scan errors or latency, inspect the provider phase and metric trend. Do not replay a customer invoice or paste its contents into an incident channel.
4. For auth failures, look for an authentication or capability-denied spike, then inspect deploy and identity-provider changes. Treat a broad spike as a possible security incident.
5. For reconciliation events, pause the affected workflow if failures persist and preserve the correlation IDs for follow-up. Email delivery cannot be remediated here because no delivery provider exists.
6. Record the first and last occurrence, count, environment, operator action, and resolution in the incident tracker without copying sensitive payloads.
