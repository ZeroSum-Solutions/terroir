import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  getAuthContext: vi.fn(),
  resolveMemberIdentities: vi.fn(),
  events: [] as string[],
  router: { refresh: vi.fn() },
}));

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mocks.getAuthContext(...args),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
}));
vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => mocks.createServiceRoleClient(),
}));
vi.mock("@/lib/team/member-identities", () => ({
  resolveMemberIdentities: (...args: unknown[]) =>
    mocks.resolveMemberIdentities(...args),
  ROLE_DESCRIPTIONS: {
    owner: "Full access, including team access.",
    manager: "Manage inventory and wine lists, publish menus, and reconcile.",
    staff: "Scan invoices, record pours, and view restaurant data.",
  },
}));
vi.mock("../member-analytics-section", () => ({
  MemberAnalyticsSection: () => "member-analytics-section",
}));

const { default: TeamPage } = await import("./page");

type QueryResult = { data: unknown[] | null; error: unknown };

function makeSupabase(results: Record<string, QueryResult>) {
  const from = vi.fn((table: string) => {
    let result = results[table] ?? { data: [], error: null };
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        if (table === "memberships") {
          mocks.events.push(`eq:${column}:${String(value)}`);
        }
        if (
          result.data?.some(
            (row) =>
              typeof row === "object" &&
              row !== null &&
              column in row,
          )
        ) {
          result = {
            ...result,
            data: result.data.filter(
              (row) =>
                typeof row === "object" &&
                row !== null &&
                (row as Record<string, unknown>)[column] === value,
            ),
          };
        }
        return chain;
      },
      is: () => chain,
      order: () => chain,
      then: (
        resolve: (value: QueryResult) => unknown,
        reject?: (reason: unknown) => unknown,
      ) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  });
  return { from };
}

function authFor(
  userRole: string,
  results: Record<string, QueryResult> = {},
) {
  return {
    userRole,
    user: { id: `u-${userRole}` },
    restaurantId: "r-1",
    restaurantName: "House",
    supabase: makeSupabase(results),
  };
}

function containsAnalyticsSection(node: unknown): boolean {
  if (node === "member-analytics-section") return true;
  if (Array.isArray(node)) return node.some(containsAnalyticsSection);
  if (node && typeof node === "object") {
    const props = (node as { props?: { children?: unknown } }).props;
    if (props && "children" in props) {
      return containsAnalyticsSection(props.children);
    }
    const type = (node as { type?: unknown }).type;
    if (typeof type === "function") {
      return (
        type.name === "MemberAnalyticsSection" ||
        String(type) === "member-analytics-section"
      );
    }
  }
  return false;
}

function renderPage(node: React.ReactNode) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(node);
  return container;
}

