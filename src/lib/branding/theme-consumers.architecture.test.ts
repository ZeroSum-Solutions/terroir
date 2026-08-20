import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wine_lists.theme consumers", () => {
  it("wires the public list and PDF service to the same stored theme source", () => {
    const publicPage = readFileSync("src/app/list/[slug]/page.tsx", "utf8");
    const pdfService = readFileSync(
      "src/domains/wine-lists/wine-list-pdf-service.ts",
      "utf8",
    );

    expect(publicPage).toContain("theme");
    expect(publicPage).toContain("themeCssVariables");
    expect(pdfService).toContain("theme");
    expect(pdfService).toContain("parseRenderableTheme");
    expect(pdfService).toMatch(/renderTemplate\([\s\S]*theme/);
  });
});
