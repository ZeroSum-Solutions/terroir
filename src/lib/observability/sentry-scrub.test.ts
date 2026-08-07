import { describe, expect, it } from "vitest";
import { scrubSentryEvent } from "./sentry-scrub";

describe("scrubSentryEvent", () => {
  it("removes request and user payloads and redacts sensitive extras", () => {
    const output = scrubSentryEvent({
      message: "database probe failed: owner@example.test",
      exception: { values: [{ type: "DatabaseError", value: "service key leaked" }] },
      request: { headers: { authorization: "Bearer secret" }, data: "invoice text" },
      user: { email: "owner@example.test" },
      extra: { restaurant_id: "restaurant-123", api_key: "secret", note: "safe" },
    });
    expect(output).toEqual({
      exception: { values: [{ type: "DatabaseError" }] },
      extra: { restaurant_id: "restaurant-123", api_key: "[REDACTED]", note: "safe" },
    });
  });
});
