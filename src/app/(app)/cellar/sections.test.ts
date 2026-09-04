import { describe, expect, it } from "vitest";
import { normalizeSections } from "./sections";

describe("normalizeSections", () => {
  it("keeps legacy names while assigning stable unique ids", () => {
    expect(normalizeSections(["Reds", "Reds", "Reds"])).toEqual([
      { id: "Reds", name: "Reds" },
      { id: "Reds-2", name: "Reds" },
      { id: "Reds-3", name: "Reds" },
    ]);
  });

  it("avoids suffix collisions with ids already in the list", () => {
    expect(normalizeSections(["Reds", "Reds", "Reds-2"])).toEqual([
      { id: "Reds", name: "Reds" },
      { id: "Reds-2", name: "Reds" },
      { id: "Reds-2-2", name: "Reds-2" },
    ]);
  });

  it("preserves already-unique section objects", () => {
    const sections = [
      { id: "section-reds", name: "Reds" },
      { id: "section-whites", name: "Whites" },
    ];

    expect(normalizeSections(sections)).toEqual(sections);
  });
});
