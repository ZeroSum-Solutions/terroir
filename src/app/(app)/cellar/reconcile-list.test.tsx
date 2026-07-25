// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { ReconcileList } = await import("./reconcile-list");

const UUID_A = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const UUID_B = "b1b2c3d4-e5f6-4789-8abc-def012345679";

const ITEMS: OpenBottleRow[] = [
  {
    wine_id: UUID_A,
    wine_list_item_id: "c1b2c3d4-e5f6-4789-8abc-def012345670",
    producer: "Producer A",
    name: "Wine A",
    vintage: 2022,
    size_ml: 750,
    open_remaining_ml: 500,
    opened_at: "2026-07-24T09:00:00.000Z",
    glass_pour_ml: 150,
    pour_size_mode: "glass",
    sealed_count: 1,
  },
  {
    wine_id: UUID_B,
    wine_list_item_id: "d1b2c3d4-e5f6-4789-8abc-def012345671",
    producer: "Producer B",
    name: "Wine B",
    vintage: 2021,
    size_ml: 750,
    open_remaining_ml: 400,
    opened_at: "2026-07-24T08:00:00.000Z",
    glass_pour_ml: 150,
    pour_size_mode: "glass",
    sealed_count: 0,
  },
];

describe("ReconcileList", () => {
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

  async function renderList() {
    await act(async () => {
      root.render(<ReconcileList initialItems={ITEMS} />);
    });
  }

  function volumeInputs() {
    return Array.from(
      container.querySelectorAll<HTMLInputElement>(
        'input[aria-label="Actual remaining volume in ml"]',
      ),
    );
  }

  function saveButton() {
    return Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.match(/^(Save|Saving|No changes)/),
    ) as HTMLButtonElement;
  }

  async function changeVolume(index: number, value: string) {
    const input = volumeInputs()[index];
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("freezes every edit, guards double save, and sends one ordered keyed body", async () => {
    let resolveResponse!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    await renderList();
    await changeVolume(0, "375");
    await changeVolume(1, "0");

    await act(async () => {
      saveButton().click();
      saveButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll("input, button")).every(
        (element) => (element as HTMLInputElement | HTMLButtonElement).disabled,
      ),
    ).toBe(true);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/reconcile");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      entries: [
        { wine_id: UUID_A, new_remaining_ml: 375 },
        { wine_id: UUID_B, new_remaining_ml: 0 },
      ],
    });
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );
    const persisted = sessionStorage.getItem(
      "terroir:reconcile:save-all",
    );
    expect(JSON.parse(persisted ?? "{}")).toEqual({
      signatureHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      key: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/),
    });
    expect(persisted).not.toContain(UUID_A);
    expect(persisted).not.toContain("375");

    await act(async () => {
      resolveResponse(Response.json({ updated: 2 }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(saveButton().textContent).toContain("No changes yet");
    });
  });

  it("retains the exact key across a transport failure", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("connection interrupted"))
      .mockResolvedValueOnce(Response.json({ updated: 1 }));
    await renderList();
    await changeVolume(0, "350");

    await act(async () => {
      saveButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
    const firstKey = new Headers(
      (mockFetch.mock.calls[0][1] as RequestInit).headers,
    ).get("Idempotency-Key");

    await act(async () => {
      saveButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockRefresh).toHaveBeenCalledTimes(2);
    });
    const secondKey = new Headers(
      (mockFetch.mock.calls[1][1] as RequestInit).headers,
    ).get("Idempotency-Key");
    expect(secondKey).toBe(firstKey);
  });

  it("surfaces structured API envelope errors without consuming JSON twice", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: "EXCEEDS_SIZE",
            message: "new_remaining_ml exceeds bottle size.",
          },
        },
        { status: 400 },
      ),
    );
    await renderList();
    await changeVolume(0, "375");

    await act(async () => {
      saveButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "new_remaining_ml exceeds bottle size.",
      );
    });
    expect(saveButton().textContent).toContain("Save 1 change");
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
