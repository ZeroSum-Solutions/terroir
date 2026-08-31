import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseRow } from "./test-row";
import { WineDetailIdentity } from "./wine-detail-identity";

/**
 * GLOBAL-04 — what the drawer puts in the 3:4 box, and when.
 *
 * The wines this exists for are the ones a CSV import created: no photograph
 * of their own, no identity link, and therefore nothing in the row the cellar
 * page hands down. Before this they showed producer initials forever.
 */

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

const CORPUS_IMAGE = {
  url: "http://127.0.0.1:57321/storage/v1/object/public/wine-images/xwines/119230.jpeg",
  kind: "producer",
};

function render(row: Parameters<typeof WineDetailIdentity>[0]["row"]) {
  act(() => {
    root.render(
      <WineDetailIdentity
        row={row}
        canManage={false}
        onDeleteImage={() => {}}
        deleteDisabled={false}
      />,
    );
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const img = () => container.querySelector("img");
const initials = () => container.querySelector('span[aria-hidden="true"].font-serif');
const note = () => container.querySelector("p.text-micro")?.textContent ?? null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("WineDetailIdentity", () => {
  it("shows the tenant's own photograph without asking anything of the corpus", async () => {
    render(baseRow({ hero_image_url: "https://example.test/own.jpg" }));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(img()?.getAttribute("src")).toBe("https://example.test/own.jpg");
    expect(note()).toBeNull();
  });

  it("shows the embedded corpus image, captioned, without a second request", async () => {
    render(
      baseRow({
        corpus_image: { url: "https://example.test/corpus.jpg", kind: "representative" },
      }),
    );
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(img()?.getAttribute("src")).toBe("https://example.test/corpus.jpg");
    expect(note()).toBe("Representative bottle — not this wine's label");
  });

  it("holds an empty box while it asks, then shows the bottle it is given", async () => {
    let answer: (value: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );
    render(baseRow({ wine_id: "wine-blank" }));

    // In flight: no picture AND no initials stand-in. The stand-in is a claim
    // that there is no picture, and that claim is not yet true — showing it
    // now means swapping it out a moment later, which is the flash the fixed
    // 3:4 box exists to prevent.
    expect(img()).toBeNull();
    expect(initials()).toBeNull();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();

    answer({
      ok: true,
      json: async () => ({ available: true, profile: { image: CORPUS_IMAGE } }),
    } as unknown as Response);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/wines/wine-blank/profile",
      expect.anything(),
    );
    expect(img()?.getAttribute("src")).toBe(CORPUS_IMAGE.url);
    // The caption is the whole reason a non-exact match may be shown at all.
    expect(note()).toBe("A bottle from this producer — not this cuvée");
    // And the alt text does not name a producer the picture may not show.
    expect(img()?.getAttribute("alt")).toBe(
      "A bottle from this producer — not this cuvée",
    );
  });

  it("falls back to the initials stand-in when the corpus has nothing", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ available: true, profile: null }),
    } as unknown as Response);
    render(baseRow({ wine_id: "wine-blank" }));
    await settle();
    expect(img()).toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(initials()?.textContent).toBe("P");
  });
});
