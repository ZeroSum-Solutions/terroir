/**
 * Per-task Claude model profiles.
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
  model: "claude-sonnet-5",
  effort: "medium",
  maxTokens: 16000,
};

/**
 * Bottle-label identification from a phone photo (vision).
 *
 * Medium, not low. This path has no eval — there is no labelled corpus of
 * bottle photographs to grade against, so there is no evidence to justify
 * stepping below the quality-neutral setting. The enrichment eval, which could
 * be measured, found low effort produced more factual errors than medium on
 * the same model (5 vs 3), so low is not a free saving. Revisit with a labelled
 * set; the route already returns a `confidence` field to grade against.
 *
 * The route returns the parse to the client for confirmation rather than
 * persisting it, so a wrong vintage is caught by a human before it becomes a
 * row — but that is a safety net, not a reason to spend less.
 *
 * The cap moved 2000 → 4000 purely for thinking headroom: `max_tokens` is a
 * ceiling, not a charge, so unused budget costs nothing, but a truncated
 * response costs the whole call.
 */
export const BOTTLE_SCAN: ModelProfile = {
  model: "claude-sonnet-5",
  effort: "medium",
  maxTokens: 4000,
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
  model: "claude-sonnet-4-5-20250929",
  maxTokens: 400,
};

/** Per-wine token budget for the batched enrichment call. */
export const WINE_ENRICHMENT_TOKENS_PER_WINE = 300;
