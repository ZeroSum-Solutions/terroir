import { describe, expect, it } from "vitest";
import {
  BOTTLE_SCAN,
  INVOICE_EXTRACTION,
  MENU_DESIGN,
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
      effort: "medium",
      maxTokens: 4000,
    });
  });

  it("pins the structured menu-design profile", () => {
    expect(MENU_DESIGN).toEqual({
      model: "claude-sonnet-5",
      effort: "medium",
      maxTokens: 12000,
    });
  });

  it("pins the wine enrichment profile", () => {
    // Held at the incumbent on purpose: every newer candidate lost a blind
    // quality eval. See the rationale block in models.ts before changing this.
    expect(WINE_ENRICHMENT).toEqual({
      model: "claude-sonnet-4-5-20250929",
      maxTokens: 400,
    });
    expect(WINE_ENRICHMENT_TOKENS_PER_WINE).toBe(300);
  });

  it("omits effort on models that do not support the parameter", () => {
    // claude-sonnet-4-5-20250929 is absent from Anthropic's effort-supported
    // model list, so sending the parameter would be silently ignored.
    expect(WINE_ENRICHMENT.effort).toBeUndefined();
  });

  it("leaves thinking headroom under every output cap", () => {
    // Sonnet 5 has adaptive thinking on by default and thinking counts
    // against max_tokens, so a cap sized only for the response truncates.
    for (const profile of [INVOICE_EXTRACTION, BOTTLE_SCAN, MENU_DESIGN]) {
      expect(profile.maxTokens).toBeGreaterThanOrEqual(4000);
    }
  });
});
