// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockFetch = vi.fn();
const mockGetUserMedia = vi.fn().mockRejectedValue(new Error("no camera"));
const originalReadyState = Object.getOwnPropertyDescriptor(
  HTMLMediaElement.prototype,
  "readyState",
);
const originalSrcObject = Object.getOwnPropertyDescriptor(
  HTMLMediaElement.prototype,
  "srcObject",
);
vi.stubGlobal("fetch", mockFetch);

Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: mockGetUserMedia,
  },
});

const { default: ScanBottlePage } = await import("./page");

const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const SECOND_WINE_ID = "c1b2c3d4-e5f6-4789-8abc-def012345678";
const ITEM_ID = "b1b2c3d4-e5f6-4789-8abc-def012345678";

function wineResponse(
  id = WINE_ID,
  producer = "Domaine Test",
  name = "Volnay",
) {
  return Response.json({
    id,
    producer,
    name,
    vintage: 2022,
    varietal: "Pinot Noir",
    region: "Burgundy",
    country: "France",
  });
}

function confirmResponse(
  wineId: string,
  section: string,
  binLocation: string,
) {
  return Response.json(
    {
      id: ITEM_ID,
      section,
      bin_location: binLocation,
      added_at: "2026-07-24T00:00:00.000Z",
      wine_id: wineId,
    },
    { status: 201 },
  );
}

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
    Reflect.deleteProperty(window, "BarcodeDetector");
    if (originalReadyState) {
      Object.defineProperty(
        HTMLMediaElement.prototype,
        "readyState",
        originalReadyState,
      );
    }
    if (originalSrcObject) {
      Object.defineProperty(
        HTMLMediaElement.prototype,
        "srcObject",
        originalSrcObject,
      );
    } else {
      Reflect.deleteProperty(HTMLMediaElement.prototype, "srcObject");
    }
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("decodes a camera QR lookup and releases the media track", async () => {
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    let nextFrame: FrameRequestCallback | null = null;
    const detect = vi.fn().mockResolvedValue([{ rawValue: WINE_ID }]);

    Object.defineProperty(window, "BarcodeDetector", {
      configurable: true,
      value: class BarcodeDetector {
        detect = detect;
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
      configurable: true,
      get: () => 2,
    });
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      writable: true,
      value: null,
    });
    mockGetUserMedia.mockResolvedValueOnce(stream);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        nextFrame = callback;
        return 82;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    mockFetch.mockResolvedValueOnce(wineResponse());

    await act(async () => {
      root.render(<ScanBottlePage />);
    });
    await vi.waitFor(() => expect(mockGetUserMedia).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(nextFrame).not.toBeNull());

    await act(async () => {
      const frame = nextFrame as FrameRequestCallback | null;
      if (!frame) throw new Error("Camera frame was not scheduled");
      frame(0);
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain("Match found"),
    );
    expect(detect).toHaveBeenCalledOnce();
    expect(JSON.parse(bodyAt(0))).toEqual({ qr_payload: WINE_ID });
    expect(stop).toHaveBeenCalledOnce();
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

  it("lets the operator correct a match before confirming its location", async () => {
    mockFetch
      .mockResolvedValueOnce(wineResponse())
      .mockResolvedValueOnce(
        Response.json([
          {
            id: SECOND_WINE_ID,
            producer: "Maison Corrected",
            name: "Gevrey-Chambertin",
            vintage: 2021,
            varietal: "Pinot Noir",
            region: "Burgundy",
            country: "France",
          },
        ]),
      )
      .mockResolvedValueOnce(
        confirmResponse(SECOND_WINE_ID, "Reserve", "C-7"),
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
    await act(async () => button(container, "Look up wine").click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Match found"),
    );

    await act(async () => button(container, "Correct").click());
    await setInput(
      container.querySelector("#correct-search") as HTMLInputElement,
      "Maison",
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Maison Corrected"),
    );
    const result = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("Gevrey-Chambertin"),
    );
    if (!result) throw new Error("Corrected wine result not found");
    await act(async () => result.click());
    expect(container.textContent).toContain("Maison Corrected");
    expect(container.textContent).not.toContain("Domaine Test");

    await act(async () => button(container, "Confirm").click());
    await setInput(
      container.querySelector("#bottle-section") as HTMLInputElement,
      "Reserve",
    );
    await setInput(
      container.querySelector("#bottle-bin") as HTMLInputElement,
      "C-7",
    );
    await act(async () => button(container, "Save location").click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Bottle confirmed"),
    );
    expect(JSON.parse(bodyAt(2))).toEqual({
      bin_location: "C-7",
      section: "Reserve",
      wine_id: SECOND_WINE_ID,
    });
  });

  it("records two rapid confirmations in one scan session", async () => {
    mockFetch
      .mockResolvedValueOnce(wineResponse())
      .mockResolvedValueOnce(confirmResponse(WINE_ID, "Reds", "A-1"))
      .mockResolvedValueOnce(
        wineResponse(SECOND_WINE_ID, "Domaine Two", "Pommard"),
      )
      .mockResolvedValueOnce(
        confirmResponse(SECOND_WINE_ID, "Reserve", "B-2"),
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
    await act(async () => button(container, "Look up wine").click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Match found"),
    );
    await act(async () => button(container, "Confirm").click());
    await setInput(
      container.querySelector("#bottle-section") as HTMLInputElement,
      "Reds",
    );
    await setInput(
      container.querySelector("#bottle-bin") as HTMLInputElement,
      "A-1",
    );
    await act(async () => button(container, "Save location").click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Bottle confirmed"),
    );

    await act(async () => button(container, "Scan another bottle").click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Camera not available"),
    );
    await act(async () => button(container, "Enter code").click());
    await setInput(
      container.querySelector("#manual-code") as HTMLInputElement,
      SECOND_WINE_ID,
    );
    await act(async () => button(container, "Look up wine").click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Domaine Two"),
    );
    await act(async () => button(container, "Confirm").click());
    await setInput(
      container.querySelector("#bottle-section") as HTMLInputElement,
      "Reserve",
    );
    await setInput(
      container.querySelector("#bottle-bin") as HTMLInputElement,
      "B-2",
    );
    await act(async () => button(container, "Save location").click());

    await vi.waitFor(() =>
      expect(container.textContent).toContain("2 scanned"),
    );
    expect(keyAt(0)).not.toBe(keyAt(2));
    expect(keyAt(1)).not.toBe(keyAt(3));
    await act(async () => button(container, "End session (2 scanned)").click());
    expect(container.textContent).toContain("2 bottles scanned");
    expect(container.textContent).toContain("Domaine Test");
    expect(container.textContent).toContain("Reds");
    expect(container.textContent).toContain("A-1");
    expect(container.textContent).toContain("Domaine Two");
    expect(container.textContent).toContain("Reserve");
    expect(container.textContent).toContain("B-2");
  });
});
