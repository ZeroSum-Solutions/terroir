import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NoteList, type HouseNote } from "./note-list";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(notes: HouseNote[]) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<NoteList notes={notes} />); });
  return container;
}

const NOTE: HouseNote = {
  id: "n-1",
  body: "Tight now, should open up by spring.",
  score: 90,
  tastedOn: "2026-09-01",
  createdAt: "2026-09-02T10:00:00Z",
  attributed: true,
  authorName: "Devin",
  descriptors: [{ slug: "oaky", label: "Oaky" }],
};

describe("NoteList", () => {
  it("invites the first note rather than showing an empty box", async () => {
    const el = await render([]);
    expect(el.textContent).toMatch(/first note/i);
  });

  it("shows the note, its author and its score", async () => {
    const el = await render([NOTE]);
    expect(el.textContent).toContain("Tight now, should open up by spring.");
    expect(el.textContent).toContain("Devin");
    expect(el.textContent).toContain("90");
  });

  it("shows the confirmed descriptors on the note", async () => {
    const el = await render([NOTE]);
    expect(el.textContent).toContain("Oaky");
  });

  it("omits the score entirely rather than printing a zero", async () => {
    const el = await render([{ ...NOTE, score: null }]);
    expect(el.textContent).not.toMatch(/\b0\b/);
  });

  it("names a colleague we cannot resolve honestly rather than leaving a blank", async () => {
    const el = await render([{ ...NOTE, authorName: null }]);
    expect(el.textContent).toMatch(/someone here/i);
  });

  it("does not imply a person wrote a note migrated from the cellar record", async () => {
    // A legacy note seeded from wines.tasting_notes had no author. Crediting
    // one -- even vaguely -- puts words in somebody's mouth.
    const el = await render([{ ...NOTE, attributed: false, authorName: null }]);
    expect(el.textContent).toMatch(/from the cellar record/i);
    expect(el.textContent).not.toMatch(/someone here/i);
  });

  it("dates the note from when it was tasted, falling back to when it was written", async () => {
    const el = await render([{ ...NOTE, tastedOn: null }]);
    expect(el.textContent).toMatch(/2 September 2026/);
  });
});
