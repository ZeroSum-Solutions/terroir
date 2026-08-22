import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M1-1 — unit coverage for the `withScanSpan` defensive wrapper itself,
 * independent of the invoice-scan-service call sites exercised in
 * `invoice-scan-service.telemetry.test.ts`.
 */

const sentryMock = vi.hoisted(() => ({ startSpan: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  get startSpan() {
    return sentryMock.startSpan;
  },
}));

const { withScanSpan } = await import("./scan-telemetry");

beforeEach(() => {
  sentryMock.startSpan = vi.fn();
});

describe("withScanSpan", () => {
  it("runs fn inside the span and returns its resolved value", async () => {
    sentryMock.startSpan.mockImplementation((_options, callback) => callback());

    const fn = vi.fn().mockResolvedValue("ocr-result");
    const result = await withScanSpan("ocr.page", { pageIndex: 0 }, fn);

    expect(result).toBe("ocr-result");
    expect(fn).toHaveBeenCalledOnce();
    expect(sentryMock.startSpan).toHaveBeenCalledWith(
      expect.objectContaining({ name: "scan.ocr.page", op: "scan", attributes: { pageIndex: 0 } }),
      expect.any(Function),
    );
  });

  it("propagates fn's own rejection unchanged, without retrying fn", async () => {
    sentryMock.startSpan.mockImplementation((_options, callback) => callback());

    const stageError = new Error("upstream OCR failure");
    const fn = vi.fn().mockRejectedValue(stageError);

    await expect(withScanSpan("ocr.page", {}, fn)).rejects.toBe(stageError);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("falls back to running fn unwrapped when Sentry.startSpan is not a function", async () => {
    // @ts-expect-error — simulating a test double / SDK mismatch, not a real value.
    sentryMock.startSpan = undefined;

    const fn = vi.fn().mockResolvedValue("fallback-result");
    const result = await withScanSpan("extract", { attempt: 1 }, fn);

    expect(result).toBe("fallback-result");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("falls back to running fn unwrapped when Sentry.startSpan throws before invoking the callback", async () => {
    sentryMock.startSpan.mockImplementation(() => {
      throw new Error("Sentry span scaffolding is broken");
    });

    const fn = vi.fn().mockResolvedValue("recovered-result");
    const result = await withScanSpan("persist", {}, fn);

    expect(result).toBe("recovered-result");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("returns fn's successful value even when Sentry's own span bookkeeping throws after the callback completes", async () => {
    // Simulates a Sentry outage/transport error surfacing from span.end()
    // (or other post-callback bookkeeping) *after* fn already succeeded.
    // The stage's real result must win — discarding it here would turn a
    // completed scan.persist write into a reported scan failure.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let started = 0;
    sentryMock.startSpan.mockImplementation(async (_options, callback) => {
      const value = await callback();
      void value;
      throw new Error("span.end() blew up");
    });

    const fn = vi.fn().mockImplementation(async () => {
      started += 1;
      return "value";
    });

    const result = await withScanSpan("persist", {}, fn);

    expect(result).toBe("value");
    expect(started).toBe(1);
    expect(fn).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("propagates fn's own rejection exactly, even if Sentry's wrapper rethrows a different error object on the way out", async () => {
    // Simulates Sentry's real startSpan behavior of catching the callback's
    // rejection, marking the span's error status, then rethrowing — but
    // with a distinct error object, to prove the wrapper replays fn's own
    // captured outcome rather than whatever Sentry rethrows.
    const stageError = new Error("upstream OCR failure");
    let started = 0;
    sentryMock.startSpan.mockImplementation(async (_options, callback) => {
      try {
        return await callback();
      } catch {
        throw new Error("Sentry-wrapped: span ended with error status");
      }
    });

    const fn = vi.fn().mockImplementation(async () => {
      started += 1;
      throw stageError;
    });

    await expect(withScanSpan("ocr.page", {}, fn)).rejects.toBe(stageError);
    expect(started).toBe(1);
    expect(fn).toHaveBeenCalledOnce();
  });
});
