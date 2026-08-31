# Spike 5 — DDGS 500-query soak (SPEC-04 cascade reliability)

Date: 2026-08-25 · Parent: `2026-08-24-visual-wine-platform-spec-list.md` §3 (spike 5)
Artifacts: `~/projects/terroir-data/spike05-ddgs/` (soak.py, results.jsonl — 500 rows)

## Verdict

**DDGS is viable as a cascade tier — with retry discipline made mandatory.** 500
stratified image queries (FR 200 / IT 100 / ES 60 / US 50 / rest 90, drawn from the
production LWIN catalog) over 52.6 minutes: **94.0 % success, zero empty result sets**
(every successful query returned ≥ 10 image results). All 30 failures are transient
transport errors (29 `TimeoutException`, 1 `DDGSException`), arriving in runs of ≤ 3
consecutive queries with full recovery after the 30 s error backoff. DDGS cannot be the
*sole* enrichment tier — sustained-rate degradation is real (below) — but SPEC-04's
cascade position (after local joins + barcode, before Brave) stands.

## Reliability profile

| wave | ok | wall-clock |
|---|---|---|
| Q0–99 | 99/100 | 0–6 min |
| Q100–199 | 100/100 | 6–12 min |
| Q200–299 | 91/100 | 12–26 min |
| Q300–399 | 84/100 | 26–43 min |
| Q400–499 | 96/100 | 44–53 min |

- **Degradation is sustained-rate, not permanent**: failure density rises after ~15
  minutes of continuous querying (waves 3–4), then recovers (wave 5: 96/100). No
  terminal blocking was observed; the final 10 queries were all successful.
- **Failures cluster but stay short**: longest consecutive-failure run = 3; after every
  failure run the next attempt succeeded. In this run, a retry policy of up to 3
  attempts with ~30 s spacing would have closed every gap (observed run structure, not
  a simulation).
- Latency (successful queries): p50 0.63 s, p95 5.61 s, max 8.58 s. The p95 tail is
  the timeout-adjacent shoulder — budget DDGS calls at ~10 s with the pipeline async.
- No language/market skew in failures: ok-rate by country FR 95 %, IT 95 %, ES 93 %,
  US 90 % — failures track time, not query content.
- Result hosts are wine-relevant (cdn.ct-static.com/Vivino dominate) — the query
  template (`"{display_name} wine label bottle"`) surfaces label/bottle imagery, not
  generic web images. Host mix belongs to spike 4/SPEC-04 image-verification concerns,
  not reliability.

## Consequences for SPEC-04

1. **Per-query retry (≥ 2 retries, ~30 s backoff) is a hard requirement** of the DDGS
   tier, not an optimization; single-shot DDGS forfeits ~6 % of queries to transient
   faults that measured retry spacing recovers.
2. **Pipeline pacing**: the soak ran at 2.0–3.5 s jitter between queries; even at that
   polite rate, sustained sessions degrade after ~15 min. The pilot's 500-variant
   enrichment run should treat DDGS as a background queue (session recycling on error,
   as soak.py does) rather than a burst path.
3. **Zero empty result sets** means a DDGS "success with no candidates" state needs no
   special handling at pilot scale — failure mode is transport, not content.
4. Numbers here are one session from one residential IP on one day; they justify the
   cascade design, not an SLA. The pilot run itself is the second measurement.

## Reproduce

```bash
cd ~/projects/terroir-data/spike05-ddgs
python3 soak.py          # appends results.jsonl, prints summary
```
