// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
const mockConfirm = vi.fn(() => true);
vi.stubGlobal("confirm", mockConfirm);

const { TeamActions } = await import("./team-actions");

const CURRENT_USER_ID = "11111111-1111-4111-8111-111111111111";
const INVITATION_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = CURRENT_USER_ID;
const MEMBER_ID = "abababab-abab-4bab-8bab-abababababab";

type Invitation = {
  id: string;
  token: string;
  role: "owner" | "manager" | "staff";
  email: string | null;
  expires_at: string;
  created_at: string;
};

function invitation(
  id = INVITATION_ID,
  email = "invitee@example.com",
): Invitation {
  return {
    id,
    token: "a".repeat(48),
    role: "manager",
    email,
    expires_at: "2026-08-01T00:00:00.000Z",
    created_at: "2026-07-24T17:00:00.000Z",
  };
}

function inviteResponse(row: Invitation) {
  return {
    ...row,
    inviteUrl: `${window.location.origin}/invite/${row.token}`,
  };
}

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

describe("TeamActions invitation commands", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockConfirm.mockClear();
    sessionStorage.clear();
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

  async function render(invitations: Invitation[] = []) {
    await act(async () => {
      root.render(
        <StrictMode>
          <TeamActions
            members={[
              {
                id: "33333333-3333-4333-8333-333333333333",
                user_id: CURRENT_USER_ID,
                role: "owner",
                created_at: "2026-01-01T00:00:00.000Z",
              },
            ]}
            invitations={invitations}
            currentUserId={CURRENT_USER_ID}
            restaurantName="Test Restaurant"
          />
        </StrictMode>,
      );
    });
  }

  function buttonWithText(text: string) {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === text,
    ) as HTMLButtonElement;
  }

  async function openCreateModal(email: string) {
    await act(async () => buttonWithText("Create invite link").click());
    const input = container.querySelector(
      "#invite-email",
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, email);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  }

  it("guards create immediately, disables its inputs, and persists only command metadata", async () => {
    const row = invitation(
      "44444444-4444-4444-8444-444444444444",
      "new@example.com",
    );
    let resolveResponse!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    await render();
    const input = await openCreateModal("  New@Example.COM ");
    const generate = buttonWithText("Generate link");

    await act(async () => {
      generate.click();
      generate.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(input.disabled).toBe(true);
    expect(
      (container.querySelector("#invite-role") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(generate.disabled).toBe(true);

    const persisted = sessionStorage.getItem(
      "terroir:team-invites:create",
    );
    expect(JSON.parse(persisted ?? "{}")).toEqual({
      signatureHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      key: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/),
    });
    expect(persisted).not.toContain("new@example.com");
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      email: "new@example.com",
      role: "staff",
    });

    await act(async () => {
      resolveResponse(Response.json(inviteResponse(row)));
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledOnce();
      expect(container.textContent).toContain(row.token);
    });
  });

  it("preserves modal input and reconstructs a lost create URL from refreshed rows", async () => {
    const body = {
      error: {
        code: "idempotency_unavailable",
        message: "Invite result is temporarily unavailable.",
      },
    };
    const response = Response.json(body, { status: 503 });
    const json = vi.spyOn(response, "json");
    mockFetch.mockResolvedValueOnce(response);
    await render();
    await openCreateModal("recover@example.com");

    await act(async () => {
      buttonWithText("Generate link").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledOnce();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Invite result is temporarily unavailable.",
      );
    });
    expect(json).toHaveBeenCalledOnce();

    await render([]);
    expect(
      (container.querySelector("#invite-email") as HTMLInputElement).value,
    ).toBe("recover@example.com");

    const recovered = invitation(
      "55555555-5555-4555-8555-555555555555",
      "recover@example.com",
    );
    recovered.role = "staff";
    recovered.created_at = new Date().toISOString();
    await render([recovered]);

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        `${window.location.origin}/invite/${recovered.token}`,
      );
    });
    expect(
      sessionStorage.getItem("terroir:team-invites:create"),
    ).toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("does not let an abandoned create reconciliation hijack a new modal intent", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: "idempotency_unavailable",
            message: "Invite result is temporarily unavailable.",
          },
        },
        { status: 503 },
      ),
    );
    await render();
    await openCreateModal("old@example.com");

    await act(async () => {
      buttonWithText("Generate link").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledOnce());

    await act(async () => buttonWithText("Cancel").click());
    await openCreateModal("new@example.com");
    const oldInvite = invitation(
      "56565656-5656-4565-8565-565656565656",
      "old@example.com",
    );
    oldInvite.role = "staff";
    oldInvite.created_at = new Date().toISOString();
    await render([oldInvite]);

    expect(
      (container.querySelector("#invite-email") as HTMLInputElement).value,
    ).toBe("new@example.com");
    expect(buttonWithText("Generate link")).toBeDefined();
    expect(container.textContent).not.toContain(
      `${window.location.origin}/invite/${oldInvite.token}`,
    );
  });

  it("keeps create recovery safe when a same-command retry is still in flight", async () => {
    let resolveRetry!: (response: Response) => void;
    mockFetch
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "idempotency_unavailable",
              message: "Invite result is temporarily unavailable.",
            },
          },
          { status: 503 },
        ),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveRetry = resolve;
        }),
      );
    await render();
    await openCreateModal("busy-recovery@example.com");

    await act(async () => {
      buttonWithText("Generate link").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce());

    await act(async () => {
      buttonWithText("Generate link").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const recovered = invitation(
      "57575757-5757-4575-8575-575757575757",
      "busy-recovery@example.com",
    );
    recovered.role = "staff";
    recovered.created_at = new Date().toISOString();
    await render([recovered]);

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        `${window.location.origin}/invite/${recovered.token}`,
      );
    });
    expect(
      sessionStorage.getItem("terroir:team-invites:create"),
    ).not.toBeNull();

    await act(async () => {
      resolveRetry(Response.json(inviteResponse(recovered)));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(2));
    expect(
      sessionStorage.getItem("terroir:team-invites:create"),
    ).toBeNull();
  });

  it("retains the create key when refreshed rows are not uniquely attributable", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: "idempotency_unavailable",
            message: "Invite result is temporarily unavailable.",
          },
        },
        { status: 503 },
      ),
    );
    await render();
    await openCreateModal("collision@example.com");
    await act(async () => {
      buttonWithText("Generate link").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledOnce());

    const first = invitation(
      "58585858-5858-4585-8585-585858585858",
      "collision@example.com",
    );
    const second = invitation(
      "59595959-5959-4595-8595-595959595959",
      "collision@example.com",
    );
    for (const row of [first, second]) {
      row.role = "staff";
      row.created_at = new Date().toISOString();
    }
    await render([first, second]);

    expect(container.querySelector("#invite-email")).not.toBeNull();
    expect(container.textContent).not.toContain(
      `${window.location.origin}/invite/${first.token}`,
    );
    expect(
      sessionStorage.getItem("terroir:team-invites:create"),
    ).not.toBeNull();
  });

  it("retains the create key when the only matching refreshed row is stale", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: "idempotency_unavailable",
            message: "Invite result is temporarily unavailable.",
          },
        },
        { status: 503 },
      ),
    );
    await render();
    await openCreateModal("stale@example.com");
    await act(async () => {
      buttonWithText("Generate link").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledOnce());

    const stale = invitation(
      "60606060-6060-4060-8060-606060606060",
      "stale@example.com",
    );
    stale.role = "staff";
    stale.created_at = new Date(Date.now() - 60_000).toISOString();
    await render([stale]);

    expect(container.querySelector("#invite-email")).not.toBeNull();
    expect(container.textContent).not.toContain(
      `${window.location.origin}/invite/${stale.token}`,
    );
    expect(
      sessionStorage.getItem("terroir:team-invites:create"),
    ).not.toBeNull();
  });

  it("uses one per-invitation guard for conflicting resend and revoke controls", async () => {
    const row = invitation();
    let resolveResponse!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    await render([row]);
    const resend = container.querySelector(
      `[aria-label="Resend invitation for ${row.email}"]`,
    ) as HTMLButtonElement;
    const revoke = container.querySelector(
      `[aria-label="Revoke invitation for ${row.email}"]`,
    ) as HTMLButtonElement;

    await act(async () => {
      resend.click();
      resend.click();
      revoke.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce());
    expect(resend.disabled).toBe(true);
    expect(revoke.disabled).toBe(true);
    expect(mockConfirm).not.toHaveBeenCalled();

    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`/api/team/invite/${row.id}/resend`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );

    await act(async () => {
      resolveResponse(
        Response.json(
          inviteResponse(
            invitation(
              "66666666-6666-4666-8666-666666666666",
              row.email ?? "",
            ),
          ),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledOnce());
    expect(resend.disabled).toBe(false);
    expect(revoke.disabled).toBe(false);
  });

  it("retains the same resend key after an ambiguous nested error", async () => {
    const row = invitation(
      "77777777-7777-4777-8777-777777777777",
    );
    mockFetch
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "idempotency_outcome_unknown",
              message: "The resend result is unknown.",
            },
          },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          inviteResponse(
            invitation(
              "88888888-8888-4888-8888-888888888888",
              row.email ?? "",
            ),
          ),
        ),
      );
    await render([row]);
    const resend = container.querySelector(
      `[aria-label="Resend invitation for ${row.email}"]`,
    ) as HTMLButtonElement;

    await act(async () => {
      resend.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "The resend result is unknown.",
      );
    });
    const firstKey = new Headers(
      (mockFetch.mock.calls[0]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");

    await act(async () => {
      resend.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const secondKey = new Headers(
      (mockFetch.mock.calls[1]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");

    expect(secondKey).toBe(firstKey);
  });

  it("surfaces deterministic revoke 404s and releases the completed key", async () => {
    const row = invitation(
      "99999999-9999-4999-8999-999999999999",
    );
    const notFound = () =>
      Response.json(
        {
          error: {
            code: "not_found",
            message: "Invitation not found.",
          },
        },
        { status: 404 },
      );
    mockFetch
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(notFound());
    await render([row]);
    const revoke = container.querySelector(
      `[aria-label="Revoke invitation for ${row.email}"]`,
    ) as HTMLButtonElement;

    await act(async () => {
      revoke.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Invitation not found.",
      );
    });
    const firstKey = new Headers(
      (mockFetch.mock.calls[0]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");

    await act(async () => {
      revoke.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const secondKey = new Headers(
      (mockFetch.mock.calls[1]?.[1] as RequestInit).headers,
    ).get("Idempotency-Key");

    expect(secondKey).not.toBe(firstKey);
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });
});

describe("team member idempotency callers", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockConfirm.mockClear();
    sessionStorage.clear();
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
        <StrictMode>
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
          />
        </StrictMode>,
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
