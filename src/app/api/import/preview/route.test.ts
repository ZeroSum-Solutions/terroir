import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { __resetRateLimitForTests } from "@/lib/api/rate-limit";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const mockBuildImportPreview = vi.fn();
vi.mock("@/domains/import/preview-service", () => ({
  buildImportPreview: (...args: unknown[]) => mockBuildImportPreview(...args),
}));

const { POST } = await import("./route");

function multipartRequest(file: File) {
  const form = new FormData();
  form.append("file", file);
  return new Request("http://localhost/api/import/preview", {
    method: "POST",
    body: form,
  }) as unknown as NextRequest;
}

function allow() {
  mockRequireMembership.mockResolvedValue({
    supabase: { from: vi.fn(), rpc: vi.fn() },
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

describe("POST /api/import/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
  });

  it("returns the membership denial before touching the file", async () => {
    mockRequireMembership.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    const response = await POST(multipartRequest(new File(["a,b\n1,2"], "x.csv", { type: "text/csv" })));
    expect(response.status).toBe(401);
    expect(mockBuildImportPreview).not.toHaveBeenCalled();
  });

  it("rejects a file over the size cap without calling buildImportPreview", async () => {
    allow();
    const huge = new File([new Uint8Array(6 * 1024 * 1024)], "cellar.csv", { type: "text/csv" });
    const response = await POST(multipartRequest(huge));
    expect(response.status).toBe(413);
    expect(mockBuildImportPreview).not.toHaveBeenCalled();
  });

  it("rejects a non-csv file", async () => {
    allow();
    const response = await POST(multipartRequest(new File(["a"], "cellar.txt", { type: "text/plain" })));
    expect(response.status).toBe(415);
    expect(mockBuildImportPreview).not.toHaveBeenCalled();
  });

  it("returns the preview payload on success and performs zero writes itself", async () => {
    allow();
    mockBuildImportPreview.mockResolvedValue({
      ok: true,
      rows: [{ rowNumber: 1, rowState: "valid" }],
      summary: { totalRows: 1, validRows: 1 },
    });
    const response = await POST(multipartRequest(new File(["producer,name,quantity\nA,B,1"], "cellar.csv", { type: "text/csv" })));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rows).toHaveLength(1);
    expect(body.summary.totalRows).toBe(1);
  });

  it("surfaces a preview-level parse error as 422 with details", async () => {
    allow();
    mockBuildImportPreview.mockResolvedValue({
      ok: false,
      error: { code: "missing_headers", message: "CSV is missing required column(s): quantity.", missingHeaders: ["quantity"] },
    });
    const response = await POST(multipartRequest(new File(["a,b\n1,2"], "cellar.csv", { type: "text/csv" })));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("missing_headers");
    expect(body.error.details.missingHeaders).toEqual(["quantity"]);
  });
});
