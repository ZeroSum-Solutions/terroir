import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ROLE_DESCRIPTIONS } from "@/lib/team/member-identities";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

const { TeamActions } = await import("./team-actions");

const UUID = "11111111-2222-4333-8444-555555555555";
const NOW = "2026-08-20T18:00:00.000Z";
const LATER = "2099-08-27T18:00:00.000Z";

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

describe("TeamActions", () => {
  const roots: Root[] = [];
  const clipboardWrite = vi.fn();

  beforeEach(() => {
    mocks.refresh.mockClear();
    clipboardWrite.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  it("renders recognizable identities in distinct lifecycle groups without UUID or token text", async () => {
    const { container } = await mountTeam();

    const headings = [...container.querySelectorAll("h2")].map(
      (node) => node.textContent,
    );
    expect(headings.some((text) => text?.startsWith("Members"))).toBe(true);
    expect(headings.some((text) => text?.startsWith("Pending"))).toBe(true);
    expect(container.textContent).toContain("Maria Santos");
    expect(container.textContent).toContain("maria@example.com");
    expect(container.textContent).toContain("(You)");
    expect(container.textContent).toContain(ROLE_DESCRIPTIONS.owner);
    expect(container.textContent).toContain(ROLE_DESCRIPTIONS.manager);
    expect(container.textContent).toContain(ROLE_DESCRIPTIONS.staff);
    expect(container.textContent).toContain("pending@example.com");
    expect(container.textContent).not.toContain("secret-token");
    expect(container.textContent).not.toContain(UUID.slice(0, 8));

    expect(button(container, "Create invite link").className).toContain(
      "min-h-11",
    );
    expect(
      selectByLabel(container, "Change role for Lee Chen").className,
    ).toContain("min-h-11");
    expect(
      buttonByLabel(container, "Remove Lee Chen").className,
    ).toContain("min-h-11");
    expect(
      buttonByLabel(
        container,
        "Copy invite link for pending@example.com",
      ).className,
    ).toContain("min-h-11");
    const revoke = buttonByLabel(
      container,
      "Revoke invitation for pending@example.com",
    );
    expect(revoke.className).toContain("min-h-11");
    expect(revoke.className).toContain("min-w-11");
  });

  it("preserves role change, removal, copy-link, and revocation behavior", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mountTeam();

    const roleSelect = selectByLabel(container, "Change role for Lee Chen");
    await change(roleSelect, "staff");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/team/members/member-2", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "staff" }),
    });

    await click(buttonByLabel(container, "Remove Lee Chen"));
    await click(button(dialogByTitle(container, "Remove member"), "Remove member"));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/team/members/member-2", {
      method: "DELETE",
    });

    await click(
      buttonByLabel(container, "Copy invite link for pending@example.com"),
    );
    expect(clipboardWrite).toHaveBeenCalledOnce();
    expect(String(clipboardWrite.mock.calls[0]?.[0])).toMatch(
      /\/invite\/secret-token$/,
    );

    await click(
      buttonByLabel(container, "Revoke invitation for pending@example.com"),
    );
    await click(
      button(dialogByTitle(container, "Revoke invitation"), "Revoke invitation"),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/team/invite/invitation-1",
      { method: "DELETE" },
    );
  });

  it("uses the same role descriptions and 44px controls in the invite flow", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ inviteUrl: "http://localhost/invite/generated-token" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mountTeam();

    await click(button(container, "Create invite link"));
    const modal = dialogByTitle(container, "Invite team member");
    const inviteRole = selectByLabel(modal, "Role");
    expect(inviteRole.className).toContain("min-h-11");
    expect(modal.textContent).toContain(ROLE_DESCRIPTIONS.staff);

    await change(inviteRole, "manager");
    expect(modal.textContent).toContain(ROLE_DESCRIPTIONS.manager);

    expect(button(modal, "Cancel").className).toContain("min-h-11");
    expect(button(modal, "Generate link").className).toContain("min-h-11");
    await input(inputByLabel(modal, "Email"), "guest@example.com");
    await click(button(modal, "Generate link"));

    expect(fetchMock).toHaveBeenCalledWith("/api/team/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "guest@example.com", role: "manager" }),
    });
    expect(button(modal, "Done").className).toContain("min-h-11");
    expect(button(modal, "Copy link").className).toContain("min-h-11");
  });

  it("does not render or copy a pending link when its token is absent", async () => {
    const { container } = await mountTeam({ includeInvitationToken: false });

    expect(
      container.querySelector(
        'button[aria-label="Copy invite link for pending@example.com"]',
      ),
    ).toBeNull();
    expect(
      buttonByLabel(
        container,
        "Revoke invitation for pending@example.com",
      ),
    ).not.toBeNull();
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  async function mountTeam({
    includeInvitationToken = true,
  }: {
    includeInvitationToken?: boolean;
  } = {}) {
    return mount(
      <TeamActions
        members={[
          {
            id: "member-owner",
            user_id: UUID,
            name: "Maria Santos",
            email: "maria@example.com",
            role: "owner",
            created_at: NOW,
          },
          {
            id: "member-2",
            user_id: "user-lee",
            name: "Lee Chen",
            email: "lee@example.com",
            role: "manager",
            created_at: NOW,
          },
          {
            id: "member-3",
            user_id: "user-pat",
            name: "Pat Jones",
            email: "pat@example.com",
            role: "staff",
            created_at: NOW,
          },
        ]}
        invitations={[
          {
            id: "invitation-1",
            token: includeInvitationToken ? "secret-token" : undefined,
            email: "pending@example.com",
            role: "staff",
            created_at: NOW,
            expires_at: LATER,
          },
        ]}
        currentUserId={UUID}
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

function button(root: ParentNode, name: string) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === name,
  )!;
}

function buttonByLabel(root: ParentNode, label: string) {
  return root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}

function selectByLabel(root: ParentNode, label: string) {
  const labelled = root.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  );
  if (labelled) return labelled;
  const labelNode = [...root.querySelectorAll("label")].find(
    (node) => node.textContent?.trim() === label,
  );
  return root.querySelector<HTMLSelectElement>(`#${labelNode?.htmlFor}`)!;
}

function inputByLabel(root: ParentNode, label: string) {
  const labelNode = [...root.querySelectorAll("label")].find(
    (node) => node.textContent?.trim() === label,
  );
  return root.querySelector<HTMLInputElement>(`#${labelNode?.htmlFor}`)!;
}

function dialogByTitle(root: ParentNode, title: string) {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (dialog) =>
      dialog.querySelector("h2, h3")?.textContent?.trim() === title,
  )!;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function change(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function okResponse() {
  return jsonResponse({});
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
