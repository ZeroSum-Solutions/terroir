import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  router: { refresh: vi.fn() },
}));

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mocks.getAuthContext(...args),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
}));
vi.mock("../member-analytics-section", () => ({
  MemberAnalyticsSection: () => "member-analytics-section",
}));

const { default: TeamPage } = await import("./page");

type QueryResult = { data: unknown[] | null; error: unknown };

function makeSupabase(results: Record<string, QueryResult>) {
  const from = vi.fn((table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      order: () => chain,
      then: (
        resolve: (value: QueryResult) => unknown,
        reject?: (reason: unknown) => unknown,
      ) =>
        Promise.resolve(
          results[table] ?? { data: [], error: null },
        ).then(resolve, reject),
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
  beforeEach(() => vi.clearAllMocks());

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
    expect(container.textContent).toContain("Pending invitations (1)");
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
