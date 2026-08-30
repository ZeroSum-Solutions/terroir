# INTEGRATIONS

## Supabase (primary backend)
- **Auth** (Gotrue) — email/password + OAuth providers
- **Postgres** — see `supabase/schema.snapshot.sql` for full schema
- **Storage** — bottle and invoice images
- **RLS** — every table; access via `is_member` / `is_member_with_role` DB functions
- **SSR helpers** — `@supabase/ssr` for cookie-based session in App Router
- Env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

## Azure Document Intelligence
- Used by `src/lib/scanner/` for invoice OCR
- Returns raw text + table structure → fed to Claude for typed extraction
- Env: `AZURE_DOC_INTELLIGENCE_ENDPOINT`, `AZURE_DOC_INTELLIGENCE_KEY`
- Package: `@azure-rest/ai-document-intelligence`, `@azure/core-auth`

## Anthropic Claude
- Used by `src/lib/ai/` and `src/lib/scanner/ai-extract.ts`
- Structured JSON extraction from OCR text with Zod-validated schema
- Wine intelligence enrichment (drink windows, serving temps) via `src/lib/wine-intelligence/`
- Env: `ANTHROPIC_API_KEY`
- Package: `@anthropic-ai/sdk` 0.90.x

## Sentry
- Error monitoring + performance for server, edge, and client
- Source-map upload on Railway deploy via `next.config.ts` Sentry wrapper
- Env: `SENTRY_AUTH_TOKEN`, `SENTRY_DSN`, project/org IDs
- Package: `@sentry/nextjs` 10.x

## Puppeteer
- Headless Chrome for PDF generation (printable wine lists, labels)
- Triggered from `/api/pdf/` route
- Package: `puppeteer` 24.x (bundled Chromium)

## QR Code
- `qrcode` package generates QR for bottle labels
- Used in `/api/pdf/` and label rendering

## LWIN Catalog
- `lwin_catalog` Postgres table is a local mirror of the LWIN (Liv-ex Wine Identification Number) reference list
- Used for wine matching/enrichment via `match_lwin` and `match_lwin_batch` DB functions
- No external API call at runtime — table seeded from CSV import

## Railway (hosting)
- Single Next.js deployment
- Config: `railway.toml`
- Build: `pnpm build`; Start: `pnpm start`

## Toast POS (planned / partial)
- Not currently wired in code — referenced in user-facing planning docs only
- Future integration: pull pour/sales data to reconcile against `pour_events`

## NOT integrated (deliberately absent)
- No Stripe / billing
- No email service (SendGrid/Postmark/Resend) — invitations flow via Supabase Auth's built-in email
- No third-party search (Algolia/Typesense) — Postgres FTS via `lwin_search`
- No background job queue (BullMQ/Inngest) — synchronous + DB-function-driven
