# Spike 7a — LightGlue survival under synthetic phone-condition degradations (SPEC-03/05)

Date: 2026-08-25 · Parent: `2026-08-24-visual-wine-platform-spec-list.md` §3 (spike 7)
Hardware: RunPod RTX 4090. Data: X-Wines Slim 1,007 labels (MD5-verified against the
dataset's INFO_Hashing.txt). Artifacts: `~/projects/terroir-data/spike07-lightglue/`
(survival.py, survival_results.json — 800 measurements).

**Scope split (deliberate):** this is 7a — *synthetic* phone-condition artifacts
applied to clean labels. The true phone-photo domain check (7b) requires Devin's
real bottle photos (10–20 labels, varied angle/lighting, names noted →
`~/projects/terroir-data/spike02-capture/`) and stays OPEN until they exist.
Synthetic degradation is a lower bound on realism, not a substitute.

## Verdict

**Rerank viability confirmed — LightGlue is the robust stage, retrieval is the
fragile one, and the pipeline order (DINOv2 nominates → LightGlue verifies) is
correct.** 100 query labels × 8 conditions against the full 1,007-label gallery:

| condition | DINOv2 top-1 % | top-5 % | med. true inliers | med. best-wrong inliers | rerank correct % |
|---|---|---|---|---|---|
| clean (control) | 100 | 100 | 927 | 20 | 100 |
| cylinder wrap (on-bottle) | 100 | 100 | 524 | 22 | 100 |
| perspective | 97 | 98 | 627 | 18 | 100 |
| glare | 100 | 100 | 825 | 18 | 100 |
| motion blur | 100 | 100 | 425 | 16 | 100 |
| low light + noise | 99 | 100 | 406 | 20 | 100 |
| 0.5× + JPEG q35 | 100 | 100 | 279 | 14 | 100 |
| **combo (cyl+glare+dark+jpeg)** | **73** | **87** | 116 | 6 | **100** |

- **The true/wrong inlier separation is enormous and never closes**: worst single
  true-pair count across all 800 measurements is 37 inliers (combo) vs a
  best-wrong median of 6–22. An accept bar anywhere in 25–60 inliers separates
  perfectly on this data.
- **Single artifacts don't threaten the pipeline at all**; only the stacked
  worst case dents retrieval (73 % top-1 / 87 % top-5).
- **Failure mode when it comes is candidate nomination, not verification**: in the
  13 % of combo cases where the true label misses DINOv2's top-5, LightGlue never
  gets the pair. Rerank-correct above is measured over top-5 ∪ {true} — it answers
  "does the true reference win IF it reaches the rerank", which it always did.

## Consequences

1. **SPEC-05's rerank design stands**: LightGlue inlier count is a
   near-perfect verifier on label imagery; calibrated fusion can lean on it hard.
   An inlier floor (≈30 on this data) doubles as the ABSTAIN trigger.
2. **Candidate nomination needs the union**, exactly as SPEC-05 specifies: under
   worst-case conditions visual retrieval alone misses 13 % — the OCR-text arm
   must be able to nominate candidates the embedding misses (and vice versa).
   Single-arm topologies are ruled out by measurement, not taste.
3. **SPEC-03 unwarp priority moderates**: cylinder wrap alone costs LightGlue
   ~45 % of inliers (927→524 median) but zero retrieval or rerank accuracy at
   this gallery scale. Unwarp remains justified for texture derivatives (P4) and
   as combined-stress insurance, but it is not the survival lever for scan — the
   degradation that actually hurts is the compound low-quality stack.
4. **Spike 2 capture note**: degraded-query inlier counts (median 116 under
   combo) still clear an accept bar ~30 — glare+dark+low-res phone captures
   should verify fine IF nominated; 7b tests exactly the nomination gap.

## Validity limits (why 7b stays open)

- Synthetic artifacts approximate phone conditions; real phone photos add sensor
  noise profiles, autofocus misses, occlusion (hands/racks), background clutter,
  and framing variance no synthesis here models.
- Queries are degraded versions of gallery images (same source photo). Real
  matching is packshot-reference vs phone-query of DIFFERENT physical bottles —
  vintage variants, label revisions, capsule/foil differences. This inflates all
  survival numbers by an unknown amount; 7b measures the deflation.
- Gallery = 1,007 labels; production is 20k+. Retrieval difficulty grows with
  gallery size (more near-neighbors), verification difficulty largely doesn't.

## Reproduce

```bash
python3 build_index.py   # spike06-latency/ — shared DINOv2+FAISS index
python3 survival.py      # deterministic (seeded per query×condition)
```
