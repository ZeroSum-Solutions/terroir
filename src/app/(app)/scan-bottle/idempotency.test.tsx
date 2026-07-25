// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockFetch = vi.fn();
const mockGetUserMedia = vi.fn().mockRejectedValue(new Error("no camera"));
vi.stubGlobal("fetch", mockFetch);

Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: mockGetUserMedia,
  },
});

const { default: ScanBottlePage } = await import("./page");

const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const ITEM_ID = "b1b2c3d4-e5f6-4789-8abc-def012345678";

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function keyAt(index: number) {
  const init = mockFetch.mock.calls[index]?.[1] as RequestInit;
  return new Headers(init.headers).get("Idempotency-Key");
}

function bodyAt(index: number) {
  return String((mockFetch.mock.calls[index]?.[1] as RequestInit).body);
}

function unavailableResponse() {
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

describe("bottle scan idempotency callers", () => {
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

  it("guards lookup and confirmation while reusing ambiguous keys", async () => {
    const firstLookup = deferredResponse();
    mockFetch.mockReturnValueOnce(firstLookup.promise);
    await act(async () => {
      root.render(<ScanBottlePage />);
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Camera not available"),
    );
    expect(mockGetUserMedia).not.toHaveBeenCalled();
    await act(async () => button(container, "Enter code").click());
    await setInput(
      container.querySelector("#manual-code") as HTMLInputElement,
      WINE_ID,
    );

    const lookupButton = button(container, "Look up wine");
    await act(async () => {
      lookupButton.click();
      lookupButton.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const lookupKey = keyAt(0);
    const lookupBody = bodyAt(0);
    expect(lookupKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(button(container, "Looking up...").disabled).toBe(true);

    await act(async () => {
      firstLookup.resolve(unavailableResponse());
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("temporarily unavailable"),
    );
    expect(
      sessionStorage.getItem("terroir:bottle-scan-lookup:lookup"),
    ).not.toBeNull();

    mockFetch.mockResolvedValueOnce(
      Response.json({
        id: WINE_ID,
        producer: "Domaine Test",
        name: "Volnay",
        vintage: 2022,
        varietal: "Pinot Noir",
        region: "Burgundy",
        country: "France",
      }),
    );
    await act(async () => {
      button(container, "Try again").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Match found"),
    );
    expect(keyAt(1)).toBe(lookupKey);
    expect(bodyAt(1)).toBe(lookupBody);
    expect(
      sessionStorage.getItem("terroir:bottle-scan-lookup:lookup"),
    ).toBeNull();

    await act(async () => button(container, "Confirm").click());
    await setInput(
      container.querySelector("#bottle-section") as HTMLInputElement,
      " Reds ",
    );
    await setInput(
      container.querySelector("#bottle-bin") as HTMLInputElement,
      " A-1 ",
    );

    const firstConfirm = deferredResponse();
    mockFetch.mockReturnValueOnce(firstConfirm.promise);
    const saveButton = button(container, "Save location");
    await act(async () => {
      saveButton.click();
      saveButton.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    const confirmKey = keyAt(2);
    const confirmBody = bodyAt(2);
    expect(confirmKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(JSON.parse(confirmBody)).toEqual({
      bin_location: "A-1",
      section: "Reds",
      wine_id: WINE_ID,
    });

    await act(async () => {
      firstConfirm.resolve(unavailableResponse());
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Save failed"),
    );
    expect(button(container, "Edit location")).toBeDefined();
    expect(
      sessionStorage.getItem("terroir:bottle-scan-confirm:confirm"),
    ).not.toBeNull();

    mockFetch.mockResolvedValueOnce(
      Response.json({
        id: ITEM_ID,
        section: "Reds",
        bin_location: "A-1",
        added_at: "2026-07-24T00:00:00.000Z",
        wine_id: WINE_ID,
      }, { status: 201 }),
    );
    await act(async () => {
      button(container, "Try again").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Bottle confirmed"),
    );
    expect(keyAt(3)).toBe(confirmKey);
    expect(bodyAt(3)).toBe(confirmBody);
    expect(
      sessionStorage.getItem("terroir:bottle-scan-confirm:confirm"),
    ).toBeNull();
  });

  it("rejects a malformed lookup response before it can seed confirmation", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json({ id: WINE_ID, producer: "Incomplete" }),
    );
    await act(async () => {
      root.render(<ScanBottlePage />);
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Camera not available"),
    );
    await act(async () => button(container, "Enter code").click());
    await setInput(
      container.querySelector("#manual-code") as HTMLInputElement,
      WINE_ID,
    );

    await act(async () => {
      button(container, "Look up wine").click();
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "Lookup returned an invalid wine.",
      ),
    );
    expect(button(container, "Enter different code")).toBeDefined();
    expect(container.textContent).not.toContain("Match found");
  });

  it("distinguishes wine-search failure from an empty result", async () => {
    mockFetch
      .mockResolvedValueOnce(
        Response.json({
          id: WINE_ID,
          producer: "Domaine Test",
          name: "Volnay",
          vintage: 2022,
          varietal: "Pinot Noir",
          region: "Burgundy",
          country: "France",
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "internal_error", message: "Nope" } },
          { status: 500 },
        ),
      );
    await act(async () => {
      root.render(<ScanBottlePage />);
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Camera not available"),
    );
    await act(async () => button(container, "Enter code").click());
    await setInput(
      container.querySelector("#manual-code") as HTMLInputElement,
      WINE_ID,
    );
    await act(async () => {
      button(container, "Look up wine").click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Match found"),
    );
    await act(async () => button(container, "Correct").click());

    await setInput(
      container.querySelector("#correct-search") as HTMLInputElement,
      "Volnay",
    );

    await vi.waitFor(() =>
      expect(container.textContent).toContain("Wine search failed."),
    );
    expect(container.textContent).not.toContain("No wines found");
    expect(mockFetch.mock.calls[1]?.[0]).toBe(
      "/api/wines/search?q=Volnay",
    );
  });
});
