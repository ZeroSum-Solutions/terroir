# CONVENTIONS

## TypeScript
- `strict: true` across the board
- No `any` without an inline `// eslint-disable-next-line` justification
- Generated types in `src/types/database.ts` are read-only — regenerate via `pnpm types:gen`

## React / Next.js
- **Server Components by default.** Add `"use client"` only when the component needs hooks, browser APIs, or event handlers.
- **App Router only** — no `pages/` directory.
- Route segments use kebab-case folders (e.g. `price-comparison/`, `wine-lists/`).
- Client state stays minimal; Supabase is the source of truth. Use React Query only if added later — not currently in deps.
- Mobile-first responsive; touch targets ≥ 44px (FAB pattern present).

## Styling
- **Tailwind CSS v4** via `@tailwindcss/postcss` — no CSS Modules.
- Component variants: **class-variance-authority (CVA)** + `clsx` + `tailwind-merge`.
- Icons: `lucide-react` only.
- No competing UI libraries (no MUI, no Chakra, no shadcn/ui currently — CVA primitives are bespoke).

## API Routes
- All inputs validated with **Zod** at the route boundary.
- Auth enforced via `src/lib/supabase/` server client factory before any DB access.
- Standard error envelope (see `src/lib/api/`); never leak raw Postgres errors.
- Idempotency via `scan_idempotency` table for write-heavy flows.

## Database
- **Forward-only migrations** in `supabase/migrations/` — no destructive `down` migrations on prod.
- `pnpm downs:check` enforces this in CI.
- `pnpm snapshot:check` ensures `schema.snapshot.sql` stays in sync.
- Business rules live in **DB functions** (`record_pour`, `reconcile_open_bottle`, etc.) when they require atomicity or RLS-aware logic.
- Row-Level Security on all tables; access gated by `is_member` / `is_member_with_role`.

## AI Integration
- All Anthropic calls go through `src/lib/ai/` wrapper — no direct SDK usage in route handlers.
- Claude responses validated with Zod before any DB write.
- System prompts kept in dedicated files, not inlined.

## Testing
- **Vitest** for unit + route logic; environment is `happy-dom`.
- **Playwright** for E2E; tests live in `e2e/`.
- Test files colocated with source as `*.test.ts` for unit tests.
- E2E covers critical user journeys: invoice scan, pour, reconcile, public list publish.

## Observability
- **Sentry** wraps the Next.js build (see `next.config.ts`).
- Server, edge, and client all instrumented separately.
- Source maps uploaded on Railway deploy.

## Naming
- Files: kebab-case for routes/utilities, PascalCase for React components.
- DB columns: `snake_case`.
- Env vars: `SCREAMING_SNAKE_CASE`, `NEXT_PUBLIC_` prefix only for browser-exposed vars.

## Commits / Process
- Schema changes require `pnpm snapshot` + `pnpm types:gen` before commit.
- E2E + unit tests must pass before merge.
