# Spike 1 — STT wine-vocab eval (decides VWP-D-02)

Date: 2026-08-25 · Parent: `2026-08-24-visual-wine-platform-spec-list.md` §3 (spike 1)
Feeds: SPEC-19 (voice intake), SPEC-22, SPEC-21 (voice retrieval)
Artifacts: `~/projects/terroir-data/spike01-stt/` (utterances, audio, results.jsonl,
per_entity.json, scripts). 700 live transcriptions, 0 errors.

## Verdict

**VWP-D-02 = AssemblyAI (Universal-3.5 Pro).** It wins at every matched configuration,
never returns an empty transcript, and has ~7× the keyterm capacity. But the honest
margin over a *correctly configured* Deepgram is **~5 points, not ~35** — see the
fairness correction below, which changed the answer mid-spike.

| | best measured entity survival |
|---|---|
| AssemblyAI, full priming | **96.8 %** |
| AssemblyAI, priming capped to Deepgram's ceiling | 95.2 % |
| Deepgram Nova-3, `language=multi` + capped priming | 90.4 % |
| Deepgram Nova-3, default `language=en` + priming | 60.6 % |

## The metric (and why not WER)

WER is reported but is **not** the decision metric: the vendors format numbers
differently (`2018` vs `twenty eighteen`), which moves WER without changing whether a
wine can be resolved. What matters is whether the wine entity survives transcription
well enough for the resolver to retrieve it. Primary metric:

**survival@trgm≥0.30** — `pg_trgm.similarity(target, best transcript span) ≥ 0.30`,
which is `match_lwin`'s own primary ranking threshold
(`supabase/migrations/0078_match_lwin_trgm_fastpath.sql`, thresholds 0.3 / 0.21).

The scorer reimplements pg_trgm rather than calling the database. It is validated
against the only live pg_trgm value recorded in this repo: `0097_canonical_wines.sql`
notes the round-5 critic measured `similarity('Chateau Pichon Longueville Baron',
'Chateau Pichon Longueville Comtesse de Lalande') = 0.55`; this implementation returns
**0.5510**.

**Survival is necessary, not sufficient.** It asks "did enough of the entity survive for
`match_lwin` to rank the right row?" — not "did resolution then succeed against the
211k-row catalog." A surviving-but-degraded string can still retrieve the wrong wine.
Treat these numbers as an upper bound on end-to-end voice resolution.

## Corpus

50 utterances in restaurant/cellar phrasing (intake and retrieval), carrying 93 distinct
hard entities: 20 French, 15 Italian, 12 Spanish, 3 German. Each rendered twice by macOS
TTS, giving 100 clips at 16 kHz mono:

- **en** — US English voice (Samantha): anglicised pronunciation of the wine names. The
  common US-restaurant case.
- **nat** — native-locale voice (Thomas / Alice / Mónica / Anna): correct pronunciation of
  the wine vocabulary with an accented English carrier. The sommelier case.

## Results — entity survival (%)

| config | exact | **survive@0.3** | mean trgm | WER | empty transcripts |
|---|---|---|---|---|---|
| aai_plain | 43.6 | 78.2 | 0.651 | 43.1 | 0.0 % |
| aai_keyterm_cap | 88.8 | 95.2 | 0.929 | 23.9 | 0.0 % |
| aai_keyterm_full | 95.7 | **96.8** | 0.966 | 22.5 | 0.0 % |
| dg_plain (`language=en`) | 11.7 | 41.5 | 0.321 | 57.3 | **21.0 %** |
| dg_keyterm_cap (`en`) | 36.7 | 60.6 | 0.502 | 47.8 | **21.0 %** |
| dg_multi (`language=multi`) | 29.3 | 73.9 | 0.584 | 45.2 | 0.0 % |
| dg_multi_keyterm_cap | 70.7 | **90.4** | 0.820 | 29.4 | 1.0 % |

### By rendition — the finding that changed the verdict

| config | en (anglicised) | nat (native) |
|---|---|---|
| aai_plain | 74.5 | 81.9 |
| aai_keyterm_full | 98.9 | 94.7 |
| dg_plain (`en`) | 63.8 | **19.1** |
| dg_keyterm_cap (`en`) | 85.1 | 36.2 |
| dg_multi | 64.9 | 83.0 |
| dg_multi_keyterm_cap | 93.6 | 87.2 |

Deepgram's collapse on native pronunciation was **not** poor accuracy — it was returning
**nothing at all** on 42 % of native-voice clips. Nova-3 defaults to `language=en`;
AssemblyAI's Universal-3.5 Pro is multilingual by default. Comparing them as first run
was comparing AssemblyAI's best against Deepgram misconfigured, so `language=multi` was
added and re-run. That single parameter takes Deepgram from 41.5 % → 73.9 % unprimed and
60.6 % → 90.4 % primed, and empty transcripts from 42 % → 0 %.

