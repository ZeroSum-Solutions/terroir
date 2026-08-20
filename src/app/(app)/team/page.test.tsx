import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
}));

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mocks.getAuthContext(...args),
}));
vi.mock("./member-analytics-section", () => ({
  MemberAnalyticsSection: () => "member-analytics-section",
}));

const { default: TeamPage } = await import("./page");

function makeSupabase() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    order: () => chain,
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: [], error: null }),
  };
  return { from: () => chain };
}

function authFor(userRole: string) {
  return {
    userRole,
    user: { id: `u-${userRole}` },
    restaurantId: "r-1",
    restaurantName: "House",
    supabase: makeSupabase(),
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
      return type.name === "MemberAnalyticsSection" ||
        String(type) === "member-analytics-section";
    }
  }
  return false;
}

describe("TeamPage", () => {
  beforeEach(() => vi.clearAllMocks());

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
