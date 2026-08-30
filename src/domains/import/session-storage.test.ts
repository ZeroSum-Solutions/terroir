// Per-browser resume storage. Extracted from session-step.tsx, where it
// could only be reached through the component's mount effect.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStoredSession, writeStoredSession } from "./session-storage";

const KEY = "terroir-import-session-v1";

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("writeStoredSession / readStoredSession", () => {
  it("round-trips a stored session", () => {
    writeStoredSession({ sessionId: "s1", sourceSha256: "a".repeat(64), label: "cellar.csv" });
    expect(readStoredSession()).toEqual({ sessionId: "s1", sourceSha256: "a".repeat(64), label: "cellar.csv" });
  });

  it("clears the entry when written null", () => {
    writeStoredSession({ sessionId: "s1", sourceSha256: "b", label: "x.csv" });
    writeStoredSession(null);
    expect(readStoredSession()).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    expect(readStoredSession()).toBeNull();
  });

  it("refuses a stored value with no sessionId rather than returning a half-built session", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ label: "cellar.csv" }));
    expect(readStoredSession()).toBeNull();
  });

  it("defaults a missing sourceSha256/label rather than propagating undefined", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ sessionId: "s1" }));
    expect(readStoredSession()).toEqual({ sessionId: "s1", sourceSha256: "", label: "cellar.csv" });
  });

  it("returns null instead of throwing on unparseable storage", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(readStoredSession()).toBeNull();
  });

  it("never throws when storage itself is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(() => writeStoredSession({ sessionId: "s1", sourceSha256: "c", label: "y.csv" })).not.toThrow();
    spy.mockRestore();
  });
});
