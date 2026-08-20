import { describe, expect, it } from "vitest";
import { extractPaletteFromImage } from "./palette";
import { BRAND_PALETTE_PNG } from "@/test/fixtures/menu-theme";

describe("extractPaletteFromImage", () => {
  it("deterministically extracts the dominant colours from the fixture image", async () => {
    await expect(
      extractPaletteFromImage(BRAND_PALETTE_PNG, "image/png"),
    ).resolves.toEqual(["#CC2233", "#2244CC", "#111111", "#22AA66"]);
  });
});