### By language (survive %)

| config | fr | it | es | de |
|---|---|---|---|---|
| aai_plain | 68.1 | 80.8 | 90.0 | 78.6 |
| aai_keyterm_full | 97.2 | 96.2 | 96.0 | 100.0 |
| dg_multi | 68.1 | 75.0 | 78.0 | 85.7 |
| dg_multi_keyterm_cap | 88.9 | 92.3 | 90.0 | 92.9 |

French is the hardest language for both vendors unprimed — and it is the largest share of
a fine-wine list. No entity was unrecognisable: **0 of 93 failed in every config.**

### Keyterm effect, isolated

The entities excluded from the capped list are intrinsically easier, so the raw in-list
vs not-in-list gap is confounded. Using each vendor's own unprimed run as the difficulty
baseline (difference-in-differences):

| vendor | baseline gap (unprimed) | gap with priming | **priming effect** |
|---|---|---|---|
| AssemblyAI | −6.4 | +7.8 | **+14.2** |
| Deepgram `en` | −24.3 | +6.3 | **+30.6** |
| Deepgram `multi` | −15.1 | +5.3 | **+20.4** |

Deepgram gains more from priming because it starts far lower; AssemblyAI gains less
because it is already near ceiling.

## Keyterm capacity — a hard product constraint

Measured live, not assumed:

| vendor | documented cap | measured wine-vocab capacity |
|---|---|---|
| AssemblyAI `keyterms_prompt` | 1,000 **words**, ≤6 words/phrase | full 93-phrase / 156-word list accepted |
| Deepgram `keyterm` | 500 **tokens** total | **75 phrases / 124 words** (binary-searched) |

Deepgram's cap is tokens, not phrases, and wine vocabulary tokenises at **~3.9
tokens/word** — so a 93-entity list (156 words) already exceeds it. Deepgram's docs
recommend 20–50 terms.

**Neither vendor can prime a 20k-bottle list.** Priming must therefore be a *selected hot
list* per venue, not the whole inventory — that is a design requirement for SPEC-19/21,
not an optimisation. AssemblyAI's hot list can be ~7× larger.

## What this does NOT establish

The eval deliberately isolates vocabulary recognition. It is an **upper bound**:

1. **TTS, not human speech** — clean articulation, no disfluencies, no dialect variation.
2. **No background noise** — a restaurant floor is the actual operating environment.
   Noise robustness is the untested axis and is where vendors often separate.
3. **Priming is oracle-favourable** — the keyterm list contains every answer and almost
   no distractors, because Deepgram's 500-token cap leaves no room for more. Real hot
   lists carry a far worse signal-to-distractor ratio.
4. **Batch, not streaming** — voice intake is likely streaming, where both vendors have
   different (smaller) keyterm limits and different accuracy.
5. **Survival ≠ resolution** — see the metric caveat above.

## Consequences for the specs

1. **SPEC-19/21 — priming is a selection problem.** Ticket work must include how the hot
   list is chosen (by-the-glass, recent scans, high-velocity SKUs) and refreshed. Assume
   ~600 phrases on AssemblyAI, ~75 on Deepgram.
2. **Abstain path is mandatory.** Even the best config misses ~3 % of entities under
   laboratory-clean audio; real audio will be worse, and survival overstates resolution.
   The voice tool must be able to say "I didn't catch that" — consistent with the
   abstain-over-misidentify NFR.
3. **A silent empty transcript is the dangerous failure mode.** Deepgram's misconfigured
   mode returned empty strings, which look like "no speech" rather than "low confidence"
   and would silently drop a bottle from intake. Any fallback vendor must be checked for
   this class of failure, and empty-transcript rate belongs in the voice eval (SPEC-21).
4. **If Deepgram is ever wired as a fallback, `language=multi` is mandatory** — the
   English default is unusable for a wine list.
5. **French carries the largest unprimed risk** and the largest share of a fine-wine list;
   weight the voice eval set accordingly.

## Cost

4.67 min of audio, 700 transcriptions. AssemblyAI: 0.234 h, inside the free tier, ~$0.01
of keyterm add-on. Deepgram: 18.7 min ≈ **$0.09** against the $200 signup credit. The
Deepgram key lacks `billing:read` scope, so remaining credit was not read back — the
figure is derived from published rates, not the console.

## Reproduce

```bash
cd ~/projects/terroir-data/spike01-stt
python3 render.py            # 100 clips via macOS `say` + ffmpeg
.venv/bin/python run_stt.py  # cached by (clip, config); reruns are free
.venv/bin/python score.py
```
Requires `ASSEMBLYAI_API_KEY` and `DEEPGRAM_API_KEY` in the environment (ZS Vault).
