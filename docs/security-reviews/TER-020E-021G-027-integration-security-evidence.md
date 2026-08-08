# TER-020E, TER-021G, and TER-027 integrated security evidence

## Scope and layered review

The integrated source review covered exact clean commit
`1924d7e3cd7e7f860d86356be2ce9a5154421c59` against canonical integration base
`235a88dead961453b886928a9e68e8a358084d8e`. The structured report uses
`5bc2555...HEAD` as its captured overlay because the TER-020E and TER-021G
layers through `5bc2555` already have schema-valid path-complete reports. The
independent integrated reviewer nevertheless inspected the whole canonical
range, including the interaction between the older generic job RPC and the
new worker handler.

`git diff --name-only 5bc2555...HEAD` exited 0 and exactly matched every path
classified in the structured report. The report and completion records are
included in the same final path capture. `gitleaks detect --source .
--no-banner --redact --log-opts 5bc2555..HEAD` is rerun after the evidence
commit so the complete recorded range, including this document, is scanned.

## Findings and rechecks

The first independent integrated review returned FAIL with one high-severity
authorization finding and one low-severity fail-open input finding. A tenant
staff member could call the authenticated `enqueue_background_job` RPC
directly with `wine_enrichment`, bypassing the manager-only web capability and
expensive-work rate limit. Migration 0086 now authenticates first, validates
the job type, requires manager-or-owner membership for `wine_enrichment`, and
retains staff access only for the other supported jobs. The security-definer
function keeps an empty search path and its existing narrow execute grant.

The 0086 contract test passed. Live isolated PostgreSQL then passed migration
0086 and transactional acceptance proving manager wine-enrichment success,
staff wine-enrichment denial with no persisted job, and continued staff
invoice-OCR success. The paired down migration restored the prior contract and
the complete 0074 lifecycle acceptance passed; reapplying 0086 and rerunning
its acceptance passed. Neighboring 0084 worker-authority and 0085 market-shift
acceptance also remained green.

The CSV export previously treated an unknown `range` value as all time. Its
query now passes through the same bounded enum-validation boundary used by
analytics APIs before any tenant table is selected. The route-family
regression proved an unknown range returns 400 and makes no database call.

At corrected commit `1924d7e`, the same independent reviewer returned PASS
with no P0, P1, or P2 finding. Its focused recheck passed eight files and 57
tests, the 0086 SQL acceptance, all paired-down checks, and exact-range
gitleaks. Authorization-before-egress and export policy both passed.

## Integrated gates

On Node 24.16.0 and pnpm 10.33.2, the full suite passed 192 files and 1,726
tests. TypeScript no-emit, ESLint, and the production build passed; the build
compiled 50 static pages. Contract tests passed 19 files and 147 tests. API
inventory remains 92 implemented operations with zero planned operations; the
269-requirement feature ledger and 23-route, 345-control UI inventory remain
green.

The generated snapshot is exact at 85 migrations and 452319 generator bytes.
All 75 forward migrations from 0011 onward have unique paired down migrations.
Actionlint, both opt-in Playwright test collections, the security-report
validators, canonical document checks, and diff checks pass. Browser
collection is not runtime evidence; exact-candidate staging execution remains
pending.

## Six surfaces and exports

No model, retrieval, tool, or prompt-control path changed. Wine fields remain
untrusted user-role provider input, provider output is schema-bounded before
tenant effects, and strict worker telemetry contains fixed phases and
aggregate counts rather than prompts, raw errors, credentials, or tenant IDs.

Protected routes authenticate before input-driven work. The web capability,
database enqueue RPC, handler validation, service-role worker RPCs, RLS, and
tenant predicates now form independent authorization layers. Job type,
idempotency key, subject, metadata size and shape, date range, custom dates,
top-N, and provider output all fail closed at bounded parsers or RPC checks.

The mapped exports are: durable Supabase job metadata; the existing Anthropic
wine-enrichment request; redacted Sentry and Railway operational telemetry;
the authenticated tenant-scoped analytics CSV response; and encrypted GitHub
staging evidence artifacts. These destinations and data classes are
allowlisted by the data-lifecycle runbook. The CSV is request-lifetime only,
formula-neutralized, and fails before queries for invalid ranges. Synthetic
browser evidence is encrypted before upload, plaintext is deleted, and the
encrypted artifact is retained for 14 days. No unresolved security finding or
accepted risk remains.

The final release verifier also checked citation resolvability. It found three
TER-020E static ranges whose end lines exceeded their source files; the ranges
were corrected to the exact existing end lines without changing any source or
security conclusion. All structured security reports were then revalidated.
