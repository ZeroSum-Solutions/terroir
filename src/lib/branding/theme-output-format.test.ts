import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";
import { MenuThemeCollectionSchema, MenuThemeSchema } from "./theme";

/**
 * menu-design.ts hands MenuThemeCollectionSchema to the SDK's Zod → JSON
 * Schema converter for structured output. menu-design.test.ts mocks that
 * converter, so nothing checked that the real one accepts the schema — and
 * it did not: a `.transform()` inside HexColorSchema made it throw
 * "Transforms cannot be represented in JSON Schema" before any request was
 * sent, which took /api/brand-kit/propose down while every unit test stayed
 * green. This runs the real converter.
 */
describe("menu theme schema as a structured-output format", () => {
  it("is accepted by the SDK's Zod → JSON Schema converter", () => {
    expect(() => zodOutputFormat(MenuThemeCollectionSchema)).not.toThrow();
  });

  it("still normalises hex colours to upper case when parsing", () => {
    const parsed = MenuThemeSchema.pick({ palette: true }).parse({
      palette: {
        background: "#f7f5f2",
        surface: "#ffffff",
        text: "#1a1a1a",
        mutedText: "#555555",
        accent: "#721d35",
        border: "#dddddd",
      },
    });
    expect(parsed.palette.background).toBe("#F7F5F2");
    expect(parsed.palette.accent).toBe("#721D35");
  });
});
