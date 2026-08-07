// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ metrics: { count: vi.fn(), distribution: vi.fn() } }));
vi.mock("@sentry/nextjs", () => sentry);

const { emitStructuredLog, recordMetric } = await import("./telemetry");

describe("observability telemetry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("redacts secrets and PII from structured logs while keeping safe correlation IDs", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    emitStructuredLog("forced_failure", {
      request_id: "request-123",
      restaurant_id: "restaurant-456",
      email: "owner@example.test",
      token: "raw-token",
      nested: "not-allowed",
    });
    const payload = String(info.mock.calls[0]?.[0]);
    expect(payload).toContain('"request_id":"request-123"');
    expect(payload).toContain('"restaurant_id":"restaurant-456"');
    expect(payload).not.toContain("owner@example.test");
    expect(payload).not.toContain("raw-token");
    expect(payload).toContain("[REDACTED]");
  });

  it("records a distribution for latency and a count for failures", () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    recordMetric("scan_latency_ms", 42, { operation: "scan", status: 200 });
    recordMetric("auth_failures", 1, { outcome: "capability_denied" });
    expect(sentry.metrics.distribution).toHaveBeenCalledWith("scan_latency_ms", 42, expect.any(Object));
    expect(sentry.metrics.count).toHaveBeenCalledWith("auth_failures", 1, expect.any(Object));
  });
});
