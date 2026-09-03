import { describe, expect, it } from "vitest";
import {
  BOTTLE_SCAN,
  INVOICE_EXTRACTION,
  INVOICE_EXTRACTION_RETRY,
  MENU_DESIGN,
  DESCRIPTOR_SUGGESTION,
} from "./models";

/**
 * Model pins drift silently — that is exactly how the scanner ended up on
 * `claude-sonnet-4-6` while enrichment sat on `claude-sonnet-4-5-20250929`.
 * These assertions are deliberately literal rather than derived from the
 * module, so changing a profile fails here and has to be done on purpose.
 */
describe("Model profile contract (OpenRouter ids)", () => {
  it("pins the invoice extraction profile", () => {
    expect(INVOICE_EXTRACTION).toEqual({
      model: "anthropic/claude-sonnet-5",
      effort: "medium",
      maxTokens: 16000,
    });
  });

  it("pins the invoice extraction retry profile (G1-12 arithmetic mismatch)", () => {
    expect(INVOICE_EXTRACTION_RETRY).toEqual({
      model: "anthropic/claude-sonnet-5",
      effort: "high",
      maxTokens: 24000,
    });
  });

  it("pins the bottle scan profile", () => {
    // Re-pinned 2026-09-02 on a measured label-reading eval — see the
    // rationale block in models.ts and docs/plans/2026-09-02-bottle-scan-model-eval.md.
    expect(BOTTLE_SCAN).toEqual({
      model: "google/gemini-3.7-flash",
      maxTokens: 4000,
    });
  });

  it("pins the structured menu-design profile", () => {
    expect(MENU_DESIGN).toEqual({
      model: "anthropic/claude-sonnet-5",
      effort: "medium",
      maxTokens: 12000,
    });
  });

  it("pins the wine enrichment profile", () => {
    // Held at the incumbent on purpose: every newer candidate lost a blind
    // quality eval. See the rationale block in models.ts before changing this.
    expect(DESCRIPTOR_SUGGESTION).toEqual({
      model: "anthropic/claude-haiku-4.5",
      maxTokens: 200,
    });
    // Haiku 4.5 is not on Anthropic's effort-supported list, so no effort is
    // sent — a value here would be silently ignored at best.
    expect(DESCRIPTOR_SUGGESTION.effort).toBeUndefined();
    // Gemini via OpenRouter's Anthropic-compatible endpoint: `effort` becomes a
    // parameter its endpoints do not advertise, and require_parameters then
    // leaves no eligible endpoint (404 in 0.2 s, measured 2026-09-02).
    expect(BOTTLE_SCAN.effort).toBeUndefined();
  });

  it("names every model by its OpenRouter id (vendor/model), never a bare vendor id", () => {
    // The client talks to OpenRouter, whose ids are namespaced. A bare
    // Anthropic id such as "anthropic/claude-sonnet-5" is a 400 there.
    for (const profile of [
      INVOICE_EXTRACTION,
      INVOICE_EXTRACTION_RETRY,
      BOTTLE_SCAN,
      MENU_DESIGN,
      DESCRIPTOR_SUGGESTION,
    ]) {
      expect(profile.model).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
    }
  });

  it("leaves thinking headroom under every output cap", () => {
    // Sonnet 5 has adaptive thinking on by default and thinking counts
    // against max_tokens, so a cap sized only for the response truncates.
    for (const profile of [
      INVOICE_EXTRACTION,
      INVOICE_EXTRACTION_RETRY,
      BOTTLE_SCAN,
      MENU_DESIGN,
    ]) {
      expect(profile.maxTokens).toBeGreaterThanOrEqual(4000);
    }
  });
});
