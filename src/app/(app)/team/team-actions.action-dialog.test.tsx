import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const { TeamActions } = await import("./team-actions");

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

beforeEach(() => {
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
});

describe("TeamActions destructive confirmations", () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    vi.unstubAllGlobals();
    refresh.mockClear();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  it("cancels member removal, then blocks duplicate/close while its request is busy", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mountTeam();

    await click(buttonByLabel(container, "Remove Member Example"));
    expect(fetchMock).not.toHaveBeenCalled();
    let dialog = dialogByTitle(container, "Remove member");
    expect(dialog).toBeDefined();
    await click(button(dialog!, "Cancel"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dialogByTitle(container, "Remove member")).toBeUndefined();

    await click(buttonByLabel(container, "Remove Member Example"));
    dialog = dialogByTitle(container, "Remove member")!;
    await click(button(dialog, "Remove member"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/team/members/membership-2", {
      method: "DELETE",
    });
    dialog = dialogByTitle(container, "Remove member")!;
    expect(button(dialog, "Remove member").disabled).toBe(true);
    await click(button(dialog, "Cancel"));
    pressEscape();
    await mouseDown(container.querySelector<HTMLElement>('[data-action-dialog-backdrop="true"]')!);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(dialogByTitle(container, "Remove member")).toBeDefined();

    await act(async () => {
      pending.resolve(okResponse());
      await pending.promise;
    });
    expect(dialogByTitle(container, "Remove member")).toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("retains a failed member target and uses the existing error for retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "Cannot remove the last manager." }, 409))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mountTeam();

    await click(buttonByLabel(container, "Remove Member Example"));
    await click(button(dialogByTitle(container, "Remove member")!, "Remove member"));
    expect(dialogByTitle(container, "Remove member")).toBeDefined();
    expect(dialogByTitle(container, "Remove member")!.querySelector('[role="alert"]')?.textContent).toContain(
      "Cannot remove the last manager.",
    );

    await click(button(dialogByTitle(container, "Remove member")!, "Remove member"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dialogByTitle(container, "Remove member")).toBeUndefined();
  });

  it("cancels invitation revocation, then sends the captured invitation once", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mountTeam();

    await click(buttonByLabel(container, "Revoke invitation for guest@example.com"));
    expect(fetchMock).not.toHaveBeenCalled();
    let dialog = dialogByTitle(container, "Revoke invitation");
    expect(dialog).toBeDefined();
    expect(dialog!.textContent).toContain("guest@example.com");
    await click(button(dialog!, "Cancel"));
    expect(fetchMock).not.toHaveBeenCalled();

    await click(buttonByLabel(container, "Revoke invitation for guest@example.com"));
    dialog = dialogByTitle(container, "Revoke invitation")!;
    await click(button(dialog, "Revoke invitation"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/team/invite/invitation-1", {
      method: "DELETE",
    });
    dialog = dialogByTitle(container, "Revoke invitation")!;
    expect(button(dialog, "Revoke invitation").disabled).toBe(true);

    await act(async () => {
      pending.resolve(okResponse());
      await pending.promise;
    });
    expect(dialogByTitle(container, "Revoke invitation")).toBeUndefined();
  });

  it("retains a failed invitation target and reports the existing retry error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "Invitation could not be revoked." }, 500))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mountTeam();

    await click(buttonByLabel(container, "Revoke invitation for guest@example.com"));
    await click(button(dialogByTitle(container, "Revoke invitation")!, "Revoke invitation"));
    expect(dialogByTitle(container, "Revoke invitation")).toBeDefined();
    expect(dialogByTitle(container, "Revoke invitation")!.querySelector('[role="alert"]')?.textContent).toContain(
      "Invitation could not be revoked.",
    );

    await click(button(dialogByTitle(container, "Revoke invitation")!, "Revoke invitation"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dialogByTitle(container, "Revoke invitation")).toBeUndefined();
  });

  async function mountTeam() {
    return mount(
      <TeamActions
        members={[
          {
            id: "membership-owner",
            user_id: "owner-user",
            name: "Owner Example",
            email: "owner@example.com",
            role: "owner",
            created_at: "2026-08-01T12:00:00.000Z",
          },
          {
            id: "membership-2",
            user_id: "member-user",
            name: "Member Example",
            email: "member@example.com",
            role: "staff",
            created_at: "2026-08-02T12:00:00.000Z",
          },
        ]}
        invitations={[
          {
            id: "invitation-1",
            token: "invite-token",
            role: "manager",
            email: "guest@example.com",
            expires_at: "2099-09-01T12:00:00.000Z",
            created_at: "2026-08-03T12:00:00.000Z",
          },
        ]}
        currentUserId="owner-user"
        restaurantName="Test Restaurant"
        canInvite
      />,
    );
  }

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

function dialogByTitle(root: ParentNode, title: string) {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (dialog) => dialog.querySelector("h2")?.textContent === title,
  );
}

function button(root: ParentNode, name: string) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === name,
  )!;
}

function buttonByLabel(root: ParentNode, label: string) {
  return root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function mouseDown(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

function okResponse() {
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
