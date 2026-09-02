# Bottle-scan model eval — 2026-09-02

**Why.** The cutover to OpenRouter (#194) made every model call re-addressable by
one string, and the owner asked that a task move to a better model where one exists.
The bottle-scan profile had never had an eval (`models.ts` said so and asked for a
labelled set). This is that eval. Invoice extraction, menu design and enrichment were
not evaluated and keep their pins; enrichment's blind eval from 2026-08-19 stands.

**Method.** Production prompt (`bottle-system-prompt.ts`), schema
(`ParsedBottleLabelSchema`) and `max_tokens: 4000`, sent to OpenRouter. Ground truth is
the corpus row's `winery_name`, `name`, `country` for `xwines_catalog` rows with
`image_kind = 'label'`. Producer and name count as hits when prediction and truth
contain each other (spaces ignored, so "DeLoach" = "De Loach") or share ≥ 50 % of
their significant tokens after folding case, diacritics and punctuation and dropping
words like *winery*, *estate*, *domaine*; country is an exact folded match. Every miss
was read by hand. Latency is the SDK round-trip; cost is OpenRouter's `usage.cost`.

Two runs, two samples:

1. **Screening** — five models, 40 images (ordered by `md5(wine_id)`), `effort: "medium"`
   for all, direct client without the provider-preference wrapper. Throwaway script.
2. **Confirmation** — the shipped shape: `scripts/eval-bottle-labels.ts` through the
   production client (`require_parameters` wrapper), a different 40 images (FNV order,
   the harness's fixed sample) plus 16 of them degraded to phone quality (360 px wide,
   rotated 12°, JPEG quality 45). Gemini without `effort` (as it ships — see below),
   Sonnet 5 at `effort: "medium"` (as it shipped).

## Screening (n = 40, effort medium, sample A)

| model | producer | name | country | p50 | $/call | errors | confidence on misses |
|---|---|---|---|---|---|---|---|
| google/gemini-3.7-flash | **98 %** | **100 %** | **98 %** | 4.8 s | **0.0030** | 0 | 0.93 |
| anthropic/claude-sonnet-5 (incumbent) | 88 % | 95 % | 93 % | 4.7 s | 0.0073 | 1 | 0.40 0.45 0.55 0.75 0.85 |
| anthropic/claude-opus-5 | 95 % | 100 % | 85 % | 4.6 s | 0.0202 | 0 | 0.45 0.92 |
| x-ai/grok-4.6 | 95 % | 100 % | 90 % | 17.4 s | 0.0102 | 0 | 0.62 0.93 |
| openai/gpt-5.6-sol | 90 % | 100 % | 98 % | 6.2 s | 0.0055 | 0 | 0.68 0.90 0.97 0.98 |

Sonnet 5's error was the SDK's structured-output parse failing on the model's reply
(`invalid_value`), which the route maps to a 500. On a 16-image degraded copy of this
sample Gemini and Sonnet tied at 94 / 100 / 100 (GPT-5.6 sol 88 / 100 / 100).

## Confirmation (shipped shape, sample B)

| run | ok | producer | name | country | p50 | $/call | conf. mean | conf. on misses |
|---|---|---|---|---|---|---|---|---|
| Gemini 3.7 Flash, no effort — clean 40 | 40 | **36** | **40** | **40** | 4.9 s | 0.0030 | 0.95 | 0.95 ×4 |
| Sonnet 5, medium — clean 40 | 39 | 35 | 38 | 34 | 4.7 s | 0.0074 | 0.81 | 0.85 0.85 0.70 0.70 (+1 error) |
| Gemini 3.7 Flash, no effort — degraded 16 | 16 | **14** | **16** | **16** | 5.1 s | 0.0031 | 0.95 | 0.95 ×2 |
| Sonnet 5, medium — degraded 16 | 15 | 12 | 13 | 13 | 4.9 s | 0.0070 | 0.78 | 0.75 0.85 0.75 0.85 0.55 (+1 error) |

Every producer "miss" both models share is a brand-versus-producer naming difference,
not a misread: *La Linda* (a Luigi Bosca label), *Hemisferio* (Miguel Torres Chile),
*Campo Largo* (Zanlorenzi), *Monsaraz* (the CARMIM co-operative). Sonnet's extra
misses were two structured-output parse errors (one per set) and, on the degraded set,
two producers padded with a parent name ("Ménage à Trois (Folie à Deux)").

**Non-wine photo** (the demo's "Confirm stays disabled" beat, an app screenshot sent
twice to each model, then once through the real route on Gemini): one candidate with
confidence 0, producer and name "Unknown", every identity field flagged;
`needsCorrectionBeforeSave` is true.

**Why no `effort` for Gemini.** Through OpenRouter's Anthropic-compatible endpoint the
`effort` parameter is translated into one the Gemini endpoints do not advertise, and
with `require_parameters` no endpoint is eligible: a 404 "No endpoints found that can
handle the requested parameters" in 0.2 s, which the route showed as an instant 502.
Without it Gemini runs at its default thinking level; the confirmation numbers above are
that configuration.

**Decision.** `BOTTLE_SCAN` → `google/gemini-3.7-flash`, no effort, cap 4000. On the
shipped shape it beats the incumbent on every column of both sets, has no parse
errors against Sonnet's two (each a 500 for the user), runs at the same latency and
40 % of the cost. The trade to know about: when Gemini is wrong it says 0.95, where
Sonnet 5 usually hedges — and Gemini did not flag a missing vintage as a low field
where Sonnet did. Rollback is the one string in `models.ts`; the contract test pins
the choice.

**Caveats.** Corpus label images are catalogue photographs, cleaner than a phone shot
in a dim room; the degraded set is synthetic. Forty and sixteen samples per set, one
run each. The scorer is fuzzy by design and every miss was checked by eye.

**Spend.** About $2.20 of OpenRouter credit across both runs.
