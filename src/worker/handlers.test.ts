import { describe, expect, it } from "vitest";
import { createJobHandlers } from "./handlers.ts";

describe("worker business handler registry", () => {
  it("registers only the source-complete wine-list PDF pilot", () => {
    const handlers = createJobHandlers({} as never);
    expect(Object.keys(handlers)).toEqual(["wine_list_pdf"]);
    expect(handlers.invoice_ocr).toBeUndefined();
    expect(handlers.wine_enrichment).toBeUndefined();
  });
});
