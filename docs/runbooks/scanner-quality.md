# Scanner quality and provider resilience

## Release gate

`pnpm run scanner:score` is the mandatory non-billed TER-022 gate. It reads the
versioned synthetic corpus, the proposed release floors, and the committed
contract baseline. It makes zero network calls and exits nonzero for any quality,
line-association, low-confidence review, p95 latency, provider-failure, cost, or
baseline-regression breach.

The fixture report is contract evidence, not real-provider evidence. The
historical 2026-04-18 aggregate is retained separately because it did not record
ground truth, field accuracy, cost, model identity, or fixture provenance.
Self-reported confidence must never be presented as accuracy.

## Thresholds

The enforced proposal is producer and cuvee exact match at least 90%, vintage at
least 95%, format at least 95%, quantity and cost at least 98%, invoice-line recall
and precision at least 98%, and exact line association at least 98%. Invoice p95
must be below 90 seconds, bottle p95 below 30 seconds, provider failure below 5%
over at least 20 canaries, and per-case provider cost no more than $0.25 per
invoice or $0.05 per bottle. No low-confidence line may be committed without an
explicit review.

These numbers are the specification's proposed floors and are deliberately marked
`pending_product_owner` in the threshold file. They block regressions now, but do
not become ratified or real-provider-proven merely because the fixture gate passes.

## Provider failure behavior

Scanner providers collapse into a fixed taxonomy: rate limited, timeout, bad
input, unavailable, and unknown. Rate limits, timeouts, and provider
unavailability are retryable; bad input and unknown failures are not retried
automatically. Public responses never contain provider messages, request IDs,
invoice text, image bytes, endpoints, or response bodies.

Invoice extraction failures preserve OCR text only where the existing authenticated
manual-entry flow already needs it. A provider failure never writes inventory.
Low-confidence results enter review; both inventory-save paths enforce the review
again on the server, and the durable scan commit records reviewer and timestamp in
the same transaction as the inventory commit.

## Approved real-provider canary

A real-provider canary is not part of ordinary CI. Before enabling a schedule, the
product owner must approve the provider spend and threshold revision, and the
canary corpus must be synthetic or have documented fixture consent. Run a minimum
rolling window of 20 canaries, record only aggregate field metrics, latency,
failure taxonomy, and estimated cost, and verify that logs and artifacts contain no
image, OCR text, line item, provider response, user identity, or secret.

Do not add provider credentials to the fixture workflow. Store approved canary
credentials only in the repository's protected secret boundary. A failed or
undersized canary window is unavailable evidence, never a pass.

## Rollback

Revert the source commit and apply
`supabase/migrations/down/0078_scanner_low_confidence_review.down.sql`. The down
migration restores execute access to the previous atomic commit function before it
drops the review wrapper and audit columns. Do not apply the down while the newer
web route is live because that route calls the review wrapper.
