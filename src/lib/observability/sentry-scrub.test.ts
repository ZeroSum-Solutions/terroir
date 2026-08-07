import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scrubSentryEvent } from "./sentry-scrub";

describe("scrubSentryEvent", () => {
  it("removes request and user payloads and redacts sensitive extras", () => {
    const output = scrubSentryEvent({
      message: "database probe failed: owner@example.test",
      exception: { values: [{ type: "DatabaseError", value: "service key leaked" }] },
      request: { headers: { authorization: "Bearer secret" }, data: "invoice text" },
      user: { email: "owner@example.test" },
      breadcrumbs: [{ message: "invoice INV-123 belongs to owner@example.test" }],
      contexts: { trace: { data: "raw invoice content" } },
      extra: {
        restaurant_id: "restaurant-123",
        api_key: "secret",
        note: "customer free text",
        raw_ocr_text: "Chateau Example",
      },
    });
    expect(output).toEqual({
      exception: { values: [{ type: "DatabaseError" }] },
      extra: {
        restaurant_id: "restaurant-123",
        api_key: "[REDACTED]",
        note: "[REDACTED]",
        raw_ocr_text: "[REDACTED]",
      },
    });
  });

  it("keeps browser replay globally masked and blocks scanner media", () => {
    const source = readFileSync("instrumentation-client.ts", "utf8");
    expect(source).toContain("maskAllText: true");
    expect(source).toContain("maskAllInputs: true");
    expect(source).toContain("blockAllMedia: true");
    expect(source).toContain("networkCaptureBodies: false");
  });
});
