import { describe, expect, it, vi } from "vitest";
import { suggestDescriptors } from "./descriptor-extraction";

const VOCAB = [
  { slug: "oaky", label: "Oaky" },
  { slug: "toasty", label: "Toasty" },
  { slug: "black-fruit", label: "Black fruit" },
  { slug: "mineral", label: "Mineral" },
];

describe("suggestDescriptors", () => {
  it("returns the slugs the model recognised", async () => {
    const complete = vi.fn().mockResolvedValue('["oaky","toasty"]');
    expect(await suggestDescriptors("Lovely toasty oak", VOCAB, { complete }))
      .toEqual(["oaky", "toasty"]);
  });

  it("drops a slug the model invented", async () => {
    // A model asked for slugs will occasionally return one that is not in the
    // vocabulary. Unfiltered, it violates the foreign key at write time --
    // after the note row already exists.
    const complete = vi.fn().mockResolvedValue('["oaky","barnyard","invented-slug"]');
    expect(await suggestDescriptors("Toasty oak", VOCAB, { complete }))
      .toEqual(["oaky"]);
  });

  it("returns an empty array rather than throwing when the model is unavailable", async () => {
    // A suggestion is a convenience. If it fails, the composer must still be
    // able to save the note -- an extraction outage must never block a
    // sommelier from writing one down.
    const complete = vi.fn().mockRejectedValue(new Error("upstream down"));
    expect(await suggestDescriptors("anything", VOCAB, { complete })).toEqual([]);
  });

  it("survives a model that answers with prose instead of JSON", async () => {
    const complete = vi.fn().mockResolvedValue("Sure! Here are the descriptors: oaky, toasty.");
    expect(await suggestDescriptors("Toasty oak", VOCAB, { complete })).toEqual([]);
  });

  it("tolerates the model wrapping its JSON in a markdown fence", async () => {
    const complete = vi.fn().mockResolvedValue('```json\n["mineral"]\n```');
    expect(await suggestDescriptors("Flinty", VOCAB, { complete })).toEqual(["mineral"]);
  });

  it("deduplicates a slug the model repeated", async () => {
    const complete = vi.fn().mockResolvedValue('["oaky","oaky"]');
    expect(await suggestDescriptors("Oak everywhere", VOCAB, { complete })).toEqual(["oaky"]);
  });

  it("does not call the model at all for a blank note", async () => {
    const complete = vi.fn();
    expect(await suggestDescriptors("   ", VOCAB, { complete })).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not call the model when the vocabulary is empty", async () => {
    const complete = vi.fn();
    expect(await suggestDescriptors("Toasty oak", [], { complete })).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("sends the vocabulary to the model, so it cannot answer off-list by accident", async () => {
    const complete = vi.fn().mockResolvedValue("[]");
    await suggestDescriptors("Toasty oak", VOCAB, { complete });
    const prompt = complete.mock.calls[0][0] as string;
    for (const term of VOCAB) expect(prompt).toContain(term.slug);
  });

  it("caps how much prose it sends", async () => {
    const complete = vi.fn().mockResolvedValue("[]");
    await suggestDescriptors("x".repeat(10_000), VOCAB, { complete });
    const prompt = complete.mock.calls[0][0] as string;
    expect(prompt.length).toBeLessThan(6_000);
  });
});
