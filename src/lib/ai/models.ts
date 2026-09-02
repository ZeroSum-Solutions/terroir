/**
 * Per-task Claude model profiles.
 *
 * Ids are OpenRouter ids (`vendor/model`) since the 2026-09-01 cutover: every
 * call goes through OpenRouter's Anthropic-compatible endpoint (see
 * `anthropic-client.ts`), so moving a task to another vendor is a change to
 * that one string — `google/gemini-3.7-flash`, `openai/gpt-5.6-sol`, … — with
 * two caveats. `effort` is Anthropic's parameter: OpenRouter honours it for
 * Claude (verified: thinking tokens rise low → high) and maps or drops it for
 * other vendors. And the eval notes below stay binding: a task moves only on
 * measured evidence, never on list price. OpenRouter bills Anthropic models at
 * Anthropic's list price (Sonnet 5 $2/$10 on both, checked 2026-09-01).
 *
 * Every production Claude call used to pin its own model string inline, so a
 * model refresh meant hunting three call sites plus a test plus the accuracy
 * harness — and two of them drifted (`claude-sonnet-4-6` in the scanner,
 * `claude-sonnet-4-5-20250929` in enrichment). Model, effort and output cap
 * are one deployment decision per task, so they live together here.
 *
 * ── Why these values (verified against platform.claude.com, 2026-08-19) ──
 *
 * Pricing per MTok (input/output):
 *   claude-sonnet-4-6           $3 / $15   ← previous pin
 *   claude-sonnet-4-5-20250929  $3 / $15   ← previous pin
 *   claude-sonnet-5             $2 / $10
 *   claude-haiku-4-5-20251001   $1 / $5
 *
 * Two facts make this less of a pure win than the list price suggests:
 *
 *  1. Claude 4.7 and later use a newer tokenizer that produces ~30% more
 *     tokens for the same text. Sonnet 5 is on it; Sonnet 4.6 and Haiku 4.5
 *     are not. So Sonnet 5's 33% list-price cut nets out to roughly 13%
 *     cheaper per equivalent input text, not 33%.
 *  2. Sonnet 5 has adaptive thinking ON by default. Sonnet 4.6 and Sonnet 4.5
 *     both defaulted to thinking OFF, so every one of these paths previously
 *     spent zero thinking tokens. Thinking counts against `max_tokens`, which
 *     is why the caps below are sized with thinking headroom — a cap that only
 *     fit the old response length would now truncate with
 *     `stop_reason: "max_tokens"`.
 *
 * `effort` is the lever for that thinking spend. Anthropic's own guidance is
 * that Sonnet 5 at medium effort is comparable to Sonnet 4.6 at high, which is
 * what these paths were implicitly running before — so medium is the
 * quality-neutral swap, and low is the deliberate step down where the task is
 * simple and a human checks the result.
 */

/** A model + effort + output-cap triple for one production task. */
export type ModelProfile = {
  readonly model: string;
  /**
   * `output_config.effort`. Undefined where the model does not support the
   * parameter — Haiku 4.5 is not on Anthropic's effort-supported list, and
   * sending it anyway would be silently ignored at best.
   */
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly maxTokens: number;
};

/**
 * Invoice line-item structuring from Azure-OCR'd text.
 *
 * Accuracy-critical: a wrong `unit_cost` here propagates straight into
 * inventory valuation. Medium effort is the quality-neutral replacement for
 * the previous implicit Sonnet 4.6 high, and adaptive thinking now gives the
 * messy invoices reasoning budget the old pin never had. The 16k cap was
 * already generous for the response alone and comfortably absorbs thinking.
 */
export const INVOICE_EXTRACTION: ModelProfile = {
  model: "anthropic/claude-sonnet-5",
  effort: "medium",
  maxTokens: 16000,
};

/**
 * Retry profile for invoice extraction (G1-12).
 *
 * Deterministic arithmetic validation (qty x unit cost vs. printed line
 * total; line-total sum vs. printed invoice total — see
 * `src/domains/scanning/invoice-arithmetic.ts`) can catch a first-pass
 * extraction that doesn't add up. One retry at higher effort follows before
 * falling back to human review; this is that retry's profile. Same model
 * and token family as INVOICE_EXTRACTION — only effort and headroom step up,
 * since a bad read is a reasoning-budget problem, not a model problem.
 */
export const INVOICE_EXTRACTION_RETRY: ModelProfile = {
  model: "anthropic/claude-sonnet-5",
  effort: "high",
  maxTokens: 24000,
};

