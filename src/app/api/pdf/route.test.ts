import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

/**
 * /api/pdf route tests.
 *
 * BND-003 (ARCH-002): once requireMembership gates the handler and every
 * query is scoped by `.eq("restaurant_id", ctx.restaurantId)`, a user
 * authed against restaurant A cannot render a PDF for a wine-list
 * belonging to restaurant B — they get a 404 (not 403) so the existence
 * of the other restaurant's list is never revealed.
 *
 * BND-004: the Puppeteer call must use `waitUntil: "domcontentloaded"`
 * with bounded timeouts, and the rendered HTML must not contain external
 * font-CDN hostnames.
 *
 * BND-010: characterization coverage — happy path, 401/403, bad body,
 * supabase fetch error (→ 404), puppeteer 500, cross-tenant 404.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────

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
const mockSetContent = vi.fn(async () => undefined);
const mockNewPage = vi.fn(async () => ({
  setContent: mockSetContent,
  pdf: mockPdf,
}));
const mockClose = vi.fn(async () => undefined);
const mockLaunch = vi.fn(async () => ({
  newPage: mockNewPage,
  close: mockClose,
}));
vi.mock("puppeteer", () => ({
  default: {
    launch: () => mockLaunch(),
  },
}));

vi.mock("@/lib/wine-list/templates", () => ({
  renderTemplate: () => "<html>stub</html>",
}));

const { POST } = await import("./route");

const LIST_A = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const LIST_B = "b1b2c3d4-e5f6-4789-8abc-def012345678";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeRequest(body: unknown, opts: { json?: boolean } = {}) {
  if (opts.json === false) {
    return new Request("http://localhost/api/pdf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  }
  return new Request("http://localhost/api/pdf", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function okListRow() {
  return {
    data: {
      name: "House List",
      template: "classic",
      restaurant_id: "restaurant-A",
      restaurants: { name: "Le Test" },
      wine_list_sections: [],
    },
    error: null,
  };
}

function authedAsA() {
  mockRequireMembership.mockResolvedValue({
    supabase: buildSupabaseStub(),
    user: { id: "u1" },
    restaurantId: "restaurant-A",
    role: "owner",
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/pdf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPdf.mockResolvedValue(Buffer.from("%PDF-1.4"));
  });

  // ── Cross-tenant scoping (BND-003) ──────────────────────────────────

  it("returns 404 when the list belongs to another restaurant", async () => {
    authedAsA();
    mockSingle.mockResolvedValue({ data: null, error: null });

    const res = await POST(makeRequest({ listId: LIST_B }));

    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(404);
    expect(mockEq).toHaveBeenCalledWith("restaurant_id", "restaurant-A");
    expect(mockNewPage).not.toHaveBeenCalled();
  });

  it("returns 404 for the PostgREST no-row code", async () => {
    authedAsA();
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: "PGRST116", message: "no rows" },
    });

    const res = await POST(makeRequest({ listId: LIST_B }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "Wine list not found." },
    });
  });

  it("redacts a real list-fetch failure instead of reporting 404", async () => {
    authedAsA();
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: "XX000", message: "super-secret database failure" },
    });

    const res = await POST(makeRequest({ listId: LIST_A }));
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    expect(text).not.toContain("super-secret");
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("renders a PDF when the list belongs to the authed restaurant", async () => {
    authedAsA();
    mockSingle.mockResolvedValue(okListRow());

    const res = await POST(makeRequest({ listId: LIST_A }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("House List.pdf");
    expect(mockEq).toHaveBeenCalledWith("restaurant_id", "restaurant-A");
  });

  // ── Puppeteer wiring (BND-004) ──────────────────────────────────────

  it("calls puppeteer with domcontentloaded + explicit timeouts (BND-004)", async () => {
    authedAsA();
    mockSingle.mockResolvedValue(okListRow());

    await POST(makeRequest({ listId: LIST_A }));

    expect(mockSetContent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      }),
    );
    expect(mockPdf).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it("renders without ever reaching out to Google Fonts (BND-004)", async () => {
    authedAsA();
    mockSingle.mockResolvedValue(okListRow());

    await POST(makeRequest({ listId: LIST_A }));

    const call = mockSetContent.mock.calls[0] as unknown as [string, unknown];
    const html = call[0];
    expect(typeof html).toBe("string");
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
  });

  // ── Auth ────────────────────────────────────────────────────────────

  it("propagates the 403 from requireMembership when the user has no memberships", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json(
        { error: "No restaurant membership found." },
        { status: 403 },
      ),
    );

    const res = await POST(makeRequest({ listId: LIST_A }));

    expect(res.status).toBe(403);
    expect(mockEq).not.toHaveBeenCalled();
    expect(mockNewPage).not.toHaveBeenCalled();
  });

  it("propagates 401 from requireMembership and never launches puppeteer", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const res = await POST(makeRequest({ listId: LIST_A }));

    expect(res.status).toBe(401);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  // ── Bad body ────────────────────────────────────────────────────────

  it("returns 400 when listId is missing", async () => {
    authedAsA();

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("returns 400 when the request body is not JSON", async () => {
    authedAsA();

    const res = await POST(makeRequest(null, { json: false }));

    expect(res.status).toBe(400);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  // ── Upstream failures ───────────────────────────────────────────────

  it("returns 500 with code pdf_generation_failed when puppeteer throws", async () => {
    authedAsA();
    mockSingle.mockResolvedValue(okListRow());
    mockPdf.mockRejectedValue(new Error("headless crashed"));

    const res = await POST(makeRequest({ listId: LIST_A }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("pdf_generation_failed");
    // Even though rendering failed, we must close the browser.
    expect(mockClose).toHaveBeenCalled();
  });
});
