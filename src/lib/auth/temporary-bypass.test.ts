import { describe, expect, it } from "vitest";
import { isValidTemporaryBypassToken } from "./temporary-bypass";

describe("isValidTemporaryBypassToken", () => {
  it("accepts only an exact configured capability", () => {
    expect(isValidTemporaryBypassToken("expected-token", "expected-token")).toBe(true);
    expect(isValidTemporaryBypassToken("expected-token", "wrong-token")).toBe(false);
  });

  it("rejects absent and differently sized values", () => {
    expect(isValidTemporaryBypassToken(undefined, "expected-token")).toBe(false);
    expect(isValidTemporaryBypassToken("expected-token", null)).toBe(false);
    expect(isValidTemporaryBypassToken("expected-token", "short")).toBe(false);
  });
});
