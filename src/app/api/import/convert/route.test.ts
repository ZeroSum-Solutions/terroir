import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { __resetRateLimitForTests } from "@/lib/api/rate-limit";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

// The converter is spied on rather than replaced: it defaults to the REAL
// implementation so these tests prove the route and converter are actually
// wired together, and is only overridden for outcomes that would otherwise
// need a 50,000-row workbook to provoke.
const actualConverter = await vi.importActual<
  typeof import("@/domains/import/spreadsheet-to-csv")
>("@/domains/import/spreadsheet-to-csv");
const mockConvert = vi.fn();
vi.mock("@/domains/import/spreadsheet-to-csv", () => ({
  convertSpreadsheetToCsv: (...args: unknown[]) => mockConvert(...args),
}));

const { POST } = await import("./route");

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function workbookFile(
  rows: ExcelJS.CellValue[][],
  name = "cellar.xlsx",
  sheetName = "Sheet1",
): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  for (const row of rows) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], name, { type: XLSX_MIME });
}

function multipartRequest(file: File) {
  const form = new FormData();
  form.append("file", file);
  return new Request("http://localhost/api/import/convert", {
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

describe("POST /api/import/convert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
    mockConvert.mockImplementation(actualConverter.convertSpreadsheetToCsv);
  });

  it("returns the membership denial before reading the file", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const response = await POST(multipartRequest(await workbookFile([["a"]])));
    expect(response.status).toBe(401);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("converts a real workbook into CSV the import pipeline can consume", async () => {
    allow();
    const file = await workbookFile(
      [
        ["producer", "wine", "vintage"],
        ["Ridge", "Monte Bello", 2019],
      ],
      "cellar.xlsx",
      "Cellar",
    );
    const response = await POST(multipartRequest(file));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.csv).toBe("producer,wine,vintage\nRidge,Monte Bello,2019");
    expect(body.sheetName).toBe("Cellar");
    expect(body.rowCount).toBe(1);
    expect(body.sheetCount).toBe(1);
  });

  it("rejects a file over the size cap without converting it", async () => {
    allow();
    const huge = new File([new Uint8Array(6 * 1024 * 1024)], "cellar.xlsx", { type: XLSX_MIME });
    const response = await POST(multipartRequest(huge));
    expect(response.status).toBe(413);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("rejects a .csv on this route — it belongs on the ordinary upload path", async () => {
    allow();
    const csv = new File(["a,b\n1,2"], "cellar.csv", { type: "text/csv" });
    const response = await POST(multipartRequest(csv));
    expect(response.status).toBe(415);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("rejects a legacy .xls by name, and says what to do about it", async () => {
    allow();
    const legacy = new File([new Uint8Array(64)], "cellar.xls", { type: "application/vnd.ms-excel" });
    const response = await POST(multipartRequest(legacy));
    expect(response.status).toBe(415);
    const body = await response.json();
    expect(body.error.message).toMatch(/\.xlsx/);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("reports an unreadable workbook as 422, not a server error", async () => {
    allow();
    // Right extension and MIME, but the bytes are not a ZIP at all.
    const bogus = new File(["not a workbook"], "cellar.xlsx", { type: XLSX_MIME });
    const response = await POST(multipartRequest(bogus));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("unreadable_workbook");
  });

  it("maps a sheet too big to convert onto 413 rather than 422", async () => {
    allow();
    mockConvert.mockResolvedValue({
      ok: false,
      code: "too_many_rows",
      message: "That sheet has more than 50,000 rows.",
    });
    const response = await POST(multipartRequest(await workbookFile([["a"]])));
    expect(response.status).toBe(413);
  });

  it("rate limits conversions per restaurant", async () => {
    allow();
    const file = await workbookFile([["producer"], ["Ridge"]]);
    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      last = (await POST(multipartRequest(file))).status;
    }
    expect(last).toBe(429);
  });
});
