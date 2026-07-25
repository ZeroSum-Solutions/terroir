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

const { TeamActions } = await import("./team-actions");

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

function successResponse() {
  return Response.json({ success: true });
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

describe("team member idempotency callers", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    sessionStorage.clear();
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: vi.fn(() => true),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  async function renderActions() {
    await act(async () => {
      root.render(
        <TeamActions
          members={[
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              user_id: OWNER_ID,
              role: "owner",
              created_at: "2026-07-24T00:00:00.000Z",
            },
            {
              id: MEMBER_ID,
              user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              role: "staff",
              created_at: "2026-07-24T00:00:00.000Z",
            },
          ]}
          invitations={[]}
          currentUserId={OWNER_ID}
          restaurantName="Restaurant"
        />,
      );
    });
  }

  function roleSelect() {
    return container.querySelector("select") as HTMLSelectElement;
  }

  function removeButton() {
    return container.querySelector(
      'button[aria-label="Remove team member"]',
    ) as HTMLButtonElement;
  }

  function changeRole(role: "owner" | "manager" | "staff") {
    const select = roleSelect();
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;
    setValue?.call(select, role);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("guards a role change immediately and disables both row actions", async () => {
    let resolveRequest!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    await renderActions();

    await act(async () => {
      changeRole("manager");
      changeRole("manager");
      await Promise.resolve();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(roleSelect().disabled).toBe(true);
    expect(removeButton().disabled).toBe(true);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/team/members/${MEMBER_ID}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ role: "manager" });
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );

    await act(async () => {
      resolveRequest(successResponse());
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(roleSelect().disabled).toBe(false);
    expect(removeButton().disabled).toBe(false);
  });

  it("reuses an ambiguous role-change key and preserves unrelated state", async () => {
    mockFetch
      .mockResolvedValueOnce(unavailableResponse())
      .mockResolvedValueOnce(successResponse());
    await renderActions();

    const createInviteButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Create invite link"));
    await act(async () => {
      createInviteButton?.click();
      changeRole("manager");
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Request idempotency is temporarily unavailable.",
      );
    });

    const firstKey = new Headers(
      (mockFetch.mock.calls[0]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");
    expect(sessionStorage.length).toBe(1);
    expect(container.textContent).toContain("Invite team member");

    await act(async () => {
      changeRole("manager");
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const secondKey = new Headers(
      (mockFetch.mock.calls[1]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");

    expect(secondKey).toBe(firstKey);
    expect(sessionStorage.length).toBe(0);
    expect(container.textContent).toContain("Invite team member");
  });

  it("uses an independent guarded removal slot and consumes nested errors once", async () => {
    let resolveRequest!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    await renderActions();

    await act(async () => {
      removeButton().click();
      removeButton().click();
      await Promise.resolve();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(roleSelect().disabled).toBe(true);
    expect(removeButton().disabled).toBe(true);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/team/members/${MEMBER_ID}`);
    expect(init.method).toBe("DELETE");
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );

    await act(async () => {
      resolveRequest(
        Response.json(
          {
            error: {
              code: "bad_request",
              message: "Cannot remove yourself.",
            },
          },
          { status: 400 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Cannot remove yourself.",
      );
    });
    expect(sessionStorage.length).toBe(0);
  });
});
