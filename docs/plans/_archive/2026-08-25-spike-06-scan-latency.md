# Spike 6 — e2e scan latency topology on demo-class GPU (SPEC-05, VWP-D-03)

Date: 2026-08-25 · Parent: `2026-08-24-visual-wine-platform-spec-list.md` §3 (spike 6)
Hardware: RunPod RTX 4090 (24 GB, secure cloud, EUR-IS-2) — the demo "inference box"
candidate class. Artifacts: `~/projects/terroir-data/spike06-latency/`
(bench_latency.py, build_index.py, bench_results.json, run_log.txt).

## Verdict

**The parallel-arms scan topology fits a demo box with a wide margin — warm e2e
p50 0.18 s** (full SPEC-05 chain: ZXing ∥ PaddleOCR ∥ DINOv2→FAISS → union →
LightGlue rerank k=5, reference features cached). Single-GPU throughput saturates
at ~5 req/s; the demo's one-operator load is a non-issue. The binding discovery is
**cold-start, not steady-state**: model loads (~7 s) + reference-feature cache build
(27.3 s for 1,007 labels) mean SPEC-23's demo-mode **prewarm is a hard requirement,
now quantified** — a cold box serves its first scan ~35 s late, a prewarmed box in
0.18 s.

## Per-component (warm p50/p95, seconds)

| component | 480×640 label | 1512×2016 phone-res |
|---|---|---|
| ZXing barcode (CPU) | 0.007 / 0.008 | 0.042 / 0.042 |
| PaddleOCR (PP-OCRv6, GPU) | 0.048 / 0.049 | 0.119 / 0.120 |
| DINOv2 ViT-B/14 embed @518 + FAISS top-5 (1,007 rows, flat IP) | 0.019 / 0.074 | 0.039 / 0.067 |
| SuperPoint extract (1,024 kp) | 0.007 / 0.080 | 0.078 / 0.091 |
| LightGlue match + RANSAC, per pair | 0.0225 / 0.0226 | — |

Model cold-loads: PaddleOCR 3.9 s, DINOv2 2.8 s, SuperPoint+LightGlue 0.3 s,
FAISS index ~0 s (plus first-call GPU warmup, e.g. OCR first call 0.48 s).

## End-to-end (native res, k=5 rerank)

| variant | p50 | p95 |
|---|---|---|
| reference SuperPoint features **cached** (production design) | **0.182** | 0.183 |
| reference features extracted on the fly | 0.319 | 0.348 |

Reference cache: 27.3 s to build for 1,007 labels (~27 ms/label), ~1.1 GB VRAM at
1,024 keypoints — cacheable at index-build time, not per boot, if persisted.

## Concurrency (cached refs, single model instances behind locks — the realistic single-box serving shape, no batching)

| concurrent requests | p50 | p95 | throughput |
|---|---|---|---|
| 1 | 0.179 | 0.218 | 5.5 req/s |
| 2 | 0.379 | 0.480 | 5.2 req/s |
| 4 | 0.758 | 0.955 | 5.1 req/s |
| 8 | 1.499 | 2.009 | 4.8 req/s |

Latency scales linearly with queue depth (GPU serializes); throughput is flat at
~5 req/s. For VWP-D-03: one RTX 4090-class box covers the demo with ~25× headroom
over a one-scan-every-5-seconds operator.

## Consequences

1. **VWP-D-03 box spec: RTX 4090-class is sufficient** — sub-0.2 s warm scans at
   demo load, ~5 req/s saturated. No case for multi-GPU at demo scale.
2. **SPEC-23 prewarm quantified**: preflight must confirm models loaded AND the
   reference-feature cache present; cold-boot cost ≈ 35 s (loads + cache build at
   1k labels; cache build scales linearly with corpus — persist it with the index).
3. **Reference SuperPoint features are index artifacts** (build-time, not
   request-time): caching them is a 1.75× e2e win (0.32 → 0.18 s) and removes disk
   reads from the hot path. Belongs in SPEC-05's index-build contract.
4. Phone-resolution input costs ~2.5× on OCR and ~10× on SuperPoint vs the 480×640
   label crops but stays comfortably sub-second; input downscaling policy can be
   decided by accuracy (spike 7 lane), not latency.

## Validity limits

- 1,007-label gallery (X-Wines Slim); FAISS flat IP at this scale is ~0 ms — at
  20k+ labels index choice starts to matter (still small for FAISS).
- The OCR arm measures OCR only; the downstream trigram+BM25 text search runs in
  Postgres and is not in these numbers (spike-1/9 material covers resolution).
- Sequential-arm sum ≈ e2e p50 here because a single GPU serializes the GPU arms;
  a second GPU or CPU-OCR deployment would parallelize genuinely. Not needed at
  demo scale.
- Latency measured on clean label crops; degraded phone photos change accuracy
  (spike 7), not materially the compute cost at fixed resolution.

## Reproduce

```bash
# on a CUDA box with the spike 6/7 stack (see pod_install.sh in the session scratchpad):
python3 build_index.py && python3 bench_latency.py
```
