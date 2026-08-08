// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/lib/toast";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { QuantityAdjustmentModal } = await import(
  "./quantity-adjustment-modal"
);

function setValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(control),
    "value",
  )?.set;
  setter?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("QuantityAdjustmentModal", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    sessionStorage.clear();
    onClose = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.clear();
  });

  async function render(wineId = "wine-a") {
    await act(async () => {
      root.render(
        <ToastProvider>
          <QuantityAdjustmentModal
            wineId={wineId}
            wineName="Fixture Wine"
            currentQuantity={3}
            onClose={onClose}
          />
        </ToastProvider>,
      );
    });
  }

  function saveButton() {
    return Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save audited adjustment",
    ) as HTMLButtonElement;
  }

  it("requires a bounded integer quantity and a reason before submission", async () => {
    await render();
    const quantity = container.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement;
    const reason = container.querySelector("textarea") as HTMLTextAreaElement;

    expect(saveButton().disabled).toBe(true);
    await act(async () => setValue(reason, "Physical count"));
    expect(saveButton().disabled).toBe(false);
    await act(async () => setValue(quantity, "-1"));
    expect(saveButton().disabled).toBe(true);
    await act(async () => setValue(quantity, "2.5"));
    expect(saveButton().disabled).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends one normalized keyed adjustment and refreshes after success", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json({
        wineId: "wine-b",
        quantity: 2,
        previousQuantity: 3,
        delta: -1,
        reason: "Physical count",
      }),
    );
    await render("wine-b");
    const quantity = container.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement;
    const reason = container.querySelector("textarea") as HTMLTextAreaElement;

    await act(async () => {
      setValue(quantity, "2");
      setValue(reason, "  Physical count  ");
    });
    await act(async () => {
      saveButton().click();
      saveButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/cellar/wine-b/quantity");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      quantity: 2,
      reason: "Physical count",
    });
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Quantity adjusted and logged");
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps the dialog open and shows a safe server validation error", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: "invalid_quantity_adjustment",
            message: "Invalid cellar quantity adjustment.",
          },
        },
        { status: 400 },
      ),
    );
    await render("wine-c");
    const reason = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => setValue(reason, "Count"));
    await act(async () => {
      saveButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Invalid cellar quantity adjustment.",
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
