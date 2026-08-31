# Spike 9 — voice-retrieval eval construction (SPEC-21 viability)

Date: 2026-08-25 · Parent: `2026-08-24-visual-wine-platform-spec-list.md` §3 (spike 9)
Artifacts: `~/projects/terroir-data/spike09-voice-retrieval/` (fixture_inventory.json,
cases.jsonl, mapping_report.json, baseline_results.json, build_eval.py, baseline.py)

## Verdict

**Eval is viable — CONSTRUCTED, and it already discriminates.** 206 cases over a
250-item fixture built from the real production LWIN catalog, with queries carrying
*measured* STT degradation (spike 1's actual AssemblyAI transcripts, primed and
unprimed — not synthetic typos). A deliberately naive baseline resolver separates STT
configs end-to-end (92 % vs 81 % resolution) and, more importantly, **exposes an
NFR-critical resolver failure that similarity thresholds cannot fix** (below).

*Numbers updated 2026-08-25 after the spike-1 audit:* the scorer's span-width fix
(GPT-5.6 Sol audit finding 3) made the naive baseline evaluate short spans it
previously skipped, which raised scores across the board and **increased measured
false accepts from 12 % to 50 %** at the best STT config — the danger got larger, not
smaller. The full-catalog resolver replay in
`2026-08-25-spike-01-stt-vendor-eval.md` then quantified the fix: producer
corroboration cuts cross-producer misidentification to 6–8 %.

## Construction

- **Queries**: spike 1's real transcripts for the selected vendor, configs
  `aai_keyterm_full` + `aai_plain` (50 utterances × 2 renditions × 2 configs), plus 6
  synthetic garbage cases (empty transcript, filler, non-wine requests, and one real
  Deepgram-collapse output).
- **Case taxonomy** (hand-classified; a producer or single-vineyard/cuvée name makes it
  `specific`, appellation/grape-only is `category`): 34 specific, 15 category,
  1 similarity. Category and similarity cases are labeled but not baseline-scored — they
  eval the *tool's filter semantics*, which don't exist yet; they activate at ticket
  time.
- **Fixture**: 32/34 specific utterances mapped to real `lwin_catalog` rows at trigram
  ≥ 0.45 (U46 Muga Prado Enea and U49 Keller G-Max fell short — recorded in
  `mapping_report.json`, their cases marked unscored). 24 targets in inventory, **8 held
  out** (spread across fr/it/es/de) so their transcripts become out-of-inventory
  must-abstain cases. Distractors: 48 near-neighbors chosen by producer similarity
  (the Pichon Baron/Lalande class) + 178 random rows = 250 items.
- **Expectations**: 96 resolve · 38 abstain · 60 category · 4 similarity · 8 unscored.

## Baseline results (trigram best-span, accept@0.30 — match_lwin's threshold, no margin rule, no producer weighting)

| | resolve correct | out-of-inv abstain correct | garbage abstain |
|---|---|---|---|
| aai_keyterm_full | **92 %** (48) | **50 %** (16) | — |
| aai_plain | 81 % (48) | 62 % (16) | — |
| synthetic garbage | — | — | **100 %** (6) |

The 11-point resolution gap between primed and unprimed STT proves the eval measures the
end-to-end pipeline, not just string matching.

## The finding that binds SPEC-21: threshold-only acceptance cannot ship

With a **perfect transcript** — "Brunello di Montalcino from Biondi-Santi, 2016", the
wine held out of inventory — the baseline resolves to **Fanti, Brunello di Montalcino,
Vallocchio** at similarity 0.59 (post scorer-fix; 0.53 pre-fix), well above any plausible accept threshold. Appellation
vocabulary ("Brunello di Montalcino") dominates the trigram mass; the producer tokens
that distinguish right from wrong are a minority of the string. This is the same
shared-vocabulary failure the P2 round-5 critic proved for the identity gate
(0097_canonical_wines.sql: Pichon Baron vs Pichon Lalande at 0.55), now reproduced on
the retrieval path with real audio-derived input.

False-accept rate on out-of-inventory queries: **50 %** at the best STT config (post
scorer fix) — and these are confident, wrong, guest-facing answers, the exact failure
the abstain-over-misidentify NFR exists to prevent.

**Requirements this forces into SPEC-21's ticket spec:**
1. The server-side resolver needs **producer-token corroboration** (accept only if the
   producer field independently matches) or a **margin rule** (top-1 vs top-2 gap), not
   a bare similarity threshold.
2. Out-of-inventory false-accept rate becomes a **gated metric** in the eval YAML, with
   its denominator reported separately from in-inventory accuracy — same discipline as
   Gate 0's split false-accept reporting.
3. Empty-transcript rate joins the metric set (from spike 1; the garbage cases carry it).

## Scope notes (recorded, deliberate)

- Wine-grain, not edition-grain: vintage extraction is numeric, separately easy for STT,
  and evals independently at ticket time.
- Wine-name-only utterances get no same-wine-other-producer distractors; if a venue list
  carries two producers' Monts Damnés, the product answer is a disambiguation prompt —
  ticket-time eval semantics, noted in build_eval.py.
- The baseline is deliberately the dumbest resolver the platform could ship; its numbers
  are a floor to beat, not a product measurement.

## Reproduce

```bash
cd ~/projects/terroir-data/spike09-voice-retrieval
../spike01-stt/.venv/bin/python build_eval.py   # deterministic (seeded)
../spike01-stt/.venv/bin/python baseline.py
```
