import { describe, expect, it } from "vitest";
import { readApiError } from "./client-error";

describe("readApiError", () => {
  it("reads the nested API envelope and manual fallback text", () => {
    expect(
      readApiError(
        {
          error: {
            code: "unprocessable",
            message: "Use manual entry.",
            details: { rawText: "invoice text" },
          },
        },
        "Fallback",
      ),
    ).toEqual({ message: "Use manual entry.", rawText: "invoice text" });
  });

  it("retains legacy flat compatibility", () => {
    expect(readApiError({ error: "Legacy failure." }, "Fallback")).toEqual({
      message: "Legacy failure.",
      rawText: undefined,
    });
  });

  it("uses the caller fallback for malformed payloads", () => {
    expect(readApiError(null, "Fallback")).toEqual({
      message: "Fallback",
      rawText: undefined,
    });
  });
});
