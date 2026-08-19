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
 * Low effort: the extraction is short, the user is waiting on it, and the
 * route returns the parse to the client for confirmation rather than
 * persisting it — a wrong vintage is caught by a human before it becomes a
 * row. Adaptive thinking still engages on genuinely hard labels.
 *
 * The cap moved 2000 → 4000 purely for thinking headroom: `max_tokens` is a
 * ceiling, not a charge, so unused budget costs nothing, but a truncated
 * response costs the whole call.
 */
export const BOTTLE_SCAN: ModelProfile = {
  model: "claude-sonnet-5",
  effort: "low",
  maxTokens: 4000,
};

/**
 * Sommelier enrichment — drink window, peak year, tasting note, decant time.
 *
 * This is the bulk-cost path: onboarding an existing cellar runs it over every
 * wine, so it dominates AI COGS at exactly the moment a customer has paid
 * nothing yet. Haiku 4.5 is 3x cheaper than the Sonnet 4.5 it replaces, stays
 * on the old tokenizer (so the cut is a real 3x, not eroded to ~2x), and
 * defaults to thinking OFF — behaviourally identical to the model it replaces,
 * which keeps the existing per-wine token budgets valid.
 *
 * GATE: this trades capability for cost on user-visible prose. Qualify it on a
 * blind set (obscure producers, mature vintages, recent releases, non-European
 * wines, incomplete records) before the first paying cellar import. If it does
 * not hold, move to `claude-sonnet-5` at low effort and raise the per-wine
 * caps to leave thinking headroom.
 */
export const WINE_ENRICHMENT: ModelProfile = {
  model: "claude-haiku-4-5-20251001",
  maxTokens: 400,
};

/** Per-wine token budget for the batched enrichment call. */
export const WINE_ENRICHMENT_TOKENS_PER_WINE = 300;
