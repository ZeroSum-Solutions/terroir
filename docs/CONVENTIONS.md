# Conventions

Every claim here was verified against the tree at `8c777d5` on 2026-08-29. Where a
convention is aspirational rather than universal, it says so and gives the current
number. Do not add a rule here you have not verified — a convention doc that lies is
worse than no convention doc. This file replaces `.planning/codebase/CONVENTIONS.md`,
which was deleted after four months of drift.

## TypeScript

- `strict: true`, `noEmit: true`. `tsc --noEmit` is its own CI gate.
- `src/types/database.ts` is **generated** — never hand-edit. Regenerate with
  `pnpm types:gen`; CI verifies it against the migrations via `pnpm types:check:local`.
- `any` is effectively absent from non-test `src/` (verified: zero real `any` types).
  Keep it that way; if you must, justify it inline.
- 19 `eslint-disable` comments exist in non-test `src/`, each with an inline
  justification. Follow that pattern — a bare disable will not pass review.

## React / Next.js

- **App Router only.** No `pages/` directory.
- **Server Components by default.** 19 of 21 route `page.tsx` files are server
  components; `'use client'` sits at feature/leaf level (~35% of `.tsx` files).
  Keep it off layouts.
- Route segments are kebab-case (`price-comparison/`, `wine-lists/`).
- Mobile-first. Touch targets ≥ 44px — `min-h-11` / `h-11` / `w-11` is the dominant
  convention and is applied to links and inputs too, not just buttons.
- **No React Query, no SWR** — not in `package.json`. Client components use raw
  `fetch` plus `router.refresh()` after mutation. If you add a caching layer, it is a
  deliberate architecture change, not a convenience import.

## Styling

- **Tailwind CSS v4** via `@tailwindcss/postcss`. No CSS Modules.
- **No CVA, no shadcn/ui, no Radix.** Variants are hand-specified at the call site
  today. This is a known gap, not a convention to imitate — see the refactor plan's
  `packages/ui`.
- Icons: `lucide-react` only.
- **Design tokens are enforced.** `pnpm check:design` runs four gates in CI: palette,
  contrast, token-sync, and a typography ratchet. Colour adoption is near-total;
  arbitrary `text-[Npx]` sizes carry a frozen baseline of ~1,248 that may only shrink.
  Never grow a baseline without `--update --allow-growth` and a reason.
- `DESIGN.md` at the repo root is the design contract. `docs/design/*` are archived
  predecessors — do not build from them.

## API routes

- Auth via the shared helpers in `src/lib/api/auth.ts` — `requireAuth`,
  `requireMembership`, `requireOwner`, `requireRole`. 90 of 93 route files use them;
  the three exceptions (`dev-login`, `health`, `team/accept-invite`) are deliberate
  and documented.
- Errors via `src/lib/api/errors.ts` (`Errors.*`, typed `ErrorEnvelope`). Never leak a
  raw Postgres error.
- Handlers wrapped with `withApiHandler` for uniform Sentry-wrapped error handling.
- **Zod at the boundary is the target, not yet the reality** — 44 of 93 route files
  use zod today; the rest hand-roll validation. New routes use zod. Routes you touch
  get migrated.
- Idempotency via the `scan_idempotency` table for write-heavy flows.

## Database

- **Migrations are forward-numbered with paired downs.** `supabase/migrations/NNNN_<name>.sql`
  and `supabase/migrations/down/NNNN_<name>.down.sql`. `pnpm downs:check` **requires**
  the pair from 0011 onward. The ten exemptions (0001–0010) are listed in
  `supabase/migrations/down/README.md`.
- Numbering collisions are a real historical failure mode — read
  `docs/runbooks/migration-numbering.md` before picking a number on a branch.
- After any schema change: `pnpm snapshot` and `pnpm types:gen`, both before commit.
  `snapshot:check` and `types:check` gate the merge.
- **RLS is on for all 35 tables**, gated by `is_member` / `is_member_with_role`.
- Atomic and RLS-aware business rules live in DB functions (`record_pour`,
  `reconcile_open_bottle`, …).
- **Service-role usage bypasses RLS entirely.** Every service-role call site must
  gate on membership first and pass only the session's own `restaurantId` into
  subsequent `.eq("restaurant_id", …)` filters. This is application-code discipline
  with no database backstop — treat any new service-role call site as requiring
  review.

## Testing

- **Vitest** for unit and route logic; `happy-dom`; `pool: "forks"` (deliberate —
  threads shared `process.env` and could silently skip the live-DB suites).
- Tests colocate with source as `*.test.ts(x)`.
- **Playwright** for E2E in `e2e/`.
- **Live-DB suites only ever run against loopback.** `src/test/live-db-target.ts`
  refuses any non-loopback host, because `.env.local` holds production credentials.
  `src/test/contracts/live-db-target.test.ts` enforces that no live-DB test can skip
  the guard. Do not weaken either.
- Locally, the live-DB suites self-skip with a loud banner if no stack is running.
  In CI they hard-fail instead — CI stands up a real Supabase and runs them.
- Coverage thresholds (94–100%) are enforced for `src/lib/reconcile-ledger`,
  `src/domains/cellar`, `src/domains/pours` only. Those three are mutation-proven.
  Thresholds may go up, never down.

## Observability

- **Sentry** wraps the Next.js build; server, edge, and client instrumented
  separately (`instrumentation.ts`, `instrumentation-client.ts`,
  `sentry.{server,edge}.config.ts`).
- Source maps upload on Railway deploy, gated on `SENTRY_AUTH_TOKEN` presence.

## Naming

- Files: kebab-case for routes and utilities; PascalCase for React components.
- DB columns: `snake_case`.
- Env vars: `SCREAMING_SNAKE_CASE`; `NEXT_PUBLIC_` prefix **only** for
  browser-exposed values.
- The Supabase browser key is `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, **not**
  `..._ANON_KEY`. Older docs get this wrong.

## Commits and process

- Conventional commits: `type: description`.
- One feature = one branch = one squashed commit on `main`.
- `main` is protected with `enforce_admins: true` and a single required check that
  runs 14 gates. There is no path around it, by design.