/**
 * Bottle-label identification from a phone photo (vision).
 *
 * Re-pinned 2026-09-02 to Gemini 3.7 Flash on a measured eval — the first this
 * path has had (docs/plans/2026-09-02-bottle-scan-model-eval.md, harness at
 * scripts/eval-bottle-labels.ts). A five-model screening put Gemini first, and
 * the confirmation run below is the shipped shape: production prompt, schema
 * and cap, through the production client, on 40 corpus label images with known
 * producer / name / country plus 16 of them degraded to phone quality:
 *
 *   run                                ok   producer  name  country   p50    $/call
 *   Gemini 3.7 Flash    clean 40       40      36      40     40     4.9 s   0.0030
 *   Sonnet 5 (medium)   clean 40       39      35      38     34     4.7 s   0.0074
 *   Gemini 3.7 Flash    degraded 16    16      14      16     16     5.1 s   0.0031
 *   Sonnet 5 (medium)   degraded 16    15      12      13     13     4.9 s   0.0070
 *
 * The producer misses both share are brand-versus-producer naming (La Linda is
 * a Luigi Bosca label); Sonnet's extra failures were structured-output parse
 * errors, which the route turns into a 500. Both answer a non-wine photo with
 * confidence 0 and every identity field flagged, so the Confirm gate holds.
 * The known trade: Gemini says 0.95 when wrong, where Sonnet hedges. Rollback
 * is this one string.
 *
 * No `effort`: through OpenRouter's Anthropic-compatible endpoint the parameter
 * is translated into one the Gemini endpoints do not advertise, and with
 * `require_parameters` (anthropic-client.ts) that leaves no eligible endpoint —
 * a 404 in 0.2 s, measured 2026-09-02. Gemini runs at its default thinking
 * level; the numbers above are that configuration. The 4000 cap stays.
 */
export const BOTTLE_SCAN: ModelProfile = {
  model: "google/gemini-3.7-flash",
  maxTokens: 4000,
};

/** Structured, WCAG-aware brand theme proposals for public wine lists. */
export const MENU_DESIGN: ModelProfile = {
  model: "anthropic/claude-sonnet-5",
  effort: "medium",
  maxTokens: 12000,
};

/**
 * Sommelier enrichment — drink window, peak year, tasting note, decant time.
 *
 * DELIBERATELY NOT REFRESHED. This is the one path where the newer models lost.
 *
 * A blind eval (22 wines across obscure producers, mature vintages, releases
 * after Haiku's knowledge cutoff, non-European wines, and underspecified
 * records) scored every candidate against this incumbent. An independent model
 * graded anonymised output pairs in randomised order:
 *
 *   candidate                 wins vs 4.5   factual errors (cand. vs 4.5)
 *   claude-haiku-4-5             4 - 16            8 vs 2
 *   claude-sonnet-5 @ low        6 - 15            5 vs 3
 *   claude-sonnet-5 @ medium     8 - 13            3 vs 3
 *
 * Haiku's failure mode was systematic, not random: it truncates the ageing
 * curve of benchmark long-lived wines (Vin de Constance closed out at 2035,
 * Monte Bello at 2045, Musar at 2028). That is precisely the error a wine
 * director notices first, on prose shown to their staff.
 *
 * Cost was never the deciding factor once measured: a 2,000-wine cellar runs
 * $6.04 on this model against $4.88 on Sonnet 5 and $1.95 on Haiku. The whole
 * spread is under five dollars per cellar, one time — far too small to buy a
 * measurable quality regression with.
 *
 * MIGRATION RISK: Sonnet 4.5 is a legacy model and will eventually be retired.
 * `claude-sonnet-5` at medium effort is the designated successor — it reached
 * factual parity (3 errors each) and lost only on grader preference. Re-run the
 * eval when retirement is announced rather than swapping under time pressure.
 *
 * Known defect, independent of model choice: this prompt caps `reviewExcerpt`
 * at 200 characters and Sonnet 4.5 overran it on 4 of 22 wines. Both candidates
 * respected it. Enforce the cap in code rather than trusting the prompt.
 */
export const WINE_ENRICHMENT: ModelProfile = {
  model: "anthropic/claude-sonnet-4.5",
  maxTokens: 400,
};

/** Per-wine token budget for the batched enrichment call. */
export const WINE_ENRICHMENT_TOKENS_PER_WINE = 300;
