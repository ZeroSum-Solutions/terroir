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

const { CloseBottleButton } = await import("./close-button");

const OPENED_AT = "2026-07-24T02:03:04.123456-07:00";

function bottleId(suffix: string) {
  return `22222222-2222-4222-8222-2222222222${suffix}`;
}

function successResponse() {
  return Response.json({
    closed: {
      id: "22222222-2222-4222-8222-222222222200",
      wine_id: "11111111-1111-4111-8111-111111111111",
      closed_at: "2026-07-24T09:10:00.000Z",
    },
  });
}

describe("CloseBottleButton", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function render(id: string) {
    await act(async () => {
      root.render(
        <CloseBottleButton
          bottleId={id}
          openedAt={OPENED_AT}
          remainingOz={4.2}
        />,
      );
    });
  }

  function actionButton() {
    return container.querySelector(
      'button[aria-label="Close bottle"], button[aria-label^="Confirm discard"], button[aria-label="Closing bottle"]',
    ) as HTMLButtonElement;
  }

  async function confirm() {
    const requestCount = mockFetch.mock.calls.length;
    await act(async () => actionButton().click());
    expect(mockFetch).toHaveBeenCalledTimes(requestCount);
    expect(actionButton().textContent).toContain("Discard 4.2 oz?");
  }

  it("requires two clicks, sends the normalized generation, and refreshes once", async () => {
    const id = bottleId("01");
    mockFetch.mockResolvedValueOnce(successResponse());
    await render(id);

    await confirm();
    await act(async () => {
      actionButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`/api/open-bottles/${id}/close`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      expected_opened_at: "2026-07-24T09:03:04.123456Z",
    });
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("uses a per-bottle slot and persists only key metadata", async () => {
    const id = bottleId("02");
    let resolveResponse!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    await render(id);

    await confirm();
    await act(async () => {
      actionButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const storageKey = `terroir:close-bottle:${encodeURIComponent(
      `close:${id}`,
    )}`;
    const persisted = sessionStorage.getItem(storageKey);
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted ?? "{}")).toEqual({
      signatureHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      key: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/),
    });
    expect(persisted).not.toContain("expected_opened_at");
    expect(persisted).not.toContain(OPENED_AT);

    await act(async () => {
      resolveResponse(successResponse());
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
  });

  it("guards a confirmation double click and gives Closing precedence", async () => {
    const id = bottleId("03");
    let resolveResponse!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    await render(id);
    await confirm();

    await act(async () => {
      actionButton().click();
      actionButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(actionButton().disabled).toBe(true);
    expect(actionButton().textContent).toContain("Closing...");
    expect(actionButton().textContent).not.toContain("Discard");

    await act(async () => {
      resolveResponse(successResponse());
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
  });

  it("retains the same key after a transport failure", async () => {
    const id = bottleId("04");
    mockFetch
      .mockRejectedValueOnce(new TypeError("connection interrupted"))
      .mockResolvedValueOnce(successResponse());
    await render(id);

    await confirm();
    await act(async () => {
      actionButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    });
    const firstKey = new Headers(
      (mockFetch.mock.calls[0]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");

    await confirm();
    await act(async () => {
      actionButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
    const secondKey = new Headers(
      (mockFetch.mock.calls[1]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");

    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("retains the same key after an ambiguous 503 response", async () => {
    const id = bottleId("05");
    mockFetch
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "idempotency_unavailable",
              message: "Temporarily unavailable.",
            },
          },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(successResponse());
    await render(id);

    await confirm();
    await act(async () => {
      actionButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Temporarily unavailable.",
      );
    });
    const firstKey = new Headers(
      (mockFetch.mock.calls[0]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");

    await confirm();
    await act(async () => {
      actionButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
    const secondKey = new Headers(
      (mockFetch.mock.calls[1]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");

    expect(secondKey).toBe(firstKey);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("surfaces a deterministic conflict and refreshes stale page state", async () => {
    const id = bottleId("06");
    mockFetch.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: "already_closed",
            message: "Bottle is already closed.",
          },
        },
        { status: 409 },
      ),
    );
    await render(id);

    await confirm();
    await act(async () => {
      actionButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Bottle is already closed.",
      );
    });
    expect(actionButton().textContent).toContain("Close");
  });

  it("expires and clears confirmation timers", async () => {
    await render(bottleId("07"));

    await confirm();
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTime(5000));

    expect(actionButton().textContent).toContain("Close");
    expect(vi.getTimerCount()).toBe(0);

    await confirm();
    expect(vi.getTimerCount()).toBe(1);
    const cancel = container.querySelector(
      'button[aria-label="Cancel close"]',
    ) as HTMLButtonElement;
    await act(async () => cancel.click());
    expect(vi.getTimerCount()).toBe(0);
  });
});
