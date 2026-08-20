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
- `src/lib/bins`, `src/lib/cellar-facets`, and `src/lib/cellar-health`:
  physical placement, URL-backed cellar views, and health classification.
- `src/lib/reconcile-queue` and `src/lib/reconcile-ledger`: derived issue
  ranking plus reversible accept and undo workflows.
- `src/lib/partial-bottles` and `src/lib/member-analytics`: close-out yield
  calculations and member-attributed operational metrics.
- `src/lib/pricing-recommendations`: pricing classification, timing, and
  materialized recompute workflow.
- `src/lib/branding`: logo palette extraction, theme validation, and shared
  public, print, and PDF theme rendering.

Provider boundaries have two branding exceptions. Menu-theme proposals in
`src/lib/branding/menu-design.ts` call the shared Anthropic client directly.
Non-PNG palette extraction in `src/lib/branding/palette.ts` launches Puppeteer
directly. Wine-list PDF generation still reaches Puppeteer through
`src/adapters/pdf`.

## Database Contracts

- The legacy end-of-shift `POST /api/reconcile` path calls
  `reconcile_open_bottles_batch` through `src/domains/cellar/reconcile-service.ts`;
  that batch is one database transaction.
- The newer reconciliation queue does not use that RPC. Accept and undo in
  `src/lib/reconcile-ledger/index.ts` issue ordered table reads, subject updates,
  and ledger inserts through the authenticated Supabase client, with explicit
  compensation on partial failure. Do not describe that workflow as one
  database transaction.
- Public wine-list reads stay explicitly protected by RLS policies and contract
  tests.
- `close_open_bottle` records the bottle close-out and finish event in one
  transaction. Reconciliation batches persist ordered before-and-after state so
  undo restores actions in reverse application order.
- First-class bins, cellar-health rows, reconciliation history, bottle
  close-outs, stock adjustments, brand kits, and pricing recommendations are
  restaurant-scoped and protected by RLS. Ordinary authenticated app clients
  cannot update or delete stock adjustments, bottle close-outs, or reconcile
  actions. Those records are not globally immutable: parent deletes can cascade,
  and service-role or database-owner access can bypass ordinary client grants.
- Current application code writes `public.background_jobs` only during
  cellar-health and pricing-recommendation recomputes. The schema reserves
  `invoice_ocr`, `wine_enrichment`, and `wine_list_pdf` job types, but this branch
  has no producer/consumer path using those types.

## Remaining Handoffs

- Restore a green exact-SHA smoke result on the protected staging tip and land
  the reviewed promotion workflow on `main` before treating staging as a hard
  promotion gate.
- Implement and verify producers and consumers before describing OCR,
  enrichment, or PDF as background-job workflows. The reserved enum values do
  not prove runtime execution.
- Finish extracting `auth`, remaining `cellar`, `insights`, and `storage`
  workflow code as those routes are touched.
