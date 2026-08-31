import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCorpusImage, type CorpusImageState } from "./use-corpus-image";

/**
 * GLOBAL-04 — the drawer's last resort for a wine with no picture anywhere in
 * the page's own data. What this suite is really guarding is the cost: the
 * cellar list renders thousands of rows, and a hook that asks per row instead
 * of per opened wine is a thousand round trips for one drawer.
 */

const IMAGE = {
  url: "http://127.0.0.1:57321/storage/v1/object/public/wine-images/xwines/119230.jpeg",
  kind: "producer",
};

let container: HTMLDivElement;
let root: Root;
let states: CorpusImageState[];
let fetchMock: ReturnType<typeof vi.fn>;

function Harness({ wineId, hasImage }: { wineId: string | null; hasImage: boolean }) {
  states.push(useCorpusImage({ wineId, hasImage }));
  return null;
}

function render(props: { wineId: string | null; hasImage: boolean }) {
  act(() => {
    root.render(<Harness {...props} />);
  });
}

/** Lets the hook's own async body run to completion. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  states = [];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("useCorpusImage", () => {
  it("asks for nothing when the row already has a picture", async () => {
    render({ wineId: "wine-1", hasImage: true });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ status: "idle" });
  });

  it("asks for nothing when no wine is open", async () => {
    render({ wineId: null, hasImage: false });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ status: "idle" });
  });

  it("fetches the one open wine's profile and reports the picture", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ profile: { image: IMAGE } }));
    render({ wineId: "wine-1", hasImage: false });
    // "loading" from the very first render, with no "idle" ahead of it: the
    // drawer holds the box empty rather than flashing the initials stand-in
    // and then swapping a bottle in behind it.
    expect(states[0]).toEqual({ status: "loading" });
    await settle();
    expect(states.map((state) => state.status)).toEqual(["loading", "done"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/wines/wine-1/profile");
    expect(states.at(-1)).toEqual({ status: "done", image: IMAGE });
  });

  it("treats no corpus entry as an answer, not an error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ available: true, profile: null }));
    render({ wineId: "wine-1", hasImage: false });
    await settle();
    expect(states.at(-1)).toEqual({ status: "done", image: null });
  });

  it("falls back to the initials stand-in when the request fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render({ wineId: "wine-1", hasImage: false });
    await settle();
    expect(states.at(-1)).toEqual({ status: "done", image: null });
  });

  it("drops a picture whose kind it cannot caption", async () => {
    // An unrecognised kind cannot be captioned, and an uncaptioned corpus
    // picture asserts a label this code has no evidence for.
    fetchMock.mockResolvedValue(
      jsonResponse({ profile: { image: { url: IMAGE.url, kind: "hero" } } }),
    );
    render({ wineId: "wine-1", hasImage: false });
    await settle();
    expect(states.at(-1)).toEqual({ status: "done", image: null });
  });

  it("abandons the previous wine's answer when the drawer moves on", async () => {
    // The drawer stays mounted between wines. Without the abort, a slow answer
    // for the first wine can land after the second's and put the wrong bottle
    // on screen under the right name.
    let resolveFirst: (value: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (resolveFirst = resolve)),
    );
    render({ wineId: "wine-1", hasImage: false });

    fetchMock.mockResolvedValueOnce(jsonResponse({ profile: { image: IMAGE } }));
    render({ wineId: "wine-2", hasImage: false });
    await settle();
    expect(states.at(-1)).toEqual({ status: "done", image: IMAGE });

    const stale = { url: "http://example.test/stale.jpg", kind: "label" };
    resolveFirst(jsonResponse({ profile: { image: stale } }));
    await settle();
    expect(states.at(-1)).toEqual({ status: "done", image: IMAGE });
  });
});
