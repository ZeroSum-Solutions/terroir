# Spike 1 — STT wine-vocab eval (VWP-D-02)

Date: 2026-08-25 · Parent: `2026-08-24-visual-wine-platform-spec-list.md` §3 (spike 1)
Feeds: SPEC-19 (voice intake), SPEC-21/22 (voice retrieval)
Artifacts: `~/projects/terroir-data/spike01-stt/` (utterances, audio, results.jsonl,
per_entity.json, resolver_replay.json, scripts). 700 live transcriptions + 192
full-catalog resolutions, 0 API errors.

**Audit trail.** This spike was adversarially audited by GPT-5.6 Sol (Codex,
2026-08-25; transcript in the session scratchpad). Audit verdict on the first
write-up: **OVERTURN as written** — the vendor ordering was confirmed sound at every
matched configuration, but survival was a proxy metric, the statistics lacked
clustering, and several claims were overstated. All nine required corrections are
applied below, including the audit's prescribed remediation: replaying the real
transcripts through a resolver against the full 211,498-row catalog. Two scorer bugs
the audit found (span-width gap on short transcripts; substring "exact") are fixed and
all numbers regenerated.

## Verdict

**VWP-D-02 = AssemblyAI (Universal-3.5 Pro) — committed for the demo phase;
provisional for production.** On the decision-grade metric (full-catalog resolution
correctness, clustered at utterance level), AssemblyAI beats a correctly configured
Deepgram Nova-3 by **+18.8 pp (p = 0.009)** with the naive resolver and **+17.2 pp
(p = 0.042)** with the producer-gated resolver. It also never returned an empty
transcript and accepted a keyterm list Deepgram rejects. Production commitment
requires one further gate: a small human-speech / noisy / streaming validation
(audit requirement, correct — everything here is clean TTS audio).

| decision metric (211k-catalog resolution, correct %) | naive | prodgate |
|---|---|---|
| AssemblyAI, full priming | **60.9** | **51.6** |
| Deepgram `multi` + capped priming | 42.2 | 34.4 |

## Corpus

50 utterances in restaurant/cellar phrasing — 20 French, 15 Italian, 12 Spanish, 3
German — carrying 93 distinct hard entities (by language: 36 fr / 25 it / 25 es / 7
de). Each rendered twice by macOS TTS at 16 kHz mono (100 clips): **en** = US English
voice (anglicised names, the common US-restaurant case); **nat** = native-locale voice
with an accented English carrier (the sommelier case). Both renditions are
deterministic TTS — see Validity limits.

## Metrics

1. **Resolution (decision metric, added on audit).** Each transcript of the 32
   utterances with clean-reference ground truth (mapped to `lwin_catalog` rows at
   trigram ≥ 0.45 from *reference text*, not transcripts — no circularity) is resolved
   against all 211,498 rows. Verdicts: correct / wrong-wine / abstain, with wrong-wine
   split by producer. Two resolver variants: `naive` (accept argmax ≥ 0.30) and
   `prodgate` (accept only with independent producer-field corroboration ≥ 0.30).
2. **Entity survival (diagnostic only).** pg_trgm similarity(target, best transcript
   span) ≥ 0.30 — `match_lwin`'s primary threshold
   (`0078_match_lwin_trgm_fastpath.sql`). Retained because it is computable for all 93
   entities and isolates STT quality from resolver design; no longer the headline.
3. WER is reported but decides nothing (vendors format numerals differently).

**Scorer fidelity (audit-hardened):** the pg_trgm reimplementation was validated
against a live Postgres 16 + pg_trgm instance on 203 pairs drawn from the actual eval
transcripts: **max |delta| = 0.000000**. (The single repo-recorded value,
Pichon 0.55, also reproduces: 0.5510 vs live 0.5510204.)

**Accent finding (new, measured live):** production `match_lwin` does NOT fold
accents (`lower()` only) and the catalog is 99.75 % ASCII, while AssemblyAI emits
accented transcripts. Live pg_trgm: `similarity('côte-rôtie','cote rotie') = 0.294` —
**below the 0.3 threshold**. Accent folding app-side before resolution is therefore a
hard SPEC-19/21 requirement; all scoring here models the pipeline with that
requirement met.

