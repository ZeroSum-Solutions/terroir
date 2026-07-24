import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequireMembership = vi.fn();
const mockRequireRole = vi.fn();
const mockCaptureException = vi.fn();
const mockRecordPour = vi.fn();
const mockUndoLastPour = vi.fn();
const mockCloseOpenBottle = vi.fn();
const mockReconcileOpenBottles = vi.fn();
const mockGenerateWineListPdf = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/domains/pours/pour-service", () => {
  class PourNoInventoryError extends Error {}
  class PourForbiddenError extends Error {}
  class PourNotFoundError extends Error {}
  class PourAlreadyClosedError extends Error {}
  class PourRpcError extends Error {}
  return {
    PourNoInventoryError,
    PourForbiddenError,
    PourNotFoundError,
    PourAlreadyClosedError,
    PourRpcError,
    recordPour: (...args: unknown[]) => mockRecordPour(...args),
    undoLastPour: (...args: unknown[]) => mockUndoLastPour(...args),
    closeOpenBottle: (...args: unknown[]) => mockCloseOpenBottle(...args),
  };
});
vi.mock("@/domains/cellar/reconcile-service", () => {
  class ReconcileExceedsSizeError extends Error {}
  class ReconcileForbiddenError extends Error {}
  class ReconcileRpcError extends Error {}
  return {
    ReconcileExceedsSizeError,
    ReconcileForbiddenError,
    ReconcileRpcError,
    reconcileOpenBottles: (...args: unknown[]) =>
      mockReconcileOpenBottles(...args),
  };
});
vi.mock("@/domains/wine-lists/wine-list-pdf-service", () => {
  class WineListPdfGenerationError extends Error {}
  class WineListPdfNotFoundError extends Error {}
  return {
    WineListPdfGenerationError,
    WineListPdfNotFoundError,
    generateWineListPdf: (...args: unknown[]) =>
      mockGenerateWineListPdf(...args),
  };
});

const { GET: getPourInsights } = await import("./insights/pour/route");
const { POST: openBottle } = await import("./open-bottles/route");
const { POST: closeBottle } =
  await import("./open-bottles/[id]/close/route");
const { POST: generatePdf } = await import("./pdf/route");
const { POST: recordPour } = await import("./pour/route");
const { POST: undoPour } = await import("./pour/undo/route");
const { POST: reconcile } = await import("./reconcile/route");

const VALID_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";

function request(path: string, body: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function allow() {
  const supabase = { from: vi.fn() };
  const auth = {
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "manager",
  };
  mockRequireMembership.mockResolvedValue(auth);
  mockRequireRole.mockResolvedValue(auth);
  return supabase;
}

async function expectNested500(response: Response) {
  const text = await response.text();
  expect(response.status).toBe(500);
  expect(JSON.parse(text)).toEqual({
    error: {
      code: "internal_error",
      message: "Internal server error.",
    },
  });
  expect(text).not.toContain("super-secret");
}

const boundaryRoutes = [
  {
    name: "pour insights",
    invoke: () =>
      getPourInsights(
        new NextRequest("http://localhost/api/insights/pour?range=30d"),
      ),
  },
  {
    name: "open bottle",
    invoke: () =>
      openBottle(
        request("/api/open-bottles", JSON.stringify({ wine_id: VALID_ID })),
      ),
  },
  {
    name: "close bottle",
    invoke: () =>
      closeBottle({} as NextRequest, {
        params: Promise.resolve({ id: VALID_ID }),
      }),
  },
  {
    name: "PDF",
    invoke: () =>
      generatePdf(
        request("/api/pdf", JSON.stringify({ listId: VALID_ID })),
      ),
  },
  {
    name: "pour",
    invoke: () =>
      recordPour(
        request(
          "/api/pour",
          JSON.stringify({ wine_id: VALID_ID, ml: 148 }),
        ),
      ),
  },
  {
    name: "pour undo",
    invoke: () =>
      undoPour(
        request("/api/pour/undo", JSON.stringify({ wine_id: VALID_ID })),
      ),
  },
  {
    name: "reconcile",
    invoke: () =>
      reconcile(
        request(
          "/api/reconcile",
          JSON.stringify({
            entries: [{ wine_id: VALID_ID, new_remaining_ml: 375 }],
          }),
        ),
      ),
  },
] as const;

describe("pour/open/PDF shared boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(boundaryRoutes)(
    "redacts an unexpected auth failure for $name",
    async ({ invoke }) => {
      const error = new Error("super-secret auth failure");
      mockRequireMembership.mockRejectedValue(error);
      mockRequireRole.mockRejectedValue(error);

      await expectNested500(await invoke());
    },
  );

  it.each(boundaryRoutes)(
    "preserves auth-denial response identity for $name",
    async ({ invoke }) => {
      const denial = NextResponse.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status: 401 },
      );
      mockRequireMembership.mockResolvedValue(denial);
      mockRequireRole.mockResolvedValue(denial);

      expect(await invoke()).toBe(denial);
      expect(mockRecordPour).not.toHaveBeenCalled();
      expect(mockUndoLastPour).not.toHaveBeenCalled();
      expect(mockCloseOpenBottle).not.toHaveBeenCalled();
      expect(mockReconcileOpenBottles).not.toHaveBeenCalled();
      expect(mockGenerateWineListPdf).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "open bottle",
      invoke: () => openBottle(request("/api/open-bottles", "{not-json")),
    },
    {
      name: "PDF",
      invoke: () => generatePdf(request("/api/pdf", "{not-json")),
    },
    {
      name: "pour",
      invoke: () => recordPour(request("/api/pour", "{not-json")),
    },
    {
      name: "pour undo",
      invoke: () => undoPour(request("/api/pour/undo", "{not-json")),
    },
    {
      name: "reconcile",
      invoke: () => reconcile(request("/api/reconcile", "{not-json")),
    },
  ])(
    "returns invalid_json before business work for $name",
    async ({ invoke }) => {
      const supabase = allow();

      const response = await invoke();

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "invalid_json", message: "Invalid JSON." },
      });
      expect(supabase.from).not.toHaveBeenCalled();
      expect(mockRecordPour).not.toHaveBeenCalled();
      expect(mockUndoLastPour).not.toHaveBeenCalled();
      expect(mockReconcileOpenBottles).not.toHaveBeenCalled();
      expect(mockGenerateWineListPdf).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid bottle UUID before the close service", async () => {
    allow();

    const response = await closeBottle({} as NextRequest, {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: [{ path: ["id"] }],
      },
    });
    expect(mockCloseOpenBottle).not.toHaveBeenCalled();
  });

  it("rejects an invalid PDF schema before generation", async () => {
    allow();

    const response = await generatePdf(
      request(
        "/api/pdf",
        JSON.stringify({
          listId: "not-a-uuid",
          template: "invented",
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: [
          { path: ["listId"] },
          { path: ["template"] },
        ],
      },
    });
    expect(mockGenerateWineListPdf).not.toHaveBeenCalled();
  });

  it("rejects duplicate pour-insight query input before database access", async () => {
    const supabase = allow();

    const response = await getPourInsights(
      new NextRequest(
        "http://localhost/api/insights/pour?range=7d&range=30d",
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: [{ path: ["range"] }],
      },
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
