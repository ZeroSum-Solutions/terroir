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
 * Descriptor suggestion for a house tasting note.
 *
 * The model reads one sommelier's prose and returns which of a closed
 * vocabulary of about twenty slugs it mentions. Its answer is filtered against
 * that vocabulary, and a human taps to confirm before anything is stored, so
 * the model's output is a pre-selection rather than a fact. Failure is cheap by
 * design: every error path returns no suggestions and the composer still saves.
 *
 * NOTE ON WHAT USED TO BE HERE. This slot held WINE_ENRICHMENT, the profile for
 * the Claude tier that inferred drink windows, peak years and a "tasting-note
 * style sentence". That tier is gone — its outputs were unsourced values shown
 * on the wine page as though they were sourced. Its eval (22 wines, blind
 * pairwise grading, Sonnet 4.5 beating Haiku 4.5 16-4 and Sonnet 5 13-8, with
 * Haiku systematically truncating the ageing curve of long-lived wines) remains
 * in git history and is worth re-reading before anyone asks a model to estimate
 * a drinking window again. It does not transfer to this profile: choosing from
 * a closed list is a different task from recalling a wine's ageing curve.
 */
export const DESCRIPTOR_SUGGESTION: ModelProfile = {
  // Haiku, because this is extraction against a closed list of about twenty
  // slugs, not judgement: the model is choosing which of a fixed vocabulary a
  // short note mentions, the answer is filtered against that vocabulary
  // anyway, and a human confirms every suggestion before it is stored. Haiku
  // 4.5 is not on Anthropic's effort-supported list, so no effort is sent.
  model: "anthropic/claude-haiku-4.5",
  maxTokens: 200,
};