## Results — resolution vs the full 211k catalog (n = 64 clips/config)

| config | variant | correct | wrong same-producer | wrong cross-producer | abstain |
|---|---|---|---|---|---|
| aai_keyterm_full | naive | **60.9** | 7.8 | 31.2 | 0.0 |
| aai_keyterm_full | prodgate | **51.6** | 7.8 | **6.2** | 34.4 |
| aai_plain | naive | 29.7 | 9.4 | 50.0 | 10.9 |
| aai_plain | prodgate | 26.6 | 9.4 | 18.8 | 45.3 |
| dg_multi_keyterm_cap | naive | 42.2 | 7.8 | 45.3 | 4.7 |
| dg_multi_keyterm_cap | prodgate | 34.4 | 7.8 | 7.8 | 50.0 |

What this establishes beyond the vendor pick:

- **A naive global-catalog resolver is unshippable** for voice: 31–50 % cross-producer
  misidentification, and median top-1/top-2 margins of 0.06–0.10 — margin rules alone
  cannot rescue it at catalog scale.
- **Producer corroboration works**: cross-producer wrongness collapses to 6–8 % at the
  cost of 34–50 % abstention. With the abstain-over-misidentify NFR, that trade is the
  correct direction; UX absorbs abstention as top-3-or-ask.
- **Same-producer wrong-cuvée (~8 %) is a disambiguation problem**, not a
  misidentification catastrophe (e.g. DRC Romanée-Conti returned for DRC La Tâche).
- Scope note: SPEC-21 retrieval resolves against a *venue list* (hundreds of rows),
  where spike 9 measures far higher accuracy; the 211k replay is the worst case
  (voice intake of an unknown wine) and bounds SPEC-19.

## Results — entity survival, diagnostic (188 obs/config; scorer post-fix)

| config | exact% | survive@0.3 | mean trgm | WER% | empty transcripts |
|---|---|---|---|---|---|
| aai_plain | 40.4 | 78.2 | 0.651 | 43.1 | 0.0 % |
| aai_keyterm_cap | 87.2 | 95.2 | 0.929 | 23.9 | 0.0 % |
| aai_keyterm_full | 94.7 | **96.8** | 0.966 | 22.5 | 0.0 % |
| dg_plain (`language=en`) | 11.7 | 42.0 | 0.321 | 57.3 | **21.0 %** |
| dg_keyterm_cap (`en`) | 35.1 | 60.6 | 0.503 | 47.8 | **21.0 %** |
| dg_multi | 27.7 | 73.9 | 0.584 | 45.2 | 0.0 % |
| dg_multi_keyterm_cap | 68.6 | 90.4 | 0.820 | 29.4 | 1.0 % |

The `language` finding stands: Nova-3's `en` default returned **empty transcripts on
42 % of native-voice clips** (0 % on anglicised); `language=multi` eliminates the
collapse (42 % → 0 %). AssemblyAI is multilingual by default. The first-run
comparison was Deepgram-misconfigured; every conclusion here uses Deepgram's corrected
mode. French is the hardest language for both vendors unprimed (68.1 % / 68.1 %
survival); no entity failed in every config (0/93).

## Statistics (utterance-clustered, audit-required)

Sign-flip permutation on per-utterance mean differences (100k permutations, 50
clusters for survival / 32 for resolution):

| comparison | mean diff | p |
|---|---|---|
| RESOLUTION naive: aai_full vs dg_multi_cap | **+18.8 pp** | **0.009** |
| RESOLUTION prodgate: aai_full vs dg_multi_cap | **+17.2 pp** | **0.042** |
| survival: aai_full vs dg_multi_cap | +6.0 pp | 0.033 |
| survival cap-matched: aai_cap vs dg_multi_cap | +4.7 pp | 0.062 — **not significant** |

Reported honestly: the cap-matched *survival* margin alone would not carry the
decision. The decision rests on the resolution metric, where the margin is larger and
significant under both resolver variants. (Entity-level exact McNemar on the headline
pair: 16 vs 4 discordant, p = 0.012 — consistent, but the clustered test is the one
that respects shared clips.)

