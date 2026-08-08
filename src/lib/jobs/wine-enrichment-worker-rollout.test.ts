import { describe, expect, it } from "vitest";
import {
  isWineEnrichmentHandlerEnabled,
  isWineEnrichmentWorkerEnabled,
} from "./wine-enrichment-worker-rollout";

describe("wine-enrichment worker rollout gates", () => {
  it("keeps synchronous requests and the worker handler disabled by default", () => {
    expect(isWineEnrichmentWorkerEnabled({})).toBe(false);
    expect(
      isWineEnrichmentWorkerEnabled({
        WINE_ENRICHMENT_WORKER_ENABLED: "true",
      }),
    ).toBe(false);
    expect(isWineEnrichmentHandlerEnabled({})).toBe(false);
    expect(
      isWineEnrichmentHandlerEnabled({
        WINE_ENRICHMENT_HANDLER_ENABLED: "0",
      }),
    ).toBe(false);
  });

  it("enables each rollout boundary only for its literal opt-in value", () => {
    expect(
      isWineEnrichmentWorkerEnabled({
        WINE_ENRICHMENT_WORKER_ENABLED: "1",
      }),
    ).toBe(true);
    expect(
      isWineEnrichmentHandlerEnabled({
        WINE_ENRICHMENT_HANDLER_ENABLED: "1",
      }),
    ).toBe(true);
  });
});