describe("TeamPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.createServiceRoleClient.mockReturnValue({ auth: { admin: {} } });
    mocks.resolveMemberIdentities.mockImplementation(
      async (_admin: unknown, userIds: string[]) => {
        mocks.events.push(`resolve:${userIds.join(",")}`);
        return new Map();
      },
    );
  });

  it("enriches only active-restaurant membership IDs", async () => {
    mocks.getAuthContext.mockResolvedValue(
      authFor("owner", {
        memberships: {
          data: [
            {
              id: "m-1",
              user_id: "u-1",
              restaurant_id: "r-1",
              role: "manager",
              created_at: "2026-08-20T18:00:00.000Z",
            },
            {
              id: "m-2",
              user_id: "other-tenant-user",
              restaurant_id: "r-2",
              role: "owner",
              created_at: "2026-08-20T18:00:00.000Z",
            },
          ],
          error: null,
        },
        invitations: { data: [], error: null },
      }),
    );
    mocks.resolveMemberIdentities.mockImplementation(
      async (_admin: unknown, userIds: string[]) => {
        mocks.events.push(`resolve:${userIds.join(",")}`);
        return new Map([
          [
            "u-1",
            {
              userId: "u-1",
              name: "Maria Santos",
              email: "maria@example.com",
            },
          ],
        ]);
      },
    );

    const tree = await TeamPage();
    const props = findTeamActionsProps(tree);

    expect(mocks.events).toEqual(["eq:restaurant_id:r-1", "resolve:u-1"]);
    expect(mocks.resolveMemberIdentities).toHaveBeenCalledWith(
      expect.anything(),
      ["u-1"],
    );
    expect(props.members).toHaveLength(1);
    expect(props.members[0]).toMatchObject({
      name: "Maria Santos",
      email: "maria@example.com",
    });
    expect(findMemberAnalyticsProps(tree).identities).toEqual({
      "u-1": { name: "Maria Santos", email: "maria@example.com" },
    });
  });

  it("uses neutral identity text when the admin client is unavailable", async () => {
    mocks.createServiceRoleClient.mockReturnValue(null);
    mocks.getAuthContext.mockResolvedValue(
      authFor("owner", {
        memberships: {
          data: [
            {
              id: "m-1",
              user_id: "u-1",
              role: "manager",
              created_at: "2026-08-20T18:00:00.000Z",
            },
          ],
          error: null,
        },
        invitations: { data: [], error: null },
      }),
    );

    const props = findTeamActionsProps(await TeamPage());

    expect(mocks.resolveMemberIdentities).not.toHaveBeenCalled();
    expect(props.members[0]).toMatchObject({
      name: "Team member",
      email: "Email unavailable",
    });
  });

  it("omits invitation tokens from non-owner client props", async () => {
    mocks.getAuthContext.mockResolvedValue(
      authFor("manager", {
        memberships: { data: [], error: null },
        invitations: {
          data: [
            {
              id: "invite-1",
              token: "manager-must-not-receive-this-token",
              role: "staff",
              email: "pending@example.com",
              expires_at: "2099-08-27T18:00:00.000Z",
              accepted_at: null,
              created_at: "2026-08-20T18:00:00.000Z",
            },
          ],
          error: null,
        },
      }),
    );

    const props = findTeamActionsProps(await TeamPage());

    expect(props.canInvite).toBe(false);
    expect(props.invitations[0]).toMatchObject({
      id: "invite-1",
      email: "pending@example.com",
      role: "staff",
    });
    expect(props.invitations[0]).not.toHaveProperty("token");
  });

  it("keeps invitation tokens in owner client props for copy-link actions", async () => {
    mocks.getAuthContext.mockResolvedValue(
      authFor("owner", {
        memberships: { data: [], error: null },
        invitations: {
          data: [
            {
              id: "invite-1",
              token: "owner-copy-token",
              role: "staff",
              email: "pending@example.com",
              expires_at: "2099-08-27T18:00:00.000Z",
              accepted_at: null,
              created_at: "2026-08-20T18:00:00.000Z",
            },
          ],
          error: null,
        },
      }),
    );

    const props = findTeamActionsProps(await TeamPage());

    expect(props.canInvite).toBe(true);
    expect(props.invitations[0]).toMatchObject({ token: "owner-copy-token" });
  });

  it("throws a memberships query failure instead of presenting an empty roster", async () => {
    const error = new Error("forced query failure");
    mocks.getAuthContext.mockResolvedValue(
      authFor("owner", {
        memberships: { data: null, error },
        invitations: { data: [], error: null },
      }),
    );

    await expect(TeamPage()).rejects.toBe(error);
  });

  it("throws an invitations query failure instead of hiding the pending lifecycle", async () => {
    const error = new Error("forced query failure");
    mocks.getAuthContext.mockResolvedValue(
      authFor("owner", {
        memberships: { data: [], error: null },
        invitations: { data: null, error },
      }),
    );

    await expect(TeamPage()).rejects.toBe(error);
  });

  it("renders a genuine zero-member outcome with an accessible owner recovery action", async () => {
    mocks.getAuthContext.mockResolvedValue(
      authFor("owner", {
        memberships: { data: [], error: null },
        invitations: { data: [], error: null },
      }),
    );

    const container = renderPage(await TeamPage());
    const emptyPanel = container.querySelector(
      '[aria-label="No team members yet"]',
    );
    const inviteButton = [...(emptyPanel?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Create invite link",
    );

    expect(emptyPanel).not.toBeNull();
    expect(inviteButton?.className).toContain("h-11");
  });

  it("renders the member empty panel and pending invitations as independent sections", async () => {
    mocks.getAuthContext.mockResolvedValue(
      authFor("owner", {
        memberships: { data: [], error: null },
        invitations: {
          data: [
            {
              id: "invite-1",
              token: "pending-token",
              role: "staff",
              email: "new.member@example.com",
              expires_at: "2099-08-27T18:00:00.000Z",
              accepted_at: null,
              created_at: "2026-08-20T18:00:00.000Z",
            },
          ],
          error: null,
        },
      }),
    );

    const container = renderPage(await TeamPage());

    expect(
      container.querySelector('[aria-label="No team members yet"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Pending (1)");
    expect(container.textContent).toContain("new.member@example.com");
  });

  it("EV-7.4: staff still see the roster but never the analytics section", async () => {
    mocks.getAuthContext.mockResolvedValue(authFor("staff"));
    const tree = await TeamPage();
    expect(containsAnalyticsSection(tree)).toBe(false);
  });

  it("EV-7.4: managers see the analytics section", async () => {
    mocks.getAuthContext.mockResolvedValue(authFor("manager"));
    const tree = await TeamPage();
    expect(containsAnalyticsSection(tree)).toBe(true);
  });
});

function findTeamActionsProps(node: unknown): {
  members: Array<Record<string, unknown>>;
  invitations: Array<Record<string, unknown>>;
  canInvite: boolean;
} {
  if (node && typeof node === "object") {
    const props = (
      node as {
        props?: {
          members?: Array<Record<string, unknown>>;
          invitations?: Array<Record<string, unknown>>;
          canInvite?: boolean;
          children?: unknown;
        };
      }
    ).props;
    if (Array.isArray(props?.members)) {
      return {
        members: props.members,
        invitations: props.invitations ?? [],
        canInvite: props.canInvite ?? false,
      };
    }
    if (props && "children" in props) {
      const children = Array.isArray(props.children)
        ? props.children
        : [props.children];
      for (const child of children) {
        try {
          return findTeamActionsProps(child);
        } catch {
          // Keep searching sibling elements.
        }
      }
    }
  }
  throw new Error("TeamActions props not found");
}

function findMemberAnalyticsProps(node: unknown): {
  identities: Record<string, { name: string; email: string }>;
} {
  if (node && typeof node === "object") {
    const props = (
      node as {
        props?: {
          identities?: Record<string, { name: string; email: string }>;
          children?: unknown;
        };
      }
    ).props;
    if (props?.identities) {
      return { identities: props.identities };
    }
    if (props && "children" in props) {
      const children = Array.isArray(props.children)
        ? props.children
        : [props.children];
      for (const child of children) {
        try {
          return findMemberAnalyticsProps(child);
        } catch {
          // Keep searching sibling elements.
        }
      }
    }
  }
  throw new Error("MemberAnalyticsSection props not found");
}
