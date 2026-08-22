# Scan pipeline performance budget

**Status: draft — thresholds pending owner decision Q-perfbudget (device
tier, network condition, and percentile all still open). Nothing in this
document is a committed SLO.** It exists so the M1-1 latency instrumentation
has a stated target to be graded against once real device/network data
comes in, and so "scanning feels slow" stops being a complaint with zero
data behind it.

## Why this doc exists

The owner's live-walkthrough complaint was "scanning feels slow," with no
way to say where the time actually goes. M1-1 adds per-stage timing across
the invoice-scan pipeline (client marks + Sentry spans) but does
**no optimization work** — this doc proposes draft targets against that new
data, it doesn't yet defend any of them with a measured p50/p95 from a real
device.

## Stage taxonomy (what M1-1 actually measures)

| Stage | Where it's recorded | What it captures |
| --- | --- | --- |
| `capture` | Client `performance.mark`, reported as a `scan.client.capture` Sentry log | Tap-to-take-photo/upload-file through a file being selected. Mostly user think-time (framing a photo), not app latency — included for completeness, not as an optimization target. |
| `prep` | Client mark → `scan.client.prep` log | Building the multipart upload request. Near-zero today (no client-side image compression/resize exists yet); instrumented so that work has a baseline to compare against if it's added later. |
| `upload` | Client mark → `scan.client.upload` log | The full `fetch()` round trip: network transfer **plus** all server-side processing, since a single HTTP request/response can't be split into "upload" vs "processing" from the browser's side. See "Reading the data" below for how to separate the two. |
| `ocr.page` | Server span `scan.ocr.page` (one per page) | One Azure Document Intelligence call per invoice page. A multi-page invoice fans these out in parallel (`Promise.all`), so wall-clock cost is roughly the slowest page, not the sum. |
| `ocr.merge` | Server span `scan.ocr.merge` | Merging per-page OCR results into one document before extraction. Synchronous and cheap; included for completeness. |
| `extract` | Server span `scan.extract` (`attempt: 1`) | Claude structured extraction from the merged OCR text. |
| `extract.retry` | Server span `scan.extract.retry` (`attempt: 2`) | The G1-12 higher-effort retry, only present when the first attempt fails deterministic arithmetic validation. Its presence/absence on a given scan is itself a useful signal — a scan hitting this regularly means OCR or extraction quality needs attention, not just speed. |
| `persist` | Server span `scan.persist` | Writing the final parsed invoice back to the `invoice_scans` row. |
| `render` | Client mark → `scan.client.render` log | From the scan response being received to the browser actually painting the results view (double-`requestAnimationFrame`, not just React scheduling the update). |

## Draft stage-level targets

Illustrative only — a proposed split of the plan's **<10s single-page
invoice** ambition across the stages above, not a measured baseline. Treat
every number as a placeholder until Q-perfbudget is answered and this table
is replaced with real percentile data.

The row below labeled "`upload` (network share)" is a target for the
network-transfer portion only — it is **not** the same thing as the raw
`upload` client mark, which (as noted in the taxonomy above) measures
network **plus** every server-side stage combined, since a browser can't
see inside one HTTP round trip. The `ocr.*`/`extract`/`persist` rows below
are separate, additional budget slices for what happens once the request
lands on the server — sum every row here to get the target for the raw
client `upload` measurement.

