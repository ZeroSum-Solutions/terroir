import { afterEach, describe, expect, it } from "vitest";
import type { HouseNote } from "@/domains/notes/note-list";
import { cleanup, mount } from "@/test/render";
import { TasteBlock } from "./taste-block";

afterEach(cleanup);

const note = (id: string, authorName: string | null, slugs: string[]): HouseNote => ({
  id,
  body: "",
  score: null,
  tastedOn: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  attributed: authorName !== null,
  authorName,
  descriptors: slugs.map((slug) => ({ slug, label: slug[0].toUpperCase() + slug.slice(1), family: "fruit" })),
});

const STRUCTURE = {
  value: {
    body: { low: "Light", high: "Bold", position: 0.75, label: "Full-bodied" },
    acidity: null,
  },
  basis: { kind: "corpus" as const, name: "X-Wines" },
};

describe("TasteBlock at or above the floor", () => {
  const notes = [note("a", "Devin", ["cherry", "oak"]), note("b", "Sam", ["cherry"]), note("c", null, ["cherry", "leather"])];
  const taste = {
    value: {
      descriptors: [
        { slug: "cherry", label: "Cherry", family: "fruit", notes: 3 },
        { slug: "leather", label: "Leather", family: "earth", notes: 1 },
        { slug: "oak", label: "Oak", family: "oak", notes: 1 },
      ],
      corpusSize: 3,
    },
    basis: { kind: "house" as const, notes: 3 },
  };

  it("renders each descriptor with its mention count and the house basis", async () => {
    const el = await mount(<TasteBlock taste={taste} structure={null} notes={notes} />);
    expect(el.textContent).toMatch(/Cherry\s*3/);
    expect(el.textContent).toMatch(/across 3 house notes/i);
  });

  it("does not attribute chips to individual notes once aggregated", async () => {
    const el = await mount(<TasteBlock taste={taste} structure={null} notes={notes} />);
    expect(el.textContent).not.toContain("Devin");
  });
});

describe("TasteBlock below the floor", () => {
  const notes = [note("a", "Devin", ["cherry", "oak"]), note("b", null, ["cherry"])];
  const taste = {
    value: {
      descriptors: [
        { slug: "cherry", label: "Cherry", family: "fruit", notes: 2 },
        { slug: "oak", label: "Oak", family: "oak", notes: 1 },
      ],
      corpusSize: 2,
    },
    basis: { kind: "house" as const, notes: 2 },
  };

  it("shows per-note chips attributed to their authors, not an aggregate", async () => {
    // Two palates are two palates. "Cherry ×2" from two people is a consensus
    // nobody reached.
    const el = await mount(<TasteBlock taste={taste} structure={null} notes={notes} />);
    expect(el.textContent).toContain("Devin");
    // One chip per mention, none carrying a count: Cherry appears twice, as
    // two people's chips, never once as "Cherry 2".
    const chips = [...el.querySelectorAll("li")].map((li) => li.textContent);
    expect(chips).toEqual(["Cherry", "Oak", "Cherry"]);
    expect(el.textContent).toMatch(/2 notes/i);
  });

  it("names the floor so the reader knows what unlocks the aggregate", async () => {
    const el = await mount(<TasteBlock taste={taste} structure={null} notes={notes} />);
    expect(el.textContent).toMatch(/3/);
  });
});

describe("TasteBlock structure", () => {
  const empty = {
    value: { descriptors: [], corpusSize: 0 },
    basis: { kind: "house" as const, notes: 0 },
  };

  it("draws the corpus's axes under the corpus's own basis", async () => {
    const el = await mount(<TasteBlock taste={empty} structure={STRUCTURE} notes={[]} />);
    expect(el.textContent).toContain("Full-bodied");
    expect(el.textContent).toMatch(/X-Wines reference corpus/);
  });

  it("draws nothing faintly: an unknown axis is absent, not greyed", async () => {
    const el = await mount(<TasteBlock taste={empty} structure={STRUCTURE} notes={[]} />);
    expect(el.textContent).not.toMatch(/acidity/i);
  });

  it("renders nothing when there is neither a note nor a structure", async () => {
    const el = await mount(<TasteBlock taste={empty} structure={null} notes={[]} />);
    expect(el.textContent).toBe("");
  });
});