## Keyterm capacity — observed acceptance facts (not maxima)

| vendor | documented cap | observed |
|---|---|---|
| AssemblyAI `keyterms_prompt` | 1,000 words, ≤6 words/phrase | **accepted** the full 93-phrase / 156-word list; documented max not probed |
| Deepgram `keyterm` | 500 tokens total | **rejected** 93/156; accepts at most **75 phrases / 124 words** of this list (live prefix search) |

The implied ~3.9 tokens/word for wine vocabulary is derived arithmetic (500 ÷ 124–129),
not tokenizer output. Practical consequence unchanged: **neither vendor can prime a
20k-bottle list** — keyterm priming is a per-venue *hot-list selection* problem for
SPEC-19/21, with materially more headroom on AssemblyAI (documented, partially
verified) than on Deepgram (measured ceiling).

## Validity limits

1. **TTS, not human speech; no noise; no disfluencies; batch, not streaming.** The
   production gate above exists because any of these could compress the margin. The
   "native" rendition is a foreign-locale system voice speaking an English carrier —
   an approximation of accented speech, not a measurement of it.
2. **Priming is oracle-favourable**: the keyterm lists contain every answer and few
   distractors (Deepgram's 500-token cap leaves no room for more); one seeded 75-phrase
   subset was tested. Keyterm-priming numbers are upper bounds.
3. **Ground truth** covers the 32 utterances mappable to LWIN at ≥ 0.45 from clean
   reference text; U46 (Muga Prado Enea) and U49 (Keller G-Max) are excluded as
   unmappable, recorded in spike 9's mapping_report.

## Consequences for the specs (audit-requalified)

1. **SPEC-19/21 — hot-list selection is a design requirement.** Selection source
   (by-the-glass, recent scans, velocity) and refresh cadence must be specified.
   Budget: ≤ 75 phrases if Deepgram is ever in the path; AssemblyAI verified to at
   least 93 phrases, documented to 1,000 words.
2. **Abstain path is mandatory** (unconditionally — follows from the NFR; the replay
   shows even the best config resolves only ~61 % naive against the open catalog).
3. **The dangerous failure is the plausible-but-wrong transcript**, now measured:
   31.2 % cross-producer wrong at best-config naive. Empty transcripts are the *cheap*
   guard: directly detectable, must map to abstention/re-prompt, and empty-rate joins
   SPEC-21's eval metrics. (First write-up called empty transcripts the dangerous
   case; the audit correctly inverted that.)
4. **If Deepgram is wired as fallback, `language=multi` is required** — qualified to
   this tested batch/TTS configuration; re-verify under streaming before relying on it.
5. **Accent folding before resolution is a hard requirement** (measured: accented
   query vs ASCII catalog scores 0.294 < 0.3 threshold).
6. **Resolver must use producer corroboration or equivalent** — bare similarity
   thresholds misidentify across producers at 31–50 %; the gate cuts this to 6–8 %.
7. **Language weighting for the production eval should follow the partner CSV** —
   this corpus was FR-weighted by construction; "French is the largest share of a
   fine-wine list" was asserted without evidence in the first write-up and is
   retracted until the partner inventory measures it.

## Cost (estimates, derived — not billing-console readings)

4.67 min of audio (ffprobe-summed) × 7 configs + capacity probes. AssemblyAI ≈ 0.23 h
batch against a 185 h free tier, keyterm add-on ≈ $0.01 at the published $0.05/hr.
Deepgram ≈ 18.7 min + probes ≈ **$0.09–0.15** at published Nova-3 rates against the
$200 credit (key lacks `billing:read`; console not read back).

## Reproduce

```bash
cd ~/projects/terroir-data/spike01-stt
python3 render.py                      # 100 clips via macOS say + ffmpeg
.venv/bin/python run_stt.py            # cached by (clip, config)
.venv/bin/python score.py              # integrity gate + survival tables
.venv/bin/python resolver_replay.py    # 211k-catalog resolution, both variants
```
Requires `ASSEMBLYAI_API_KEY` / `DEEPGRAM_API_KEY` (ZS Vault). The pg_trgm validation
used a throwaway local Postgres 16 (`initdb` + `create extension pg_trgm`).
