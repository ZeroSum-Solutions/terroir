# Terroir

Restaurant wine-management SaaS. Photograph an invoice on your phone → Azure Document Intelligence extracts the text → Claude structures it into typed line items → save to your cellar. Also: wine-list editor with publishable public menus, bottle-label scan, team management.

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

The target is [Railway](https://railway.app/). `railway.toml` at the repo root declares the start command and the healthcheck path; Railway's Railpack builder auto-detects Node, pnpm, and Puppeteer's Chromium deps. Health check lives at `GET /api/health`.

Before your first deploy, set these as Railway service variables:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`
- `AZURE_DOC_INTELLIGENCE_ENDPOINT`, `AZURE_DOC_INTELLIGENCE_KEY`
- `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` (optional; enables source-map uploads)

See `.env.example` for the full list with notes.

**No staging environment yet** — every push to `main` auto-deploys directly to production. For a prototype this is fine; the moment you have paying customers, add a `staging` branch + a second Railway service (same Nixpacks config, different Supabase project or schema). 10-minute setup in Railway's UI: new service from GitHub, track the `staging` branch, duplicate the env vars pointing at a staging Supabase project.

## Repo layout

- `src/app/` — App Router routes. `src/app/(app)/` is the authed shell; `src/app/api/` is the JSON API.
- `src/lib/scanner/` — invoice parsing domain (OCR wrapper, Claude extraction, scoring).
- `src/lib/wine-intelligence/` — drink-window and serving-temp rule engine.
- `src/lib/wine-list/` — list templates + section/item types.
- `src/lib/api/` — cross-cutting route helpers (auth, rate-limit, idempotency).
- `supabase/migrations/` — forward-only SQL migrations. Regenerate `schema.snapshot.sql` after each.

## Design

See `DESIGN.md` at the repo root. The prototype in `Wine Scanner Dashboard/` is the visual reference.
