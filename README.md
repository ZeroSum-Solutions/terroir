# Terroir

Restaurant wine-management SaaS. Photograph an invoice on your phone → Azure Document Intelligence extracts the text → Claude structures it into typed line items → save to your cellar. The app also covers physical bin placement, cellar health, reconciliation, partial-bottle close-out, pricing and staff analytics, branded wine lists, bottle-label scan, and team management.

Single Next.js 16 (App Router) deployable backed by Supabase (Postgres + Auth). No separate microservices.

## Requirements

- Node.js >= 20
- pnpm >= 9
- A Supabase project (URL + publishable key + service-role key)
- An Anthropic API key
- Azure Document Intelligence endpoint + key
- (Optional) An AssemblyAI API key — speech-to-text for voice cellar search
  (`ASSEMBLYAI_API_KEY`). Without it the voice-resolve route fails closed.
- (Optional) A Wine-Searcher API key — retail-price enrichment
  (`WINE_SEARCHER_API_KEY`). Without it pricing intelligence degrades rather than
  breaking; the refresh route returns a "not configured" message.
- (Optional) A Sentry project for error monitoring

## Development

There are two env templates and they are **not** interchangeable:

| Template | What it is | Use it for |
|---|---|---|
| `.env.local.example` | The **local-stack** template. Ships the well-known supabase-cli local defaults — loopback URL, local publishable and service-role keys. Committed on purpose; none of it is a secret. | Local development. This is the one you copy. |
| `.env.example` | The **deployment variable inventory** — every variable the app reads, with notes and no values. | Filling in Railway service variables, or auditing what the app needs. It is not a local-dev starting point. |

This distinction is load-bearing. On a configured machine **`.env.local` holds
*production* credentials** — a hosted Supabase URL and a production service-role key
(`AGENTS.md` non-negotiable #1) — and `pnpm dev` resolves that file silently, with
nothing in the terminal to tell you which database you are on. Copying `.env.example`
and "filling in the keys" is exactly how a local stack ends up pointed at production
data. Start from the local template and the local stack instead:

```bash
pnpm install
cp .env.local.example .env.local   # local Supabase defaults; no production keys
scripts/local/dev-stack.sh         # boots local Supabase, resets + seeds it
pnpm dev -p 3000
```

`dev-stack.sh` creates `.env.local` from `.env.local.example` itself if it is missing,
and refuses to run at all if the configured Supabase URL is not loopback.

Open http://localhost:3000. See
[`docs/runbooks/local-stack.md`](docs/runbooks/local-stack.md) for the full local stack
and [`docs/runbooks/investor-demo.md`](docs/runbooks/investor-demo.md) for why a bare
`pnpm dev` is the wrong entry point.

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

The original requirement inventory ([`app_spec.txt`](app_spec.txt)) and the session
diary ([`claude-progress.txt`](claude-progress.txt)) both live at the **repo root**.
They are historical evidence only, both contain drifted claims, and neither determines
completion status.

**Do not move them into `docs/_archive/`.** They are machine-read, not prose:
`scripts/verify-feature-ledger.mjs` sets `SOURCE_FILE = "app_spec.txt"` and
`src/lib/feature-ledger/verify-feature-ledger.test.ts` resolves both repo-root-relative,
so relocating either reds `pnpm verify:feature-ledger` and with it the required merge
check. That move was attempted on 2026-08-29 and reverted the same day. See
[`docs/_archive/README.md`](docs/_archive/README.md).

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
- `ASSEMBLYAI_API_KEY` (optional; enables voice cellar search)
- `WINE_SEARCHER_API_KEY` (optional; enables retail-price enrichment)
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
