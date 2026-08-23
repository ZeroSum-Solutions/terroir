# AF-A: Scan New Photo + multi-PDF upload — root cause and fix

Investigated 2026-08-22/23 against a worktree dev server (port 3101) plus a
read-only production/shared-Supabase query. Screenshots referenced below are
in this same directory.

## Production evidence

Queried `invoice_scans` (read-only, via the Supabase REST API with the
service-role key already present in `.env.local` — no value printed, no
writes) for rows created 2026-08-20..2026-08-23:

```
id eb871799…  created_at 2026-08-22T14:00:00Z  status=review  item_count=6  distributor_name="Skurnik Wines"  raw_image_path=null
id 8e38d7d7…  created_at 2026-08-22T02:41:25Z  status=failed  item_count=0  distributor_name="Unknown"        raw_image_path=null
id d9b9541b…  created_at 2026-08-22T02:17:27Z  status=failed  item_count=0  distributor_name="Unknown"        raw_image_path=null
```

- Two `failed` / 0-item / "Unknown" rows, ~24 minutes apart — consistent with
  two separate attempts by the owner, each of which ran to completion
  *server-side* (the row was updated away from `processing`) without the
  result ever reaching him — no error, no result. This is exactly "silent
  failure."
- One `review` / 6-item row — consistent with a merged, arithmetic-mismatched
  extraction (see Root Cause 2) that fell into manual-review status rather
  than a clean result.