| Stage | Draft target (single page) | Notes |
| --- | --- | --- |
| `upload` (network share) | ~1.0s | Rough allowance for image upload over a typical mobile connection; grows with file size and with additional pages. |
| `ocr.page` | ~2.5s | Per Azure Document Intelligence call; multi-page invoices should stay close to this via the existing parallel fan-out, not multiply by page count. |
| `ocr.merge` | <0.05s | Synchronous, should never be a meaningful contributor. |
| `extract` | ~3.5s | Claude structured extraction at the `INVOICE_EXTRACTION` profile (medium effort). |
| `extract.retry` | ~5s (only on mismatch) | Higher-effort retry; only a subset of scans pay this, but those scans' total budget should be judged against this larger number, not the no-retry path. |
| `persist` | <0.2s | Single-row Supabase update. |
| `render` | <0.3s | State update through paint; should be dominated by React/DOM work, not data size, at current result-set sizes. |
| **Total (no retry)** | **~7.5s** | Leaves headroom under the <10s ambition for real-world network variance. |
| **Total (with retry)** | **~12.5s** | Exceeds the <10s ambition — whether a retried scan should have its own, looser budget (vs. optimizing the retry path itself) is exactly the kind of call Q-perfbudget needs to make. |

None of these numbers are backed by measured device data yet — they're a
starting proposal sized against the model profiles and pipeline shape as of
this slice, meant to be replaced once real scans produce real distributions.

## Open question: Q-perfbudget

Before any row above becomes a real threshold, the owner needs to decide:

- **Device tier** — what hardware defines "acceptable"? A recent iPhone on
  the restaurant's own Wi-Fi is a very different budget than a three-year-old
  Android on a spotty cellular connection at the loading dock.
- **Network condition** — Wi-Fi, LTE, or the worse of the two, since a
  restaurant back-of-house is exactly where connectivity is often bad.
- **Percentile** — p50 ("typical"), p95 ("bad but not rare"), or p99. A
  single-number "average" budget hides the tail that actually generates
  complaints.

## Reading the data

- **Server spans**: Sentry → Performance, filter by `op:scan` or search for
  transaction/span names starting with `scan.` (`scan.ocr.page`,
  `scan.ocr.merge`, `scan.extract`, `scan.extract.retry`, `scan.persist`).
  In development `tracesSampleRate` is `1.0` (every scan traced); production
  samples 10%, per `sentry.server.config.ts`.
- **Client stages**: Sentry → Logs (`enableLogs` is already on for all three
  runtimes — see `sentry.server.config.ts`, `sentry.edge.config.ts`,
  `instrumentation-client.ts`), filter by message prefix `scan.client.`.
  Logs aren't subject to trace sampling, so every scan's client-side stage
  breakdown is captured even in production.
- **Correlating one scan end-to-end**: every client log carries a `scanId`
  attribute — the scan's own idempotency key (the `Idempotency-Key` request
  header, visible in browser devtools' Network tab for `/api/scan`). Filter
  both the Logs view and the Performance view by that value to reconstruct
  a single scan's full stage breakdown.
- **Separating network from server processing**: subtract the sum of that
  scan's `ocr.page` (max across pages, since they run in parallel) +
  `ocr.merge` + `extract` (+ `extract.retry` if present) + `persist` span
  durations from the client's `upload` duration. What's left is
  network/queueing overhead the server-side spans can't see.

## Example: one scan's stage breakdown

Synthetic, for illustration only — not a real captured trace. This is the
shape of the answer this instrumentation makes possible for "where did the
12 seconds go":

| Stage | Duration |
| --- | --- |
| `capture` | 1.8s (user already had the photo framed) |
| `prep` | 10ms |
| `upload` (client-observed round trip) | 10.3s |
| — `ocr.page` (server) | 1.9s |
| — `ocr.merge` (server) | 4ms |
| — `extract` (server, attempt 1) | 2.8s |
| — `extract.retry` (server, attempt 2 — arithmetic mismatch) | 4.6s |
| — `persist` (server) | 0.15s |
| — network/queueing (upload − server spans above) | ~0.85s |
| `render` | 0.1s |
| **Total (capture through render)** | **~12.2s** |

The `upload` row and the indented rows under it are the same interval
measured two ways — `upload` is what the client saw end-to-end; the
indented rows are what the server spans say filled it, plus whatever's left
over as network/queueing. In this example the retry alone accounts for
more than a third of total time — evidence the owner didn't have before
M1-1, and exactly the kind of finding this doc exists to make legible.
