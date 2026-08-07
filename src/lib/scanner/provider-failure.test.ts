import { describe, expect, it } from "vitest";
import { classifyScannerProviderFailure } from "./provider-failure";

describe("scanner provider failure taxonomy", () => {
  it.each([
    [{ status: 429, message: "private quota detail" }, "rate_limited", true, 429],
    [{ name: "TimeoutError", message: "private timeout detail" }, "timeout", true, 504],
    [{ code: "ETIMEDOUT", message: "private network detail" }, "timeout", true, 504],
    [{ status: 422, body: "private response" }, "bad_input", false, 400],
    [{ status: 503, requestId: "private-request-id" }, "unavailable", true, 502],
    [{ code: "ECONNRESET", cause: "private endpoint" }, "unavailable", true, 502],
    [new Error("private unknown detail"), "unknown", false, 500],
  ] as const)(
    "classifies without exporting provider detail",
    (error, kind, retryable, httpStatus) => {
      const failure = classifyScannerProviderFailure(error);
      expect(failure).toEqual({ kind, retryable, httpStatus });
      expect(JSON.stringify(failure)).not.toContain("private");
    },
  );
});
