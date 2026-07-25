// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { SettingsDropdown } = await import("./settings-dropdown");

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

describe("SettingsDropdown restaurant switching", () => {
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

  async function render() {
    await act(async () => {
      root.render(
        <SettingsDropdown
          activeRestaurantId="11111111-1111-4111-8111-111111111111"
          activeRestaurantName="First Restaurant"
          activeRole="owner"
          restaurants={[
            {
              restaurantId:
                "11111111-1111-4111-8111-111111111111",
              restaurantName: "First Restaurant",
              role: "owner",
            },
            {
              restaurantId:
                "22222222-2222-4222-8222-222222222222",
              restaurantName: "Second Restaurant",
              role: "manager",
            },
          ]}
        />,
      );
    });
    await act(async () => {
      (
        container.querySelector(
          'button[aria-label="Settings"]',
        ) as HTMLButtonElement
      ).click();
    });
  }

  function secondRestaurantButton() {
    return [...container.querySelectorAll("button")].find(
      (button) =>
        button.textContent?.includes("Second Restaurant"),
    ) as HTMLButtonElement;
  }

  it("guards duplicates, persists the retry key, and retries ambiguity with the same key", async () => {
    let resolveFirst!: (response: Response) => void;
    mockFetch
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          restaurantId:
            "22222222-2222-4222-8222-222222222222",
        }),
      );
    await render();

    await act(async () => {
      secondRestaurantButton().click();
      secondRestaurantButton().click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(secondRestaurantButton().disabled).toBe(true);
    const firstInit = mockFetch.mock.calls[0]?.[1] as RequestInit;
    const firstKey = new Headers(firstInit.headers).get(
      "Idempotency-Key",
    );
    expect(firstKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(firstInit.method).toBe("PUT");
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "/api/restaurant/22222222-2222-4222-8222-222222222222",
    );
    expect(
      sessionStorage.getItem(
        "terroir:restaurant-switch:pending",
      ),
    ).toContain("22222222-2222-4222-8222-222222222222");

    await act(async () => {
      resolveFirst(unavailableResponse());
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Request idempotency is temporarily unavailable.",
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      secondRestaurantButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockRefresh).toHaveBeenCalledTimes(2);
    });

    const secondInit = mockFetch.mock.calls[1]?.[1] as RequestInit;
    expect(
      new Headers(secondInit.headers).get("Idempotency-Key"),
    ).toBe(firstKey);
    expect(
      sessionStorage.getItem(
        "terroir:restaurant-switch:pending",
      ),
    ).toBeNull();
    expect(
      sessionStorage.getItem(
        "terroir:restaurant-switch:switch",
      ),
    ).toBeNull();
  });
});
