import { describe, it, expect } from "vitest";
import { safeNext } from "./safe-redirect";

describe("safeNext", () => {
  const FALLBACK = "/";

  it("accepts a plain relative path", () => {
    expect(safeNext("/insights", FALLBACK)).toBe("/insights");
    expect(safeNext("/lists/42", FALLBACK)).toBe("/lists/42");
  });

  it("accepts a relative path with query and hash", () => {
    expect(safeNext("/scan?tab=invoice#top", FALLBACK)).toBe(
      "/scan?tab=invoice#top",
    );
  });

  it("rejects a protocol-relative URL (//evil.com)", () => {
    // This is the actual attack INT-012 pointed at: Next.js would redirect
    // to https://our-host//evil.example.com/x, which the browser treats as
    // https://evil.example.com/x.
    expect(safeNext("//evil.example.com/x", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects encoded protocol-relative and backslash separator tricks", () => {
    expect(safeNext("/%2f%2fevil.example.com", FALLBACK)).toBe(FALLBACK);
    expect(safeNext("/%5cevil.example.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects malformed percent encoding and control characters", () => {
    expect(safeNext("/%E0%A4%A", FALLBACK)).toBe(FALLBACK);
    expect(safeNext("/cellar\nLocation: https://evil.example", FALLBACK)).toBe(
      FALLBACK,
    );
  });

  it("rejects an absolute same-origin URL (we don't try to allowlist hosts)", () => {
    // We deliberately don't try to do per-env host matching — relative paths
    // only, full stop.
    expect(safeNext("https://example.com/ok", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects an absolute different-origin URL", () => {
    expect(safeNext("https://evil.example.com/phish", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects empty, null, and undefined", () => {
    expect(safeNext("", FALLBACK)).toBe(FALLBACK);
    expect(safeNext(null, FALLBACK)).toBe(FALLBACK);
    expect(safeNext(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it("rejects dangerous schemes", () => {
    expect(safeNext("data:text/html,<script>alert(1)</script>", FALLBACK)).toBe(
      FALLBACK,
    );
    expect(safeNext("javascript:alert(1)", FALLBACK)).toBe(FALLBACK);
    expect(safeNext("mailto:attacker@example.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects backslash-injection tricks", () => {
    // Some parsers normalise backslashes to slashes — reject to be safe.
    expect(safeNext("/\\evil.com", FALLBACK)).toBe(FALLBACK);
    expect(safeNext("\\\\evil.com/x", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a bare path that does not start with /", () => {
    expect(safeNext("scan", FALLBACK)).toBe(FALLBACK);
    expect(safeNext("./scan", FALLBACK)).toBe(FALLBACK);
  });
});
