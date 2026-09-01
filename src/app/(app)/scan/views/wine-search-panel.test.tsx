import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WineSearchPanel } from "./wine-search-panel";
import { mergeRecentSearch } from "@/lib/wine-search-recents";

/**
 * SCAN-09 — "type in any wine, search for it, get the information I want,
 * and be able to add that to my inventory."
 *
 * These prove all four halves of that sentence against the PRE-EXISTING
 * endpoints, because the ticket is that the surface did not exist, not
 * that a backend was missing.
 */

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

async function renderPanel() {
  await act(async () => {
    root.render(<WineSearchPanel />);
  });
}

function searchInput() {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error("search input not rendered");
  return input;
}

function buttonLabelled(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`no button labelled "${label}"`);
  return button;
}

function scopeTab(name: string) {
  const tab = [...container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find(
    (node) => node.textContent === name,
  );
  if (!tab) throw new Error(`no scope tab "${name}"`);
  return tab;
}

async function typeQuery(value: string) {
  const input = searchInput();
  await act(async () => {
    // React 19 tracks the DOM value node, so a plain assignment is ignored
    // by the synthetic change event — set through the prototype descriptor.
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

describe("WineSearchPanel", () => {
  it("searches this cellar and shows the wine's information", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          id: "wine-1",
          name: "Cuvée Fredric",
          producer: "Frédéric Savart",
          vintage: 2018,
          varietal: "Pinot Noir",
          region: "Champagne",
        },
      ]),
    );

    await renderPanel();
    await typeQuery("savart");

    expect(fetchMock).toHaveBeenCalledWith("/api/wines/search?q=savart");
    expect(container.textContent).toContain("Cuvée Fredric");
    expect(container.textContent).toContain("Frédéric Savart · 2018 · Pinot Noir · Champagne");
  });

  it("switches to the LWIN catalogue when the scope tab changes", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await renderPanel();
    await typeQuery("savart");

    await act(async () => scopeTab("Wine catalogue").click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(fetchMock).toHaveBeenLastCalledWith("/api/wines/lwin-search?q=savart");
  });

  it("does not search before the minimum query length", async () => {
    await renderPanel();
    await typeQuery("s");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds a catalogue result to inventory through save-bottle-scan", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/api/wines/lwin-search")) {
        return jsonResponse([
          {
            lwin_id: "1234567",
            display_name: "Savart Bulles de Rosé",
            producer: null,
            varietal: "Pinot Noir",
            region: "Champagne",
            country: "France",
          },
        ]);
      }
      return jsonResponse({ wineId: "wine-9" });
    });

    await renderPanel();
    await act(async () => scopeTab("Wine catalogue").click());
    await typeQuery("savart");

    await act(async () => buttonLabelled("Add Savart Bulles de Rosé to inventory").click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const call = fetchMock.mock.calls.find(([url]) => url === "/api/inventory/save-bottle-scan");
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body)).toEqual({
      wine: {
        name: "Savart Bulles de Rosé",
        // A null catalogue producer becomes "Unknown", never an empty
        // string — save-bottle-scan requires min(1), and a blank producer
        // is exactly what left 1,277 wines unresolvable to the identity
        // spine (AGENTS.md, "two identity systems").
        producer: "Unknown",
        vintage: null,
        varietal: "Pinot Noir",
        region: "Champagne",
        country: "France",
        qty: 1,
        unitCost: 0,
      },
    });
    expect(container.textContent).toContain("Added");
  });

  it("surfaces an add failure instead of silently claiming success", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/api/wines/search")) {
        return jsonResponse([
          {
            id: "wine-1",
            name: "Barolo",
            producer: "Test",
            vintage: null,
            varietal: null,
            region: null,
          },
        ]);
      }
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: { code: "internal_error", message: "nope" } }),
      } as unknown as Response;
    });

    await renderPanel();
    await typeQuery("barolo");
    await act(async () => buttonLabelled("Add Barolo to inventory").click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("nope");
  });
});

describe("mergeRecentSearch", () => {
  it("puts the newest first, de-duplicates case-insensitively, and caps the list", () => {
    let list: string[] = [];
    for (const term of ["a", "b", "c", "d", "e", "f"]) list = mergeRecentSearch(list, term);
    expect(list).toEqual(["f", "e", "d", "c", "b"]);
    expect(mergeRecentSearch(["Savart"], "savart")).toEqual(["savart"]);
    expect(mergeRecentSearch(["Savart"], "   ")).toEqual(["Savart"]);
  });
});
