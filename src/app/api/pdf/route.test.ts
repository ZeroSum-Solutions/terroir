import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

/**
 * /api/pdf route tests.
 *
 * Focus: once requireMembership gates the handler and every query is scoped
 * by `.eq("restaurant_id", ctx.restaurantId)`, a user authed against
 * restaurant A cannot render a PDF for a wine-list belonging to restaurant B
 * — they get a 404 (not 403) so the existence of the other restaurant's list
 * is never revealed.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────

// requireMembership returns the shape { supabase, user, restaurantId, role }.
// We stub it rather than wire through the whole supabase+cookies chain.
const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

// Capture the .eq() calls the handler issues so we can assert restaurant_id
// scoping. The chain: .from(...).select(...).eq(...).eq(...).single()
const mockEq = vi.fn();
const mockSingle = vi.fn();

function buildSupabaseStub() {
  return {
    from: () => ({
      select: () => ({
        eq: (...a: unknown[]) => {
          mockEq(...a);
          return {
            eq: (...b: unknown[]) => {
              mockEq(...b);
              return { single: mockSingle };
            },
          };
        },
      }),
    }),
  };
}

// Puppeteer would otherwise try to launch a real browser in the test runner.
const mockPdf = vi.fn();
const mockNewPage = vi.fn(async () => ({
  setContent: vi.fn(async () => undefined),
  pdf: mockPdf,
}));
const mockClose = vi.fn(async () => undefined);
vi.mock("puppeteer", () => ({
  default: {
    launch: vi.fn(async () => ({
      newPage: mockNewPage,
      close: mockClose,
    })),
  },
}));

vi.mock("@/lib/wine-list/templates", () => ({
  renderTemplate: () => "<html>stub</html>",
}));

const { POST } = await import("./route");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/pdf", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/pdf restaurant scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPdf.mockResolvedValue(Buffer.from("%PDF-1.4"));
  });

  it("returns 404 when the list belongs to another restaurant", async () => {
    // User is a member of restaurant A. The DB row for listId=list-b exists
    // but belongs to restaurant B, so the `.eq("restaurant_id", "A")` filter
    // makes .single() return no row.
    mockRequireMembership.mockResolvedValue({
      supabase: buildSupabaseStub(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    mockSingle.mockResolvedValue({ data: null, error: null });

    const res = await POST(makeRequest({ listId: "list-b" }));

    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(404);
    // The handler must have scoped the query by restaurant_id — this is the
    // whole point of the bundle, so we assert it loudly.
    expect(mockEq).toHaveBeenCalledWith("restaurant_id", "restaurant-A");
    // Puppeteer must never launch on a miss.
    expect(mockNewPage).not.toHaveBeenCalled();
  });

  it("renders a PDF when the list belongs to the authed restaurant", async () => {
    mockRequireMembership.mockResolvedValue({
      supabase: buildSupabaseStub(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    mockSingle.mockResolvedValue({
      data: {
        name: "House List",
        template: "classic",
        restaurant_id: "restaurant-A",
        restaurants: { name: "Le Test" },
        wine_list_sections: [],
      },
      error: null,
    });

    const res = await POST(makeRequest({ listId: "list-a" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(mockEq).toHaveBeenCalledWith("restaurant_id", "restaurant-A");
  });

  it("propagates the 403 from requireMembership when the user has no memberships", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "No restaurant membership found." }, { status: 403 }),
    );

    const res = await POST(makeRequest({ listId: "list-a" }));

    expect(res.status).toBe(403);
    expect(mockEq).not.toHaveBeenCalled();
    expect(mockNewPage).not.toHaveBeenCalled();
  });

  it("returns 400 when listId is missing", async () => {
    mockRequireMembership.mockResolvedValue({
      supabase: buildSupabaseStub(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });
});
