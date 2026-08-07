import { describe, expect, it } from "vitest";
import {
  resolveWineListPdfTemplate,
  wineListPdfArtifactPath,
  wineListPdfFilename,
} from "./wine-list-pdf-service";

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const LIST_ID = "22222222-2222-4222-8222-222222222222";

describe("wine-list PDF value boundaries", () => {
  it("resolves only registered templates and defaults unsafe values", () => {
    expect(resolveWineListPdfTemplate("modern")).toBe("modern");
    expect(resolveWineListPdfTemplate("../../escape")).toBe("classic");
    expect(resolveWineListPdfTemplate(null)).toBe("classic");
  });

  it("builds only canonical UUID-scoped artifact paths", () => {
    expect(wineListPdfArtifactPath({
      restaurantId: RESTAURANT_ID,
      listId: LIST_ID,
      template: "minimal",
    })).toBe(`${RESTAURANT_ID}/${LIST_ID}_minimal.pdf`);
    expect(() => wineListPdfArtifactPath({
      restaurantId: "../escape",
      listId: LIST_ID,
      template: "classic",
    })).toThrow("artifact identity is invalid");
    expect(() => wineListPdfArtifactPath({
      restaurantId: RESTAURANT_ID,
      listId: LIST_ID,
      template: "../escape" as "classic",
    })).toThrow("artifact identity is invalid");
  });

  it("sanitizes attachment filenames with a non-empty fallback", () => {
    expect(wineListPdfFilename("Chef's Reserve / 2026")).toBe(
      "Chefs Reserve  2026.pdf",
    );
    expect(wineListPdfFilename("酒单")).toBe("Wine List.pdf");
  });

  it("bounds attachment filenames to the artifact download contract", () => {
    const filename = wineListPdfFilename("A".repeat(300));

    expect(filename).toHaveLength(204);
    expect(filename).toBe(`${"A".repeat(200)}.pdf`);
  });
});
