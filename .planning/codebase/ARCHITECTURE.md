# ARCHITECTURE

## Pattern
**Single Next.js 16 App Router monolith** deployed to Railway. Server Components by default; Client Components only where interactivity demands it. Supabase (Postgres + Auth + Storage) is the sole backend. No microservices, no background queues — all processing is synchronous or user-triggered.

## Layers

### 1. Presentation (`src/app/`)
- Public routes: `login`, `auth`, `invite`, `list` (public wine list), root `page.tsx`
- Authed shell at `src/app/(app)/`: `cellar/`, `scan/`, `lists/`, `insights/`, `price-comparison/`, `team/`
- Mobile-first FAB (`fab.tsx`), onboarding modal, settings dropdown
- `layout.tsx` wires Sentry instrumentation + Supabase auth context

### 2. API Routes (`src/app/api/`)
JSON route handlers, one folder per resource:
`cellar/`, `export/`, `health/`, `insights/`, `inventory/`, `pdf/`, `pour/`, `reconcile/`, `restaurant/`, `scan/`, `scan-bottle/`, `scans/`, `team/`, `wine-list-items/`, `wine-list-sections/`, `wine-lists/`, `wines/`

All inputs validated with Zod. Auth enforced via Supabase server client (`src/lib/supabase/`).

### 3. Domain Logic (`src/lib/`)
- `scanner/` — invoice OCR pipeline + Claude extraction
- `wine-intelligence/` — drink-window calc, serving temps, peak-year alerts
- `wine-list/` — menu templates, section ordering
- `pour/` — pour event recording, open-bottle reconciliation
- `pricing/` — market price comparison
- `drink-window/` — peak-readiness scoring
- `export/` — CSV / PDF export
- `ai/` — Anthropic client wrapper
- `api/` — route handler utilities (auth gates, error envelope)
- `supabase/` — server + browser client factories
- `auth-context.ts` — React auth context
- `hooks/` — client-side React hooks
- `units.ts`, `utils.ts` — shared helpers

### 4. Data (Supabase Postgres)
Schema in `supabase/migrations/` (forward-only) with snapshot at `supabase/schema.snapshot.sql`.

Core tables: `restaurants`, `memberships`, `wines`, `invoice_scans`, `inventory_items`, `wine_lists`, `wine_list_sections`, `wine_list_items`, `lwin_catalog`, `invitations`, `cellar_config`, `scan_idempotency`, `availability_events`, `open_bottles`, `pour_events`.

DB functions enforce business rules: `is_member`, `is_member_with_role`, `find_or_create_wines_batch`, `match_lwin_batch`, `record_pour`, `reconcile_open_bottle`, `auto_eightysix_on_low_inventory`, `enrich_wines_batch`.

## Key Data Flow: Invoice Scan
1. User photographs invoice in `scan/` route
2. Image uploaded to Supabase Storage
3. `POST /api/scan` → Azure Document Intelligence OCR
4. OCR text → Claude (Anthropic SDK) with system prompt for structured extraction
5. Claude returns JSON line items (name, vintage, qty, price, etc.)
6. Zod validates response → `find_or_create_wines_batch` upserts wines + creates `invoice_scans` + `inventory_items`
7. `match_lwin_batch` enriches wines against LWIN catalog
8. UI re-renders cellar with new bottles

## Key Data Flow: Pour & Reconcile
1. Bartender records pour in `pour/` UI → `POST /api/pour`
2. `record_pour` DB function maintains `open_bottles` automatically
3. End of shift: `reconcile_open_bottles_batch` settles inventory
4. `auto_eightysix_on_low_inventory` flips wines to unavailable on the public list

## Entry Points
- `pnpm dev` — Next.js dev server (3000)
- `pnpm build && pnpm start` — production (Railway)
- `pnpm test` (Vitest) / `pnpm test:e2e` (Playwright)
- `pnpm snapshot` — regenerate `schema.snapshot.sql`
- `pnpm types:gen` — regenerate `src/types/database.ts` from Supabase schema

## Cross-Cutting
- **Sentry**: `instrumentation.ts`, `instrumentation-client.ts`, `sentry.edge.config.ts`, `sentry.server.config.ts`
- **Auth**: middleware-style gate on `(app)/` group via Supabase SSR helpers
- **Idempotency**: `scan_idempotency` table prevents double-processing of invoice uploads
