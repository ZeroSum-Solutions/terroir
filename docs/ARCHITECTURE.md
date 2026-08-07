# Terroir Architecture

Terroir stays a modular monolith. Route handlers should own HTTP lifecycle only:
auth, request parsing, validation, and response mapping. Domain modules own
business workflows. Adapter modules own external/provider mechanics.

## Current Boundaries

- `src/domains/scanning`: invoice OCR/LLM extraction orchestration.
- `src/domains/wine-lists`: wine-list PDF generation workflow.
- `src/domains/pours`: pour transaction orchestration around `record_pour`.
- `src/domains/cellar`: reconcile transaction orchestration around
  `reconcile_open_bottles_batch`.
- `src/adapters/ocr`: Azure Document Intelligence boundary.
- `src/adapters/llm`: Anthropic invoice extraction boundary.
- `src/adapters/pdf`: Puppeteer HTML-to-PDF boundary.
- `src/lib/supabase`: Supabase runtime configuration and client creation.

## Database Contracts

- Transactional inventory, pour, undo, and reconcile writes stay in Supabase
  RPCs. App code calls RPCs through domain services.
- Public wine-list reads stay explicitly protected by RLS policies and contract
  tests.
- Long-running OCR, wine enrichment, and PDF workflows have
  `public.background_jobs` as the durable retry/status model.

## Remaining Handoffs

- TER-003's pinned staging smoke and promotion workflow are in the repository,
  but live isolation and synthetic stateful workflow evidence remain required
  before staging can become a production promotion gate. See
  [`STAGING-SETUP.md`](STAGING-SETUP.md).
- Move OCR, enrichment, and PDF execution to a worker or scheduled processor
  that consumes `background_jobs`; this needs an operational owner and
  non-production environment credentials.
- Finish extracting `auth`, remaining `cellar`, `insights`, and `storage`
  workflow code as those routes are touched.
