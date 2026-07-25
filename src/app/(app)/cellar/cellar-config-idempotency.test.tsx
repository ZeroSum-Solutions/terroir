// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockRefresh = vi.hoisted(() => vi.fn());
const mockBack = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, back: mockBack }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { CellarSetup } = await import("./cellar-grid");
const { default: CellarConfigPage } = await import("./config/page");

function configResponse(
  rows: number,
  columns: number,
  sections: Array<{ id: string; name: string }> = [],
) {
  return Response.json({
    id: "config-a",
    restaurant_id: "restaurant-a",
    name: "Main Cellar",
    rows,
    columns,
    labels: {
      sections,
      section_order: sections.map((section) => section.id),
    },
  });
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

describe("cellar config idempotency callers", () => {
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

  async function renderSetup() {
    await act(async () => {
      root.render(<CellarSetup restaurantName="Restaurant" />);
    });
  }

  async function renderSections() {
    await act(async () => {
      root.render(<CellarConfigPage />);
    });
    await vi.waitFor(() => {
      expect(
        container.querySelector(
          'input[placeholder^="New section name"]',
        ),
      ).not.toBeNull();
    });
  }

  function setupButton() {
    return Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Create cellar"),
    ) as HTMLButtonElement;
  }

  function sectionInput() {
    return container.querySelector(
      'input[placeholder^="New section name"]',
    ) as HTMLInputElement;
  }

  function addButton() {
    return Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Add",
    ) as HTMLButtonElement;
  }

  it("guards cellar creation and disables every conflicting setup control", async () => {
    let resolveCreate!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    await renderSetup();

    await act(async () => {
      setupButton().click();
      setupButton().click();
      await Promise.resolve();
    });

    await vi.waitFor(
      () => expect(mockFetch).toHaveBeenCalledTimes(1),
      { timeout: 5000 },
    );
    expect(setupButton().disabled).toBe(true);
    expect(
      Array.from(container.querySelectorAll("input, button")).every(
        (control) => (control as HTMLInputElement).disabled,
      ),
    ).toBe(true);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      rows: 10,
      columns: 10,
    });
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );

    await act(async () => {
      resolveCreate(configResponse(10, 10));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(sessionStorage.length).toBe(0);
  });

  it("retains the cellar creation key until GET reconciliation succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(unavailableResponse())
      .mockResolvedValueOnce(Response.json(null))
      .mockResolvedValueOnce(configResponse(10, 10));
    await renderSetup();

    await act(async () => {
      setupButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(
      () => {
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(
          "Request idempotency is temporarily unavailable.",
        );
      },
      { timeout: 5000 },
    );
    const firstKey = new Headers(
      (mockFetch.mock.calls[0]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");
    expect(sessionStorage.length).toBe(1);

    await act(async () => {
      setupButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    const secondKey = new Headers(
      (mockFetch.mock.calls[2]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");

    expect(secondKey).toBe(firstKey);
    expect(sessionStorage.length).toBe(0);
  });

  it("fails closed when persisted sections have an invalid shape", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json({
        id: "config-a",
        labels: {
          sections: [{ id: 7, name: "Unreadable" }],
        },
      }),
    );

    await renderSections();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The stored cellar configuration is invalid and cannot be edited.",
    );
    expect(sectionInput().disabled).toBe(true);
    expect(addButton().disabled).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when persisted labels are not an object", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json({
        id: "config-a",
        labels: [],
      }),
    );

    await renderSections();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The stored cellar configuration is invalid and cannot be edited.",
    );
    expect(sectionInput().disabled).toBe(true);
    expect(addButton().disabled).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("preserves an unsent section name and exact payload across an ambiguous retry", async () => {
    mockFetch
      .mockResolvedValueOnce(configResponse(10, 10))
      .mockResolvedValueOnce(unavailableResponse())
      .mockResolvedValueOnce(configResponse(10, 10))
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          sections: Array<{ id: string; name: string }>;
        };
        return Promise.resolve(
          configResponse(10, 10, body.sections),
        );
      });
    await renderSections();

    await act(async () => {
      const input = sectionInput();
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(input, "Reds");
      input.dispatchEvent(
        new Event("input", { bubbles: true }),
      );
    });
    await act(async () => {
      addButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Request idempotency is temporarily unavailable.",
      );
    });

    const firstBody = String(
      (mockFetch.mock.calls[1]?.[1] as RequestInit).body,
    );
    const firstKey = new Headers(
      (mockFetch.mock.calls[1]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");
    expect(sectionInput().value).toBe("Reds");
    expect(sessionStorage.length).toBe(1);

    await act(async () => {
      addButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));

    const secondBody = String(
      (mockFetch.mock.calls[3]?.[1] as RequestInit).body,
    );
    const secondKey = new Headers(
      (mockFetch.mock.calls[3]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");
    expect(secondBody).toBe(firstBody);
    expect(secondKey).toBe(firstKey);
    expect(sectionInput().value).toBe("");
    expect(container.textContent).toContain("Reds");
    expect(sessionStorage.length).toBe(0);
  });
});
