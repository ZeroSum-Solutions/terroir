import { describe, expect, it } from "vitest";
import {
  BOTTLE_SCAN,
  INVOICE_EXTRACTION,
  WINE_ENRICHMENT,
  WINE_ENRICHMENT_TOKENS_PER_WINE,
} from "./models";

/**
 * Model pins drift silently — that is exactly how the scanner ended up on
 * `claude-sonnet-4-6` while enrichment sat on `claude-sonnet-4-5-20250929`.
 * These assertions are deliberately literal rather than derived from the
 * module, so changing a profile fails here and has to be done on purpose.
 */
describe("Claude model profile contract", () => {
  it("pins the invoice extraction profile", () => {
    expect(INVOICE_EXTRACTION).toEqual({
      model: "claude-sonnet-5",
      effort: "medium",
      maxTokens: 16000,
    });
  });

  it("pins the bottle scan profile", () => {
    expect(BOTTLE_SCAN).toEqual({
      model: "claude-sonnet-5",
      effort: "low",
      maxTokens: 4000,
    });
  });

  it("pins the wine enrichment profile", () => {
    expect(WINE_ENRICHMENT).toEqual({
      model: "claude-haiku-4-5-20251001",
      maxTokens: 400,
    });
    expect(WINE_ENRICHMENT_TOKENS_PER_WINE).toBe(300);
  });

  it("omits effort on models that do not support the parameter", () => {
    // Haiku 4.5 is absent from Anthropic's effort-supported model list.
    expect(WINE_ENRICHMENT.effort).toBeUndefined();
  });

  it("leaves thinking headroom under every output cap", () => {
    // Sonnet 5 has adaptive thinking on by default and thinking counts
    // against max_tokens, so a cap sized only for the response truncates.
    for (const profile of [INVOICE_EXTRACTION, BOTTLE_SCAN]) {
      expect(profile.maxTokens).toBeGreaterThanOrEqual(4000);
    }
  });
});
