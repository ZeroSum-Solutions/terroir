// P1 slice 2a — the unified search palette (program plan D3/D4), the surface
// that replaced the header dropdown (global-search.tsx died at parity in that
// slice; the scan panel followed in slice 2c, which also wired the all-scope
// miss to the companion).
//
// What these tests pin, against the REAL /api/search contract shape:
// one field feeding the unified endpoint; cellar and catalogue visually
// separated with cellar first; provenance badges on catalogue rows; a
// deduped pair rendering once; the "My cellar" scope chip narrowing the
// query; inline add-to-cellar from an LWIN-backed catalogue row; recents
// chips below an empty field; the cellar-scope miss routing to the scanner;
// and the keyboard contract (Esc, arrows, Enter) the old field already had.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onAssistantRequest } from "../assistant-open";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const { SearchPalette } = await import("./search-palette");

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  pushMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const CELLAR_ROW = {
  kind: "cellar",
  provenance: "cellar",
  deduped: false,
  provisional: false,
  score: 1,
  name: "Koonunga Hill",
  producer: "Penfolds",
  vintage: 2019,
  region: "South Australia",
  country: "Australia",
  colour: "Red",
  imageUrl: null,
  isEightysixed: false,
  quantity: 3,
  bin: "A4",
  wineId: "w-1",
  lwinId: null,
  xwinesWineId: null,
};

const LWIN_ROW = {
  kind: "catalogue",
  provenance: "lwin",
  deduped: false,
  provisional: false,
  score: 0.75,
  name: "Château Margaux, Margaux",
  producer: "Château Margaux",
  vintage: null,
  region: "Bordeaux",
  country: "France",
  colour: "Red",
  imageUrl: null,
  isEightysixed: null,
  quantity: null,
  bin: null,
  wineId: null,
  lwinId: "1234567",
  xwinesWineId: null,
};

const PAIR_ROW = {
  ...LWIN_ROW,
  provenance: "lwin+xwines",
  deduped: true,
  xwinesWineId: 101,
};

const XWINES_ROW = {
  kind: "catalogue",
  provenance: "xwines",
  deduped: false,
  provisional: false,
  score: 0.7,
  name: "Community Cuvee",
  producer: "Crowd Estate",
  vintage: null,
  region: null,
  country: "Italy",
  colour: "Red",
  imageUrl: null,
  isEightysixed: null,
  quantity: null,
  bin: null,
  wineId: null,
  lwinId: null,
  xwinesWineId: 202,
};

async function renderPalette() {
  await act(async () => {
    root.render(<SearchPalette />);
  });
}

function searchInput() {
  const input = document.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error("search input not rendered");
  return input;
}

