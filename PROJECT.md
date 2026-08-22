---
type: project
title: "Terroir"
description: "Restaurant wine-management SaaS. Photograph an invoice on your phone → Azure Document Intelligence extracts the text → Claude structures it into typed line items → save to your cellar. Also: wine-list editor with publishable public menus, bottle-label scan, team management."
resource: "https://github.com/wiggdevin/terroir"
timestamp: "2026-07-12T12:14:39.648995+00:00"
project_id: "repository-97f94ed515c75d1e"
ownership: "product"
lifecycle: "active"
verification_model: "openai-codex-root"
verification_status: "PASS"
evidence_fingerprint: "df52f6031e03b10d0dfc1e4e58d0dbaa23eb44db95af495dd5d4b6ad51cfefce"
okf_version: "0.1"
---
<!-- project-ledger:managed:start -->
# Terroir

Restaurant wine-management SaaS. Photograph an invoice on your phone → Azure Document Intelligence extracts the text → Claude structures it into typed line items → save to your cellar. Also: wine-list editor with publishable public menus, bottle-label scan, team management.

## Purpose

Restaurant wine-management SaaS for invoice scanning, cellar management, wine-list editing, and team management.

## Intended users

- restaurant staff
- wine managers

## Current status

- Lifecycle: active
- Category: product
- Git branch: main
- Working-tree changes at last scan: 0
- Semantic confidence: high

## Architecture and components

- Next.js 16 (App Router)
- Supabase (Postgres + Auth)
- modular monolith

## Entry points

- src/app/
- src/app/(app)/
- src/app/api/

## Commands

- pnpm dev
- pnpm build
- pnpm start
- pnpm lint
- pnpm test
- pnpm test:e2e
- pnpm exec tsc --noEmit
- pnpm run snapshot

## Dependencies

### Runtime

- @anthropic-ai/sdk
- @azure-rest/ai-document-intelligence
- @azure/core-auth
- @dnd-kit/core
- @dnd-kit/sortable
- @dnd-kit/utilities
- @sentry/nextjs
- @supabase/ssr
- @supabase/supabase-js
- class-variance-authority
- clsx
- lucide-react
- next
- puppeteer
- qrcode
- react
- react-dom
- tailwind-merge
- zod

### Development

- @playwright/test
- @tailwindcss/postcss
- @types/node
- @types/qrcode
- @types/react
- @types/react-dom
- @vitejs/plugin-react
- dotenv
- eslint
- eslint-config-next
- happy-dom
- tailwindcss
- typescript
- vitest

### Services

- Supabase
- Anthropic API
- Azure Document Intelligence
- Sentry (optional)

### Data

- Supabase Postgres

### Other projects

- No evidence found.

## Integrations

- Azure Document Intelligence
- Anthropic Claude
- Supabase
- Sentry (optional)
- Railway (deployment)

## Related, overlapping, or superseded work

- No evidence found.

## Evidence and review

- Evidence fingerprint: `df52f6031e03b10d0dfc1e4e58d0dbaa23eb44db95af495dd5d4b6ad51cfefce`
- Verified by: `openai-codex-root`
- Verification decision: `PASS`
- Review summary: Direct Codex root review found terroir evidence-bound after checking its description, purpose, architecture, commands, dependencies, integrations, relationships, and stated ambiguities against the current fingerprint.

### Ambiguities

- No staging environment yet; every push to main auto-deploys to production.
- No explicit user roles or authentication details beyond Supabase Auth.
- No information about deployment frequency or CI/CD pipeline specifics beyond Railway auto-deploy.
- No details on database schema or migration history beyond forward-only SQL migrations.
<!-- project-ledger:managed:end -->

<!-- project-ledger:human:start -->
## Human notes

Add durable context here. Project Ledger preserves this section verbatim.
<!-- project-ledger:human:end -->
