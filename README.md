# Terroir

Restaurant wine-management SaaS. Photograph an invoice on your phone → Azure Document Intelligence extracts the text → Claude structures it into typed line items → save to your cellar. The app also covers physical bin placement, cellar health, reconciliation, partial-bottle close-out, pricing and staff analytics, branded wine lists, bottle-label scan, and team management.

Single Next.js 16 (App Router) deployable backed by Supabase (Postgres + Auth). No separate microservices.

## Requirements

- Node.js >= 20
- pnpm >= 9
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
pnpm verify:api-contract  # verify discovered API routes against the checked-in inventory
pnpm verify:product-conformance # check TER-CF classification artifact drift
pnpm verify:feature-ledger # verify the authoritative feature ledger
pnpm exec tsc --noEmit   # type-check
pnpm run snapshot        # regenerate supabase/schema.snapshot.sql after a new migration
pnpm run types:check     # regenerate and diff the Supabase TypeScript types
pnpm run downs:check     # verify migrations 0011+ have paired down files
```

[`docs/feature-ledger.json`](docs/feature-ledger.json) is the sole authoritative
completion and status ledger for all 269 active core requirements. Run
`pnpm verify:feature-ledger` after changing the ledger or its source requirements;
CI runs the same verification before the typecheck, lint, and test gates. Never
hand-edit the ledger.

The original requirement inventory
([`docs/_archive/app_spec.txt`](docs/_archive/app_spec.txt)) and the session diary
([`docs/_archive/claude-progress.txt`](docs/_archive/claude-progress.txt)) were moved
to [`docs/_archive/`](docs/_archive/README.md) on 2026-08-29. Both are historical
evidence only, both contain drifted claims, and neither determines completion status.

[`docs/PRODUCT-CONTRACT-CONFORMANCE.md`](docs/PRODUCT-CONTRACT-CONFORMANCE.md)
defines the separate product-conformance classification artifact and drift
gate. Neither that gate nor API inventory parity proves release behavior.

For a sanitized local Supabase dataset, see
[`docs/LOCAL-SUPABASE.md`](docs/LOCAL-SUPABASE.md). The seed script defaults to
dry-run and refuses non-local Supabase URLs unless explicitly overridden for
approved staging.

## Deploy

The target is [Railway](https://railway.app/). `railway.toml` at the repo root declares the start command and the healthcheck path; Railway's Railpack builder auto-detects Node, pnpm, and Puppeteer's Chromium deps. Health check lives at `GET /api/health`.

Before your first deploy, set these as Railway service variables:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`
- `AZURE_DOC_INTELLIGENCE_ENDPOINT`, `AZURE_DOC_INTELLIGENCE_KEY`
- `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `SENTRY_AUTH_TOKEN` (optional; enables monitoring and source-map uploads)

See `.env.example` for the full list with notes.

The protected `staging` branch has a separately deployed Railway and Supabase
environment. Its required smoke check binds the deployed candidate to the Git
SHA. A separate PR-preview health workflow exists, but `main` branch protection
does not currently require it. Do not use a PR preview with production data,
provider credentials, or a production service-role key. See
[`docs/STAGING-SETUP.md`](docs/STAGING-SETUP.md) for the current gate state,
isolation requirements, and promotion blockers.

## Repo layout

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the canonical component and
database-boundary map. App Router pages and handlers live in `src/app/`, domain
workflows in `src/domains/`, provider adapters in `src/adapters/`, shared
application modules in `src/lib/`, and database migrations in
`supabase/migrations/`.

## Documentation

- [`AGENTS.md`](AGENTS.md) is the working contract — read it before your first edit.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) owns module and database boundaries.
- [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) owns verified code conventions.
- [`docs/runbooks/README.md`](docs/runbooks/README.md) indexes the operational runbooks.
- [`docs/LOCAL-SUPABASE.md`](docs/LOCAL-SUPABASE.md) owns sanitized local seed setup and coverage.
- [`docs/STAGING-SETUP.md`](docs/STAGING-SETUP.md) owns preview and staging setup.
- [`docs/PRODUCT-CONTRACT-CONFORMANCE.md`](docs/PRODUCT-CONTRACT-CONFORMANCE.md) owns the TER-CF conformance artifact.
- [`docs/runbooks/database-backup-restore.md`](docs/runbooks/database-backup-restore.md) owns backup and restore operations.

## Design

See [`DESIGN.md`](DESIGN.md) at the repo root.
