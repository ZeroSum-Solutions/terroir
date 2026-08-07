import { describe, expect, it } from "vitest";
import { isPdfWorkerEnabled } from "./pdf-worker-rollout";

describe("PDF worker rollback flag", () => {
  it("defaults to the synchronous path", () => {
    expect(isPdfWorkerEnabled({})).toBe(false);
    expect(isPdfWorkerEnabled({ PDF_WORKER_ENABLED: "true" })).toBe(false);
    expect(isPdfWorkerEnabled({ PDF_WORKER_ENABLED: "0" })).toBe(false);
  });

  it("enables enqueueing only for the literal rollout value", () => {
    expect(isPdfWorkerEnabled({ PDF_WORKER_ENABLED: "1" })).toBe(true);
  });
});