- `raw_image_path` is `null` on all three — the best-effort post-success
  image upload never completed for any of them either (secondary symptom of
  requests running unusually long or failing before that step; not itself
  part of this fix's scope).
- `background_jobs` was also checked: invoice scanning does not use the async
  job queue (that's used by CSV import / pricing recompute) — nothing
  relevant there.

This is corroborating evidence, not final proof by itself — but it lines up
exactly with the two root causes reproduced live below.

## Root cause 1 (primary): no client-side timeout on the /api/scan request

`scanner.tsx`'s `startScan` awaited `fetch()` with no ceiling other than a
user-tapped Cancel button. Reproduced directly: mocked `/api/scan` to never
respond, then waited — the UI stayed on `ProcessingView` ("Still working —
large invoices can take up to 90 seconds… Estimated progress: 95%")
**indefinitely, with no error and no result**. This is the mechanism behind
"got NO usable result — silent failure, no error shown": whenever the
request stalls or the connection drops (spotty restaurant Wi-Fi/cellular,
a proxy idle-timeout, a screen lock backgrounding Safari), the user is left
staring at "still working" forever, no different from what he described.

The app runs on Railway via `pnpm start` (`next start`, a long-running Node
process), not Vercel — so the route's `export const maxDuration = 120` has
no effect there; nothing bounds a slow request except a hypothetical
upstream proxy's own idle timeout, which the app never surfaces or works
around client-side.

Fix: `scanner.tsx` now races the fetch against a 150s client-side ceiling
(`SCAN_TIMEOUT_MS`). On expiry it aborts the request and shows a specific,
visible message ("This is taking longer than expected. Check your
connection and try again.") distinguished from a user-initiated Cancel via
`timedOutRef` so existing cancel behavior is unaffected.

Verified: `docs/screenshots/af01-scan/21-hang-now-visible-error.png` — same
never-responding mock, but now surfaces a visible error after the ceiling
instead of hanging forever (full run took ~2.6 minutes end to end).

## Root cause 2: multiple PDFs are merged into one invoice

`/api/scan`'s multi-file batching (BND-081/TER-CF-032) treats every file in
one request as another *page* of the same invoice — correct for
photographing several pages of one physical invoice, and already covered by
an existing test. But a PDF is already a complete, potentially multi-page
document. The owner uploaded **three separate PDFs, each a full invoice with
many wine entries** — the code OCR'd all three, concatenated their raw text
and line-item tables via `mergeOcrResults` (`src/lib/scanner/ocr-service.ts`),
and asked Claude to extract ONE invoice's worth of line items from the
resulting garbled, three-invoices-in-one text. This:

- triples the Azure OCR fan-out and can trigger a second (retry) Claude
  extraction call when the combined arithmetic doesn't reconcile — directly
  feeding Root Cause 1 by making the request far more likely to run long
  enough to stall or exceed a proxy's idle timeout;
- produces an incoherent result (wrong vendor/invoice number — only the
  first file's header fields survive the merge — and near-certain
  arithmetic mismatch), matching the production `review`/6-item row;
- had **no validation anywhere** (client or server) telling the user this
  combination isn't supported.

Fix: reject a batch containing more than one PDF, both client-side
(`scanner.tsx`, instant, before any network call) and server-side
(`route.ts`, defense in depth) with a specific message: *"Upload one PDF per
invoice — scan each invoice separately, or take a photo of each page
instead."* Multi-file batching of **photos** (JPEG/PNG/HEIC) is unaffected
and still supported/tested — that's the legitimate "front and back" /
multi-page-photographed-invoice case.

Verified: `docs/screenshots/af01-scan/05-instant-reject-three-pdfs.png` —
three PDFs rejected instantly with zero network calls to `/api/scan`.

## Root cause 3: retry after a recoverable error silently dropped files

Independent of the above: `lastFile` only ever stored `files[0]`, and
`retryScan` only ever resubmitted `startScan([lastFile])`. Reproduced
directly: selected 3 files, forced the first `/api/scan` call to fail with a
network error, tapped "Retry invoice scan" — the retried request contained
**1 file, not 3** (`[3, 1]` file counts across the two attempts). The
"Retry" button appeared to work, but silently reduced a 3-file batch to a
1-file batch with no indication anything was lost.

Fix: added `lastFiles: File[]` holding the complete originally-selected
batch; `retryScan` now resubmits the full array. Verified with a route-level
assertion that the retried `FormData` has the same file count as the
original attempt (`scanner.test.tsx`).

## "New Photo" / camera capture flow

Could not reproduce a distinct capture-mechanism bug. Every mechanical step
checked out on a real iPhone-14-emulated Playwright session (both Chromium
and WebKit engines): tapping "Take photo" opens the native file chooser with
`isMultiple() === false`; selecting a JPEG fires `change`; the request is
sent; a server error correctly renders `ErrorView`; tapping "New photo"
correctly returns to the ready state; a second "Take photo" attempt
correctly re-fires (the existing `input.value = ""` reset works). Also
attempted to reproduce a known WebKit quirk where a HEIC camera capture
reports an empty `file.type` — could not force this through Playwright's
`setInputFiles` in either engine (both sniff `.HEIC` to `image/heic`
regardless of the mimeType passed in), so this remains unconfirmed, not
ruled out. Given every mechanical step passed, the most likely explanation
is that "New Photo" shares Root Cause 1: the owner took a photo, the request
stalled with zero feedback, and from his side it looked exactly like the
capture flow itself never worked. Defensively, client-side file-type
validation now falls back to file-extension matching when `file.type` is
empty/missing, in case that WebKit behavior is real on some devices.

## What could NOT be verified

- No live Azure Document Intelligence / Anthropic credentials were available
  in this sandboxed worktree (`.env.local` here has only the 5 Supabase/dev
  vars — `AZURE_DOC_INTELLIGENCE_*` and `ANTHROPIC_API_KEY` are unset), so
  the actual end-to-end OCR → merge → Claude extraction timing for a
  3-PDF batch could not be measured directly; the ~triple-OCR-fan-out +
  possible extraction retry is a code-derived estimate, not a measured
  duration.
- The WebKit "empty HEIC MIME type" theory (see above) is unconfirmed.
- Whether the Supabase project this worktree's `.env.local` points at is
  literally the same "production" the owner hit, or a shared dev/staging
  project, was not independently confirmed beyond DEV_BYPASS_EMAIL being
  disabled in `NODE_ENV=production` — treated it as authoritative-enough
  per the task's read-only investigation instructions.

## Files changed

- `src/app/(app)/scan/scanner.tsx` — client-side pre-validation (unsupported
  type, >1 PDF, >8 pages, oversized — all before any network call);
  `lastFiles` batch preservation for retry; client-side scan timeout with a
  distinct visible message.
- `src/app/api/scan/route.ts` — server-side rejection of >1 PDF in one batch
  (defense in depth).
- `src/app/api/scan/route.test.ts` — new tests for the >1-PDF rejection and
  for a single PDF still mixing with image pages.
- `src/app/(app)/scan/scanner.test.tsx` — new tests: unsupported-type instant
  reject, 3-PDF instant reject, single-PDF-still-allowed, multi-image-batch
  still-allowed, full-batch retry preservation, camera-origin JPEG path,
  never-resolving-request timeout.
- `e2e/scan-intake-mobile.test.ts` — updated the pre-existing "2-file batch"
  test to use photographed pages (images) instead of 2 PDFs (which the fix
  now rejects), and added new tests for the 3-PDF and unsupported-type
  instant-reject cases.

## Round 2 (critic findings, addressed)

The critic drove PR #115 and found two remaining gaps:

### 1. Functional gap: PDF mixed with a non-PDF file was silently accepted

The round-1 fix only rejected a batch with `pdfCount > 1` — so exactly one
PDF plus any number of other files (e.g. 1 PDF + 1 JPEG) sailed through
untouched and got merged as "one invoice," reproducing the original bug's
mechanism via a different file combination. Fixed by generalizing the rule
to `pdfCount > 0 && files.length > 1` (any PDF combined with ANY other
file, including another PDF) in both `scanner.tsx` (client, instant, zero
network) and `route.ts` (server, `400 mixed_pdf_batch`). The two allowed
shapes are now exactly: one PDF alone, or up to 8 photos with no PDF at
all. The message adapts: multiple PDFs keeps the round-1 "Upload one PDF
per invoice — you selected N PDFs" wording; a single PDF mixed with photos
gets "A PDF is a complete invoice on its own — upload it by itself, or
upload photos without a PDF."

The pre-existing route test asserting 200 for "a single multi-page PDF
alongside other image pages" was inverted (not deleted) to assert the new
400/`mixed_pdf_batch` — that combination is now intentionally rejected. The
scanner-level retry-preservation test, which had used a PDF+2-JPEGs batch,
was changed to an all-images batch so it continues to exercise a genuine
multi-file *network* retry (a PDF+other mix now never reaches the network
at all, so it can't be used to test retry behavior any more).

Verified with measured evidence:
- Client, real browser: 1 PDF + 1 JPEG → `Couldn't read the invoice` / "A
  PDF is a complete invoice on its own…", **0 requests** to `/api/scan`.
  Screenshot: `10-instant-reject-mixed-pdf-jpeg.png`.
- Server, raw multipart POST (bypassing the client entirely, cookie-authed
  `fetch` with a real two-part `FormData`, one PDF + one JPEG): `400`,
  `{"error":{"code":"mixed_pdf_batch","message":"A PDF is a complete
  invoice on its own. Upload it by itself, or upload photos without a
  PDF."}}`.
- Server, 3 PDFs (unchanged case): still `400 mixed_pdf_batch`, "Upload one
  PDF per invoice… You selected 3 PDFs…".

### 2. Design contract: focus-visible used a ring, not the outline pattern

`error-view.tsx`, `processing-view.tsx`, and every sibling file in
`src/app/(app)/scan/views/` (`ready-view.tsx`, `results-view.tsx`,
`bottle-results-view.tsx`, `confidence-gate.tsx`) used
`focus-visible:outline-none focus-visible:ring-2
focus-visible:ring-primary/25` (or `/30` + `ring-offset-2`) — DESIGN.md's
`.glass` utility is unlayered and defeats ring box-shadows, and the
project's own working pattern (`cellar-counters.tsx`) uses a real
`outline` instead. Swapped all 24 occurrences across those 6 files to
`focus-visible:outline focus-visible:outline-2
focus-visible:outline-offset-2 focus-visible:outline-primary`, matching
`cellar-counters.tsx` exactly.

Verified with a **real keyboard Tab** (not `.focus()` — a raw
`element.focus()` call doesn't reliably trigger Chromium's
`:focus-visible` heuristic, especially right after a mouse interaction;
using it produced a false pass in round 1). Methodology: a real mouse
click on an empty corner of the viewport (establishes "last input was a
mouse" baseline), then real `Tab` key presses via `page.keyboard.press`
until `document.activeElement` is the target `<button>`, then
`getComputedStyle`. Desktop Chromium (no mobile-device emulation) was used
for this specific check — the iPhone-14 touch-emulated profile produced
unreliable Tab-stop navigation in this environment (focus kept reverting
to `<body>`), which is a Playwright/mobile-emulation quirk unrelated to
the CSS under test; the computed style is a browser-engine property
independent of viewport size.

Measured, on all four named buttons (Retry invoice scan, New photo, Enter
manually, Cancel scan):

```
outlineStyle:  solid
outlineWidth:  2px
outlineColor:  rgb(114, 47, 55)   // #722f37 — DESIGN.md's burgundy accent
outlineOffset: 2px
boxShadow:     none
```

### Round-2 files changed (in addition to round 1)

- `src/app/(app)/scan/scanner.tsx` — generalized PDF-mixing rule.
- `src/app/api/scan/route.ts` — generalized PDF-mixing rule, `400` with
  `code: "mixed_pdf_batch"`.
- `src/app/api/scan/route.test.ts` — inverted the single-PDF-plus-image
  test to assert the new rejection; added `mixed_pdf_batch` code
  assertions.
- `src/app/(app)/scan/scanner.test.tsx` — new mixed PDF+JPEG rejection
  test; retry-preservation test switched to an all-images batch.
- `e2e/scan-intake-mobile.test.ts` — new mixed PDF+JPEG e2e rejection
  test.
- `src/app/(app)/scan/views/error-view.tsx`, `processing-view.tsx`,
  `ready-view.tsx`, `results-view.tsx`, `bottle-results-view.tsx`,
  `confidence-gate.tsx` — focus-visible ring → outline.
- `docs/screenshots/af01-scan/10-instant-reject-mixed-pdf-jpeg.png` — new
  evidence screenshot.
