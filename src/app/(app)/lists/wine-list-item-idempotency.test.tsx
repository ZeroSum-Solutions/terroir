// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { WineList } from "@/lib/wine-list/types";
import type {
  WineListEditorItem,
  WineListEditorSection,
} from "./[id]/wine-list-editor";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockRefresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: mockRefresh,
  }),
}));

vi.mock("qrcode", () => ({
  toString: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg" />'),
  toDataURL: vi.fn(async () => "data:image/png;base64,AA=="),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const {
  WineListEditor,
  restoreWineItemOrderAfterFailedReorder,
  restoreWineSectionOrderAfterFailedReorder,
} = await import("./[id]/wine-list-editor");

const LIST_ID = "11111111-1111-4111-8111-111111111111";
const SECTION_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_SECTION_ID = "33333333-3333-4333-8333-333333333333";
const ITEM_ID = "44444444-4444-4444-8444-444444444444";
const WINE_ID = "55555555-5555-4555-8555-555555555555";

function list(): Omit<WineList, "wine_list_sections"> {
  return {
    archived: false,
    created_at: "2026-07-24T00:00:00.000Z",
    description: null,
    id: LIST_ID,
    is_published: false,
    last_published_at: null,
    name: "Dinner",
    restaurant_id: "66666666-6666-4666-8666-666666666666",
    slug: null,
    template: "classic",
    updated_at: "2026-07-24T00:00:00.000Z",
  };
}

function item(
  overrides: Partial<WineListEditorItem> = {},
): WineListEditorItem {
  return {
    id: ITEM_ID,
    section_id: SECTION_ID,
    wine_id: WINE_ID,
    position: 0,
    glass_price: 14,
    bottle_price: 48,
    glass_pour_ml: 148,
    pour_size_mode: "fixed",
    tasting_note: null,
    name_override: null,
    blurb: null,
    hidden: false,
    wines: {
      id: WINE_ID,
      name: "Pinot Noir",
      producer: "Maison Test",
      vintage: 2022,
      varietal: "Pinot Noir",
      region: "Willamette Valley",
    },
    ...overrides,
  };
}

function sections(
  firstItems: WineListEditorItem[] = [],
): WineListEditorSection[] {
  return [
    {
      id: SECTION_ID,
      name: "By the Glass",
      position: 0,
      wine_list_id: LIST_ID,
      wine_list_items: firstItems,
    },
    {
      id: SECOND_SECTION_ID,
      name: "Reds",
      position: 1,
      wine_list_id: LIST_ID,
      wine_list_items: [],
    },
  ];
}

function button(container: HTMLElement, text: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Button ${text} not found`);
  return match as HTMLButtonElement;
}

function buttonContaining(container: HTMLElement, text: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(text),
  );
  if (!match) throw new Error(`Button containing ${text} not found`);
  return match as HTMLButtonElement;
}

function keyAt(index: number) {
  const init = mockFetch.mock.calls[index]?.[1] as RequestInit;
  return new Headers(init.headers).get("Idempotency-Key");
}

function mutationCalls(method: string) {
  return mockFetch.mock.calls.filter(([, init]) => init?.method === method);
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("wine-list item idempotency callers", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.clear();
  });

  it("rolls a failed section reorder back without resurrecting deleted sections or stale names", () => {
    const previous = sections();
    const retained = {
      ...previous[1],
      position: 0,
      name: "Cellar Reds",
    };
    const added: WineListEditorSection = {
      id: "77777777-7777-4777-8777-777777777777",
      name: "Dessert",
      position: 1,
      wine_list_id: LIST_ID,
      wine_list_items: [],
    };

    const restored = restoreWineSectionOrderAfterFailedReorder(
      [retained, added],
      previous,
    );

    expect(restored.map(({ id }) => id)).toEqual([
      SECOND_SECTION_ID,
      added.id,
    ]);
    expect(restored[0].name).toBe("Cellar Reds");
    expect(restored.map(({ position }) => position)).toEqual([0, 1]);
  });

  it("guards section creation and retries an ambiguous outcome with the persisted key", async () => {
    const first = deferredResponse();
    Object.defineProperty(window, "prompt", {
      value: vi.fn(() => "Dessert"),
      configurable: true,
    });
    mockFetch
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(
        Response.json({
          id: "77777777-7777-4777-8777-777777777777",
          wine_list_id: LIST_ID,
          name: "Dessert",
          position: 2,
          created_at: "2026-07-24T00:00:00.000Z",
        }),
      );
    await act(async () => {
      root.render(<WineListEditor list={list()} sections={sections()} />);
    });

    await act(async () => {
      button(container, "Add section").click();
      button(container, "Add section").click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(mutationCalls("POST")).toHaveLength(1),
    );
    const originalKey = keyAt(0);

    await act(async () => {
      first.resolve(
        Response.json(
          {
            error: {
              code: "idempotency_outcome_unknown",
              message: "The previous outcome is unknown.",
            },
          },
          { status: 409 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "previous outcome is unknown",
      ),
    );

    await act(async () => {
      button(container, "Add section").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(mutationCalls("POST")).toHaveLength(2),
    );
    expect(keyAt(1)).toBe(originalKey);
    expect(sessionStorage.length).toBe(0);
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("keeps a section retryable after ambiguous deletion and reuses the persisted key", async () => {
    const first = deferredResponse();
    mockFetch
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await act(async () => {
      root.render(<WineListEditor list={list()} sections={sections()} />);
    });

    await act(async () => {
      (
        container.querySelector(
          'button[aria-label="Delete By the Glass"]',
        ) as HTMLButtonElement
      ).click();
    });
    const confirm = button(container, "Delete section");
    await act(async () => {
      confirm.click();
      confirm.click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(mutationCalls("DELETE")).toHaveLength(1),
    );
    const originalKey = keyAt(0);

    await act(async () => {
      first.resolve(
        Response.json(
          {
            error: {
              code: "idempotency_outcome_unknown",
              message: "The previous outcome is unknown.",
            },
          },
          { status: 409 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "previous outcome is unknown",
      ),
    );
    expect(
      container.querySelector(
        'button[aria-label="Delete By the Glass"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      (
        container.querySelector(
          'button[aria-label="Delete By the Glass"]',
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      button(container, "Delete section").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(mutationCalls("DELETE")).toHaveLength(2),
    );
    expect(keyAt(1)).toBe(originalKey);
    await vi.waitFor(() =>
      expect(
        container.querySelector(
          'button[aria-label="Delete By the Glass"]',
        ),
      ).toBeNull(),
    );
    expect(sessionStorage.length).toBe(0);
  });

  it("rolls a failed reorder back without resurrecting deleted rows or stale item fields", () => {
    const deleted = item();
    const retained = item({
      id: "88888888-8888-4888-8888-888888888888",
      position: 1,
      bottle_price: 50,
    });
    const added = item({
      id: "99999999-9999-4999-8999-999999999999",
      position: 2,
    });
    const restored = restoreWineItemOrderAfterFailedReorder(
      [
        { ...retained, bottle_price: 55, position: 0 },
        added,
      ],
      [deleted, retained],
    );

    expect(restored.map(({ id }) => id)).toEqual([retained.id, added.id]);
    expect(restored[0].bottle_price).toBe(55);
    expect(restored.map(({ position }) => position)).toEqual([0, 1]);
  });

  it("guards multi-section create, skips known successes, and retries the failed section with its persisted key", async () => {
    let secondSectionAttempts = 0;
    mockFetch.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/wines/search")) {
          return Response.json([{
            id: WINE_ID,
            name: "Pinot Noir",
            producer: "Maison Test",
            vintage: 2022,
            varietal: "Pinot Noir",
            region: "Willamette Valley",
          }]);
        }
        if (url.startsWith(`/api/wines/${WINE_ID}/pricing-suggestion`)) {
          return Response.json({
            wineId: WINE_ID,
            suggestedBottle: null,
            suggestedGlass: null,
            glassPourMl: 148,
            targetMarkupRatio: 3,
            targetPourCostPct: 25,
            retailMedian: null,
            retailMin: null,
            retailMax: null,
            retailRetailerCount: null,
            retailRefreshedAt: null,
            categoryBandApplied: false,
            hasRetailData: false,
          });
        }
        if (url === "/api/wine-list-items" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as {
            section_id: string;
          };
          if (body.section_id === SECTION_ID) {
            return Response.json({ id: ITEM_ID });
          }
          secondSectionAttempts += 1;
          if (secondSectionAttempts === 1) {
            return Response.json(
              {
                error: {
                  code: "idempotency_unavailable",
                  message: "Request idempotency is temporarily unavailable.",
                },
              },
              { status: 503 },
            );
          }
          return Response.json({
            id: "77777777-7777-4777-8777-777777777777",
          });
        }
        throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
      },
    );

    await act(async () => {
      root.render(<WineListEditor list={list()} sections={sections()} />);
    });
    await act(async () => {
      button(container, "Add wine").click();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Maison Test, Pinot Noir"),
    );
    await act(async () => {
      buttonContaining(container, "Maison Test, Pinot Noir").click();
    });
    const reds = container.querySelector(
      'input[aria-label="Add to Reds"]',
    ) as HTMLInputElement;
    await act(async () => {
      reds.click();
    });

    await act(async () => {
      button(container, "Add to 2 sections").click();
      button(container, "Add to 2 sections").click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(mutationCalls("POST")).toHaveLength(2),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("temporarily unavailable"),
    );
    const firstPost = mockFetch.mock.calls.findIndex(
      ([url, init]) =>
        String(url) === "/api/wine-list-items" &&
        init?.method === "POST",
    );
    const secondPost = mockFetch.mock.calls.findIndex(
      ([url, init], index) =>
        index > firstPost &&
        String(url) === "/api/wine-list-items" &&
        init?.method === "POST",
    );
    const failedKey = keyAt(secondPost);
    expect(failedKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(
      (
        container.querySelector(
          'input[aria-label="Add to By the Glass"]',
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(reds.checked).toBe(true);
    const glassPrice = container.querySelector(
      "#add-wine-glass-price",
    ) as HTMLInputElement;
    const bottlePrice = container.querySelector(
      "#add-wine-bottle-price",
    ) as HTMLInputElement;
    expect(glassPrice.disabled).toBe(true);
    expect(bottlePrice.disabled).toBe(true);
    expect(
      (
        container.querySelector(
          'input[aria-label="Add to Reds"]',
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);

    await act(async () => {
      button(container, "Add to list").click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(mutationCalls("POST")).toHaveLength(3),
    );
    const postIndexes = mockFetch.mock.calls
      .map(([url, init], index) => ({
        index,
        isPost:
          String(url) === "/api/wine-list-items" &&
          init?.method === "POST",
      }))
      .filter(({ isPost }) => isPost)
      .map(({ index }) => index);
    expect(keyAt(postIndexes[2])).toBe(failedKey);
    expect(
      String(
        (mockFetch.mock.calls[postIndexes[1]][1] as RequestInit).body,
      ),
    ).toBe(
      String(
        (mockFetch.mock.calls[postIndexes[2]][1] as RequestInit).body,
      ),
    );
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps the add modal open and retryable when create returns an invalid success body", async () => {
    mockFetch.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/wines/search")) {
          return Response.json([{
            id: WINE_ID,
            name: "Pinot Noir",
            producer: "Maison Test",
            vintage: 2022,
            varietal: "Pinot Noir",
            region: "Willamette Valley",
          }]);
        }
        if (url.startsWith(`/api/wines/${WINE_ID}/pricing-suggestion`)) {
          return Response.json({
            wineId: WINE_ID,
            suggestedBottle: null,
            suggestedGlass: null,
            glassPourMl: 148,
            targetMarkupRatio: 3,
            targetPourCostPct: 25,
            retailMedian: null,
            retailMin: null,
            retailMax: null,
            retailRetailerCount: null,
            retailRefreshedAt: null,
            categoryBandApplied: false,
            hasRetailData: false,
          });
        }
        if (url === "/api/wine-list-items" && init?.method === "POST") {
          return Response.json({ unexpected: true });
        }
        throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
      },
    );

    await act(async () => {
      root.render(<WineListEditor list={list()} sections={sections()} />);
    });
    await act(async () => {
      button(container, "Add wine").click();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Maison Test, Pinot Noir"),
    );
    await act(async () => {
      buttonContaining(container, "Maison Test, Pinot Noir").click();
    });
    await act(async () => {
      button(container, "Add to list").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "server returned an invalid wine-list item",
      ),
    );
    expect(button(container, "Add to list")).not.toBeNull();
  });

  it("keeps a deleted row retryable after ambiguity and reuses the key", async () => {
    const first = deferredResponse();
    mockFetch
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await act(async () => {
      root.render(
        <WineListEditor list={list()} sections={sections([item()])} />,
      );
    });

    const remove = container.querySelector(
      'button[aria-label="Options for Pinot Noir"]',
    ) as HTMLButtonElement;
    await act(async () => {
      remove.click();
    });
    await act(async () => {
      button(container, "Remove wine").click();
      button(container, "Remove wine").click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(mutationCalls("DELETE")).toHaveLength(1),
    );
    const originalKey = keyAt(0);

    await act(async () => {
      first.resolve(
        Response.json(
          {
            error: {
              code: "idempotency_outcome_unknown",
              message: "The previous outcome is unknown.",
            },
          },
          { status: 409 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("previous outcome is unknown"),
    );
    expect(
      container.querySelector(
        'button[aria-label="Options for Pinot Noir"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      (
        container.querySelector(
          'button[aria-label="Options for Pinot Noir"]',
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      button(container, "Remove wine").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(mutationCalls("DELETE")).toHaveLength(2),
    );
    expect(keyAt(1)).toBe(originalKey);
    await vi.waitFor(() =>
      expect(
        container.querySelector(
          'button[aria-label="Options for Pinot Noir"]',
        ),
      ).toBeNull(),
    );
    expect(sessionStorage.length).toBe(0);
  });

  it("rolls an ambiguous toggle back so the same intent can retry with the same key", async () => {
    mockFetch
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "idempotency_unavailable",
              message: "Request idempotency is temporarily unavailable.",
            },
          },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await act(async () => {
      root.render(
        <WineListEditor list={list()} sections={sections([item()])} />,
      );
    });
    const visible = container.querySelector(
      'button[title="Visible on public list"]',
    ) as HTMLButtonElement;

    await act(async () => {
      visible.click();
      visible.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(mutationCalls("PATCH")).toHaveLength(1),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("temporarily unavailable"),
    );
    const originalKey = keyAt(0);
    const retry = container.querySelector(
      'button[title="Visible on public list"]',
    ) as HTMLButtonElement;
    expect(retry).not.toBeNull();

    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(mutationCalls("PATCH")).toHaveLength(2),
    );
    expect(keyAt(1)).toBe(originalKey);
    expect(
      JSON.parse(
        String((mockFetch.mock.calls[1][1] as RequestInit).body),
      ),
    ).toEqual({ hidden: true });
    expect(sessionStorage.length).toBe(0);
  });
});
