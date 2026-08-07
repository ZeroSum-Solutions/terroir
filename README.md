# Terroir

Restaurant wine-management SaaS. Photograph an invoice on your phone → Azure Document Intelligence extracts the text → Claude structures it into typed line items → save to your cellar. Also: wine-list editor with publishable public menus, bottle-label scan, team management.

Next.js 16 (App Router) web service plus an isolated background worker, backed
by Supabase (Postgres + Auth). The worker is a second process from the same
repository, not a separate product or data store.

## Requirements

- Node.js 24.16.0
- pnpm 10.33.2
- A Supabase project (URL + publishable key + service-role key)
- An Anthropic API key
- Azure Document Intelligence endpoint + key
- (Optional) A Sentry project for error monitoring

## Development

```bash
pnpm install
cp .env.example .env.local  # fill in the keys
pnpm dev
```

Open http://localhost:3000.

## Common commands

```bash
pnpm dev                 # Next.js dev server (Turbopack)
pnpm build               # production build
pnpm start               # serve the production build locally
pnpm lint                # ESLint
pnpm test                # Vitest unit + route tests
pnpm test:e2e            # Playwright end-to-end
pnpm test:staging        # read-only pinned staging infrastructure smoke
pnpm validate:env        # fail-fast, names-only runtime configuration check
pnpm drill:alerts        # token-gated localhost/staging alert drill
pnpm test:worker         # worker lifecycle, health, and redaction tests
pnpm validate:worker     # names-only worker configuration gate
pnpm worker              # run the standalone worker process
pnpm verify:feature-ledger # verify the authoritative feature ledger
pnpm exec tsc --noEmit   # type-check
pnpm run snapshot        # regenerate supabase/schema.snapshot.sql after a new migration
```

[`app_spec.txt`](app_spec.txt) is the source requirement inventory.
[`docs/feature-ledger.json`](docs/feature-ledger.json) is the sole authoritative
completion and status ledger for all 269 active core requirements.
[`claude-progress.txt`](claude-progress.txt) is historical evidence only and does
not determine completion status. Run `pnpm verify:feature-ledger` after changing
the ledger or its source requirements; CI runs the same verification before the
typecheck, lint, and test gates.

For a sanitized local Supabase dataset, see
[`docs/LOCAL-SUPABASE.md`](docs/LOCAL-SUPABASE.md). The seed script defaults to
dry-run and refuses non-local Supabase URLs unless explicitly overridden for
approved staging.

## Deploy

The target is [Railway](https://railway.app/). `railway.toml` owns the web
service and `railway.worker.toml` owns the separately approved worker service.
The web health check is `GET /api/health`; the worker health check is
`GET /health`. Both services use the exact Node and pnpm versions declared in
`package.json`.

Before your first deploy, set these as Railway service variables:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`
- `AZURE_DOC_INTELLIGENCE_ENDPOINT`, `AZURE_DOC_INTELLIGENCE_KEY`
- `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` (optional; enables source-map uploads)

See `.env.example` for the full list with notes.

Staging is pinned to `https://terroir-web-staging.up.railway.app`. Run
`pnpm test:staging` only as a read-only infrastructure check; it rejects every
other target host. The controlled candidate/promotion/rollback procedure and
the current staging readiness record live in
[`docs/STAGING-SETUP.md`](docs/STAGING-SETUP.md). Do not promote to production
until that gate and the synthetic workflow report are both green.

The worker must first be deployed against the isolated staging Supabase
project. Its credential boundary, config, metrics, drain behavior, and required
kill/restart and dead-letter drill are in
[`docs/runbooks/background-worker.md`](docs/runbooks/background-worker.md).
TER-021E registers the wine-list PDF handler; its web enqueue remains off by
default through `PDF_WORKER_ENABLED`. TER-021F/G must register their handlers
before enabling invoice OCR or wine enrichment. An unregistered job is
deliberately dead-lettered.

The public health endpoint preserves Railway liveness while publishing safe
readiness and degraded-dependency states. See
[`docs/operations/observability.md`](docs/operations/observability.md) for the
configuration gate, metric names, alert thresholds, and incident runbook.

## Repo layout

- `src/app/` — App Router routes. `src/app/(app)/` is the authed shell; `src/app/api/` is the JSON API.
- `src/lib/scanner/` — invoice parsing domain (OCR wrapper, Claude extraction, scoring).
- `src/lib/wine-intelligence/` — drink-window and serving-temp rule engine.
- `src/lib/wine-list/` — list templates + section/item types.
- `src/lib/api/` — cross-cutting route helpers (auth, rate-limit, idempotency).
- `src/worker/` — standalone claim, heartbeat, execution, health, and telemetry runtime.
- `supabase/migrations/` — forward-only SQL migrations. Regenerate `schema.snapshot.sql` after each.

## Design

See `DESIGN.md` at the repo root. The prototype in `Wine Scanner Dashboard/` is the visual reference.
