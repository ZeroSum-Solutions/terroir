import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const ORIGINAL_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_DSN === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  else process.env.NEXT_PUBLIC_SENTRY_DSN = ORIGINAL_DSN;
});

function request(body = "envelope"): Request {
  return new Request("https://terroir.example/monitoring", {
    body,
    headers: { "Content-Type": "application/x-sentry-envelope" },
    method: "POST",
  });
}

describe("POST /monitoring", () => {
  it("forwards envelopes only to the configured Sentry project", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN =
      "https://public-key@o123.ingest.us.sentry.io/456";
    const upstream = vi.fn().mockResolvedValue(
      new Response("ok", {
        headers: { "Content-Type": "text/plain" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect(String(upstream.mock.calls[0]?.[0])).toBe(
      "https://o123.ingest.us.sentry.io/api/456/envelope/",
    );
  });

  it("rejects a non-Sentry DSN without making a request", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://key@example.com/456";
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects an oversized envelope before forwarding it", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN =
      "https://public-key@o123.ingest.sentry.io/456";
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await POST(request("x".repeat(1_000_001)));

    expect(response.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns a bounded error when Sentry is unavailable", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN =
      "https://public-key@o123.ingest.sentry.io/456";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Monitoring delivery failed." });
  });
});