async function typeQuery(value: string) {
  const input = searchInput();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

async function pressKey(key: string) {
  await act(async () => {
    searchInput().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

function panelText(): string {
  return document.body.textContent ?? "";
}

describe("SearchPalette", () => {
  it("queries the unified endpoint and separates cellar from catalogue, cellar first", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [CELLAR_ROW, LWIN_ROW] }));
    await renderPalette();
    await typeQuery("margaux");

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/search?");
    expect(url).toContain("q=margaux");
    expect(url).not.toContain("scope=cellar");

    const headings = [...document.querySelectorAll("[data-palette-section]")].map(
      (el) => el.getAttribute("data-palette-section"),
    );
    expect(headings).toEqual(["cellar", "catalogue"]);
  });

  it("shows a provenance badge on catalogue rows and renders a deduped pair once", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [PAIR_ROW] }));
    await renderPalette();
    await typeQuery("margaux");

    const options = document.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(1);
    expect(panelText()).toContain("LWIN · X-Wines");
  });

  it("narrows to the cellar when the scope chip is pressed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [CELLAR_ROW] }));
    await renderPalette();
    await typeQuery("koonunga");

    const chip = document.querySelector<HTMLButtonElement>('button[aria-pressed]');
    if (!chip) throw new Error("scope chip not rendered");
    await act(async () => {
      chip.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    const lastUrl = String(fetchMock.mock.calls.at(-1)![0]);
    expect(lastUrl).toContain("scope=cellar");
  });

  it("adds an LWIN-backed catalogue wine inline and reports Added", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/search")) return jsonResponse({ results: [LWIN_ROW] });
      if (url.includes("/api/wines/create-from-lwin")) {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        expect(body.lwin_id).toBe("1234567");
        return jsonResponse({ id: "new-wine" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    await renderPalette();
    await typeQuery("margaux");

    const add = document.querySelector<HTMLButtonElement>('button[data-palette-add]');
    if (!add) throw new Error("add button not rendered");
    await act(async () => {
      add.click();
    });
    expect(panelText()).toContain("Added");
  });

  it("renders an X-Wines-only row with its badge but no add action", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [XWINES_ROW] }));
    await renderPalette();
    await typeQuery("community");

    expect(panelText()).toContain("X-Wines");
    expect(document.querySelector('button[data-palette-add]')).toBeNull();
  });

  it("titles a catalogue row with its producer — twenty 'Margaux' rows are useless without the château", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [XWINES_ROW] }));
    await renderPalette();
    await typeQuery("community");
    expect(panelText()).toContain("Crowd Estate Community Cuvee");
  });

  it("does not repeat the producer when the catalogue name already carries it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ results: [{ ...LWIN_ROW, name: "Château Margaux, Margaux" }] }),
    );
    await renderPalette();
    await typeQuery("margaux");
    expect(panelText()).not.toContain("Château Margaux Château Margaux");
  });

  it("shows bottles on hand and the bin on a cellar row — slice 2b", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [CELLAR_ROW] }));
    await renderPalette();
    await typeQuery("koonunga");
    expect(panelText()).toContain("3 btl · A4");
  });

  it("stays silent about stock when availability degraded to unknown", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ results: [{ ...CELLAR_ROW, quantity: null, bin: null }] }),
    );
    await renderPalette();
    await typeQuery("koonunga");
    expect(panelText()).not.toContain("btl");
  });

  it("opens the catalogue detail page for an LWIN-backed row instead of add-on-click", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [LWIN_ROW] }));
    await renderPalette();
    await typeQuery("margaux");
    const row = document.querySelector<HTMLButtonElement>('[role="option"] button');
    if (!row) throw new Error("result row not rendered");
    await act(async () => {
      row.click();
    });
    expect(pushMock).toHaveBeenCalledWith("/catalogue/lwin/1234567");
    // Navigation, not a silent add: no create call was made.
    const posts = fetchMock.mock.calls.filter((c) => String(c[0]).includes("create-from-lwin"));
    expect(posts).toHaveLength(0);
  });

  it("opens the catalogue detail page for an X-Wines-only row — no more dead end", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [XWINES_ROW] }));
    await renderPalette();
    await typeQuery("community");
    const row = document.querySelector<HTMLButtonElement>('[role="option"] button');
    if (!row) throw new Error("result row not rendered");
    await act(async () => {
      row.click();
    });
    expect(pushMock).toHaveBeenCalledWith("/catalogue/xwines/202");
  });

  it("marks an 86'd cellar row so it never looks pullable", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ results: [{ ...CELLAR_ROW, isEightysixed: true }] }),
    );
    await renderPalette();
    await typeQuery("koonunga");
    expect(panelText()).toContain("86'd");
  });

  it("offers the scanner on a cellar-scope miss", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));
    await renderPalette();
    await typeQuery("nonexistent");
    const chip = document.querySelector<HTMLButtonElement>('button[aria-pressed]');
    await act(async () => {
      chip!.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    const cta = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Scan a label"),
    );
    if (!cta) throw new Error("scanner CTA not rendered");
    await act(async () => {
      cta.click();
    });
    expect(pushMock).toHaveBeenCalledWith("/scan");
  });

  it("shows recent searches under the empty field and re-runs one on click", async () => {
    window.localStorage.setItem(
      "terroir.scan.recentSearches",
      JSON.stringify(["margaux"]),
    );
    fetchMock.mockResolvedValue(jsonResponse({ results: [LWIN_ROW] }));
    await renderPalette();
    await act(async () => {
      searchInput().focus();
    });

    const chip = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "margaux",
    );
    if (!chip) throw new Error("recent chip not rendered");
    await act(async () => {
      chip.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("q=margaux");
  });

  it("records a committed search as a recent", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [CELLAR_ROW] }));
    await renderPalette();
    await typeQuery("koonunga");
    const row = document.querySelector<HTMLButtonElement>('[role="option"] button');
    if (!row) throw new Error("result row not rendered");
    await act(async () => {
      row.click();
    });
    expect(pushMock).toHaveBeenCalledWith("/cellar/w-1");
    const stored = JSON.parse(window.localStorage.getItem("terroir.scan.recentSearches") ?? "[]");
    expect(stored).toContain("koonunga");
  });

  it("keeps the keyboard contract: arrows move, Enter opens, Esc clears", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [CELLAR_ROW, LWIN_ROW] }));
    await renderPalette();
    await typeQuery("margaux");

    await pressKey("ArrowDown");
    await pressKey("Enter");
    expect(pushMock).toHaveBeenCalledWith("/cellar/w-1");

    await pressKey("Escape");
    expect(searchInput().value).toBe("");
  });

  it("does not query below two characters — parity with the old field", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));
    await renderPalette();
    await typeQuery("m");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands a failed request the same empty state instead of a broken panel", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await renderPalette();
    await typeQuery("margaux");
    expect(panelText()).toContain("Nothing matched");
  });

  it("offers the companion on an all-scope miss and hands it the query", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));
    const seen: Array<string | null> = [];
    const unsubscribe = onAssistantRequest((question) => seen.push(question));
    try {
      await renderPalette();
      await typeQuery("volcanic white for oysters");

      const cta = [...document.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes("Ask the companion"),
      );
      if (!cta) throw new Error("companion CTA not rendered");
      await act(async () => {
        cta.click();
      });

      expect(seen).toEqual(["volcanic white for oysters"]);
      expect(document.querySelector("[data-global-search-panel]")).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  it("offers the companion above loose results when the query carries a price or a pairing", async () => {
    // The defect this closes (route.ts header, 2026-08-31): "something under
    // $40 for fish" used to come back as loose trigram matches with no route
    // to the companion at all, because the miss CTA only ever fires when
    // `results` is empty — this one is not.
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [XWINES_ROW],
        companion: { suggested: true, reasons: ["price", "pairing"] },
      }),
    );
    const seen: Array<string | null> = [];
    const unsubscribe = onAssistantRequest((question) => seen.push(question));
    try {
      await renderPalette();
      await typeQuery("something under $40 for fish");

      expect(panelText()).toContain("Price and food pairing are questions for the companion.");
      // Results still render beneath the banner — the loose match is not hidden.
      expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);

      const cta = [...document.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes("Ask the companion"),
      );
      if (!cta) throw new Error("companion banner CTA not rendered");
      await act(async () => {
        cta.click();
      });
      expect(seen).toEqual(["something under $40 for fish"]);
    } finally {
      unsubscribe();
    }
  });

  it("does not offer the companion banner when the search answered with real facts", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [XWINES_ROW],
        companion: { suggested: false, reasons: [] },
      }),
    );
    await renderPalette();
    await typeQuery("community");

    expect(panelText()).not.toContain("questions for the companion");
    expect([...document.querySelectorAll("button")].some((b) =>
      (b.textContent ?? "").includes("Ask the companion"),
    )).toBe(false);
  });

  it("leaves the all-scope-miss empty state as-is when a mocked response omits companion", async () => {
    // Regression guard: a response with no `companion` field (as every other
    // test in this file mocks) must not crash the panel or the miss CTA.
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));
    await renderPalette();
    await typeQuery("nonexistent volcanic thing");

    const cta = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Ask the companion"),
    );
    expect(cta).toBeDefined();
  });
});
