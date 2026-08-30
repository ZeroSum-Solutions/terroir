# STACK

## Languages & Runtime
- **TypeScript 5** (strict)
- **Node.js 20+** (engines pin)
- **pnpm 9+** (engines pin), pnpm workspace

## Frontend
- **Next.js 16.2.4** (App Router)
- **React 19.2.4** + React DOM 19.2.4
- **Tailwind CSS v4** (`@tailwindcss/postcss`)
- **class-variance-authority** + **clsx** + **tailwind-merge** (CVA-style components)
- **lucide-react** icons
- **@dnd-kit/core** + **@dnd-kit/sortable** + **@dnd-kit/utilities** (drag-and-drop list editing)
- **qrcode** (bottle label QR generation)

## Backend (Next.js Route Handlers)
- **Next.js API routes** under `src/app/api/`
- **@supabase/supabase-js 2.103.x** + **@supabase/ssr 0.10.x** (server/client auth helpers)
- **zod 4.x** (request/response validation, all external boundaries)
- **puppeteer 24.x** (PDF generation for printable wine lists / labels)

## AI & OCR
- **@anthropic-ai/sdk 0.90.x** — Claude structured extraction from invoice OCR text
- **@azure-rest/ai-document-intelligence 1.1.x** + **@azure/core-auth** — invoice OCR

## Observability
- **@sentry/nextjs 10.x** — error monitoring, source-map upload on Railway

## Testing
- **Vitest 4.1.x** (unit + route tests) — config: `vitest.config.ts`, env: `happy-dom`
- **@playwright/test 1.59.x** (E2E) — config: `playwright.config.ts`
- **eslint 9** + `eslint-config-next`

## Hosting / Deploy
- **Railway** — `railway.toml` at repo root
- Sentry source-map upload integrated in `next.config.ts`

## Ports
- Dev: `next dev` → **3000**
- API: same Next.js process (no separate backend port)

## Required Env (inferred)
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`
- `AZURE_DOC_INTELLIGENCE_ENDPOINT`, `AZURE_DOC_INTELLIGENCE_KEY`
- `SENTRY_AUTH_TOKEN`, `SENTRY_DSN`
