import { describe, expect, it } from "vitest";
import { createJobHandlers } from "./handlers.ts";

describe("worker business handler registry", () => {
  it("keeps dependency-gated handlers unregistered by default", () => {
    const handlers = createJobHandlers({} as never, {});
    expect(Object.keys(handlers)).toEqual(["wine_list_pdf"]);
    expect(handlers.invoice_ocr).toBeUndefined();
    expect(handlers.wine_enrichment).toBeUndefined();
  });

  it("registers wine enrichment only after its independent handler opt-in", () => {
    const handlers = createJobHandlers({} as never, {
      WINE_ENRICHMENT_HANDLER_ENABLED: "1",
    });
    expect(Object.keys(handlers)).toEqual([
      "wine_list_pdf",
      "wine_enrichment",
    ]);
    expect(handlers.invoice_ocr).toBeUndefined();
    expect(handlers.wine_enrichment).toEqual(expect.any(Function));
  });
});
