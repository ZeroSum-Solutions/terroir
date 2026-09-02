import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("@/lib/ai/anthropic-client", () => ({
  getAnthropicClient: () => ({ messages: { create } }),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const { enrichWineWithClaude, enrichWinesWithClaudeBatch } = await import("./enrich-claude");

const wine = {
  producer: "Austin Hope",
  name: "Cabernet Sauvignon",
  vintage: 2021,
  varietal: "Cabernet Sauvignon",
  region: "Paso Robles",
  country: "United States",
};
const answer = {
  drinkWindowStart: 2024,
  drinkWindowEnd: 2034,
  peakYear: 2028,
  reviewExcerpt: "Dense cassis and mocha.",
  decantMinutes: 60,
};

/**
 * Through OpenRouter, a model with adaptive thinking (Sonnet 5 today; any
 * future re-pin) returns a `thinking` block BEFORE the `text` block. Reading
 * `content[0]` then sees no text and the whole enrichment silently returns
 * null with a Sentry warning — the wine simply never gets a drink window.
 * The text block has to be found by type, wherever it sits.
 */
describe("enrichment reads the text block wherever it sits", () => {
  beforeEach(() => create.mockReset());

  it("single wine: a thinking block ahead of the text block is skipped", async () => {
    create.mockResolvedValue({
      content: [
        { type: "thinking", thinking: "…" },
        { type: "text", text: JSON.stringify(answer) },
      ],
    });
    const result = await enrichWineWithClaude(wine);
    expect(result?.drinkWindowStart).toBe(2024);
    expect(result?.decantMinutes).toBe(60);
  });

  it("batch: a thinking block ahead of the text block is skipped", async () => {
    create.mockResolvedValue({
      content: [
        { type: "thinking", thinking: "…" },
        { type: "text", text: JSON.stringify([answer]) },
      ],
    });
    const result = await enrichWinesWithClaudeBatch([wine]);
    expect(result[0]?.peakYear).toBe(2028);
  });

  it("no text block at all still yields null, not a throw", async () => {
    create.mockResolvedValue({ content: [{ type: "thinking", thinking: "…" }] });
    await expect(enrichWineWithClaude(wine)).resolves.toBeNull();
  });
});
