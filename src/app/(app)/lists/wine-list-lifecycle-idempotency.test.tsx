// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WineListWithCount } from "@/lib/wine-list/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockPush = vi.hoisted(() => vi.fn());
const mockRefresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

vi.mock("qrcode", () => ({
  toString: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg" />'),
  toDataURL: vi.fn(async () => "data:image/png;base64,AA=="),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { WineListLanding } = await import("./wine-list-landing");
const { WineListEditor } = await import("./[id]/wine-list-editor");
const { PublishModal } = await import("./[id]/components/publish-modal");

const LIST_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_ID = "22222222-2222-4222-8222-222222222222";
const RESTAURANT_ID = "33333333-3333-4333-8333-333333333333";

function list(overrides: Partial<WineListWithCount> = {}): WineListWithCount {
  return {
    archived: false,
    created_at: "2026-07-24T00:00:00.000Z",
    description: null,
    id: LIST_ID,
    is_published: false,
    last_published_at: null,
    name: "Dinner",
    restaurant_id: RESTAURANT_ID,
    slug: null,
    template: "classic",
    updated_at: "2026-07-24T00:00:00.000Z",
    wine_count: 0,
    ...overrides,
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function keyAt(index: number) {
  const init = mockFetch.mock.calls[index]?.[1] as RequestInit;
  return new Headers(init.headers).get("Idempotency-Key");
}

function bodyAt(index: number) {
  return String((mockFetch.mock.calls[index]?.[1] as RequestInit).body);
}

function button(container: HTMLElement, text: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Button ${text} not found`);
  return match as HTMLButtonElement;
}

async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("wine-list lifecycle idempotency callers", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    sessionStorage.clear();
    vi.stubGlobal("confirm", vi.fn(() => true));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.clear();
  });

  it("guards create and reuses its persisted key after a lost response", async () => {
    const first = deferredResponse();
    mockFetch.mockReturnValueOnce(first.promise);
    await act(async () => {
      root.render(<WineListLanding lists={[]} />);
    });
    await act(async () => {
      button(container, "New wine list").click();
    });
    await setInput(
      container.querySelector('input[placeholder^="Spring"]') as HTMLInputElement,
      "Summer Dinner",
    );

    await act(async () => {
      button(container, "Create").click();
      button(container, "Create").click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const originalKey = keyAt(0);
    const originalBody = bodyAt(0);
    expect(originalKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);

    await act(async () => {
      first.reject(new TypeError("connection reset after commit"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "connection reset after commit",
      ),
    );
    expect(sessionStorage.length).toBe(1);

    mockFetch.mockResolvedValueOnce(Response.json({ id: CREATED_ID }));
    await act(async () => {
      button(container, "Create").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(`/lists/${CREATED_ID}`),
    );
    expect(keyAt(1)).toBe(originalKey);
    expect(bodyAt(1)).toBe(originalBody);
    expect(sessionStorage.length).toBe(0);

    await act(async () => {
      button(container, "Creating...").click();
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("treats a parsed 2xx as authoritative before validating its UI shape", async () => {
    mockFetch
      .mockResolvedValueOnce(Response.json({ unexpected: true }))
      .mockResolvedValueOnce(Response.json({ id: CREATED_ID }));
    await act(async () => {
      root.render(<WineListLanding lists={[]} />);
    });
    await act(async () => {
      button(container, "New wine list").click();
    });
    await setInput(
      container.querySelector('input[placeholder^="Spring"]') as HTMLInputElement,
      "Summer Dinner",
    );

    await act(async () => {
      button(container, "Create").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "invalid wine list",
      ),
    );
    const acknowledgedKey = keyAt(0);
    expect(sessionStorage.length).toBe(0);

    await act(async () => {
      button(container, "Create").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(`/lists/${CREATED_ID}`),
    );
    expect(keyAt(1)).not.toBe(acknowledgedKey);
  });

  it("keeps an archive key across an ambiguous response until success", async () => {
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
      root.render(<WineListLanding lists={[list()]} />);
    });

    const archive = container.querySelector(
      'button[aria-label="Archive Dinner"]',
    ) as HTMLButtonElement;
    await act(async () => {
      archive.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "temporarily unavailable",
      ),
    );
    const originalKey = keyAt(0);
    expect(sessionStorage.length).toBe(1);

    await act(async () => {
      archive.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(keyAt(1)).toBe(originalKey);
    expect(bodyAt(1)).toBe(bodyAt(0));
    expect(sessionStorage.length).toBe(0);
  });

  it("guards delete and reuses its key after an ambiguous response", async () => {
    const pending = deferredResponse();
    mockFetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await act(async () => {
      root.render(
        <WineListLanding
          lists={[]}
          archivedLists={[list({ archived: true })]}
          showArchived
        />,
      );
    });
    const remove = container.querySelector(
      'button[aria-label="Permanently delete Dinner"]',
    ) as HTMLButtonElement;

    await act(async () => {
      remove.click();
      remove.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const originalKey = keyAt(0);
    expect(originalKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);

    await act(async () => {
      pending.resolve(
        Response.json(
          {
            error: {
              code: "idempotency_unavailable",
              message: "Request idempotency is temporarily unavailable.",
            },
          },
          { status: 503 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "temporarily unavailable",
      ),
    );
    expect(sessionStorage.length).toBe(1);

    await act(async () => {
      remove.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(keyAt(1)).toBe(originalKey);
    expect(sessionStorage.length).toBe(0);
  });

  it("guards editor templates visibly and reuses a key after ambiguity", async () => {
    const pending = deferredResponse();
    mockFetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await act(async () => {
      root.render(
        <WineListEditor
          list={list()}
          sections={[]}
        />,
      );
    });

    await act(async () => {
      button(container, "Modern").click();
      button(container, "Modern").click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(bodyAt(0))).toEqual({ template: "modern" });
    const originalKey = keyAt(0);
    expect(originalKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(button(container, "Minimal").disabled).toBe(true);

    await act(async () => {
      pending.resolve(
        Response.json(
          {
            error: {
              code: "idempotency_unavailable",
              message: "Request idempotency is temporarily unavailable.",
            },
          },
          { status: 503 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("temporarily unavailable"),
    );
    expect(sessionStorage.length).toBe(1);
    expect(button(container, "Minimal").disabled).toBe(false);

    await act(async () => {
      button(container, "Modern").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(keyAt(1)).toBe(originalKey);
    expect(sessionStorage.length).toBe(0);
  });

  it("guards published-slug updates and reuses a key after ambiguity", async () => {
    const pending = deferredResponse();
    mockFetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await act(async () => {
      root.render(
        <PublishModal
          listId={LIST_ID}
          currentSlug="dinner"
          isPublished
          onClose={vi.fn()}
        />,
      );
    });
    await setInput(
      container.querySelector("#edit-slug") as HTMLInputElement,
      "Summer-Dinner",
    );

    await act(async () => {
      button(container, "Save").click();
      button(container, "Save").click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(bodyAt(0))).toEqual({ slug: "summer-dinner" });
    const originalKey = keyAt(0);
    expect(originalKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);

    await act(async () => {
      pending.resolve(
        Response.json(
          {
            error: {
              code: "idempotency_unavailable",
              message: "Request idempotency is temporarily unavailable.",
            },
          },
          { status: 503 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("temporarily unavailable"),
    );
    expect(sessionStorage.length).toBe(1);

    await act(async () => {
      button(container, "Save").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Slug updated."),
    );
    expect(keyAt(1)).toBe(originalKey);
    expect(sessionStorage.length).toBe(0);
  });
});
