import { afterEach, describe, expect, it, vi } from "vitest";

import { convertSpreadsheetFile, isSpreadsheetFile } from "./spreadsheet-upload";

function xlsx(name = "cellar.xlsx"): File {
  return new File([new Uint8Array([80, 75, 3, 4])], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function respondWith(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isSpreadsheetFile", () => {
  it("recognises .xlsx regardless of case", () => {
    expect(isSpreadsheetFile(xlsx("Cellar.XLSX"))).toBe(true);
    expect(isSpreadsheetFile(xlsx("cellar.xlsx"))).toBe(true);
  });

  it("leaves csv and legacy xls alone so they take their own paths", () => {
    // .xls is NOT claimed here: it is not readable as xlsx, and claiming it
    // would send it to a converter guaranteed to fail instead of showing the
    // upload validator's specific "re-save as .xlsx" message.
    expect(isSpreadsheetFile(new File([""], "cellar.csv"))).toBe(false);
    expect(isSpreadsheetFile(new File([""], "cellar.xls"))).toBe(false);
    expect(isSpreadsheetFile(new File([""], "cellar.xlsx.txt"))).toBe(false);
  });
});

describe("convertSpreadsheetFile", () => {
  it("returns the converted CSV as a .csv File the ordinary flow can use", async () => {
    respondWith(200, { csv: "producer,wine\nRidge,MB", sheetName: "Cellar", rowCount: 1, sheetCount: 1 });

    const outcome = await convertSpreadsheetFile(xlsx("My Cellar.xlsx"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.file.name).toBe("My Cellar.csv");
    expect(outcome.file.type).toBe("text/csv");
    await expect(outcome.file.text()).resolves.toBe("producer,wine\nRidge,MB");
    expect(outcome.notice).toBe("Read 1 row from “Cellar”.");
  });

  it("says which sheet it read when the workbook has more than one", async () => {
    // Silently importing sheet 1 of 4 is a partial import the operator would
    // only notice when the totals came out wrong.
    respondWith(200, { csv: "a\n1", sheetName: "Reds", rowCount: 1200, sheetCount: 4 });

    const outcome = await convertSpreadsheetFile(xlsx());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.notice).toBe("Read 1,200 rows from “Reds” — the first of 4 sheets.");
  });

  it("surfaces the server's own explanation of a refusal", async () => {
    respondWith(422, { error: { code: "unreadable_workbook", message: "That file could not be read." } });

    const outcome = await convertSpreadsheetFile(xlsx());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe("That file could not be read.");
  });

  it("falls back to a readable message when the error body is unusable", async () => {
    respondWith(500, null);
    const outcome = await convertSpreadsheetFile(xlsx());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe("Could not read that spreadsheet.");
  });

  it("treats a 200 with no csv as a failure rather than an empty import", async () => {
    // A broken contract must not become a zero-row file the operator then
    // confirms into their cellar.
    respondWith(200, { sheetName: "Cellar", rowCount: 0, sheetCount: 1 });
    const outcome = await convertSpreadsheetFile(xlsx());
    expect(outcome.ok).toBe(false);
  });

  it("reports a network failure instead of throwing at the caller", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const outcome = await convertSpreadsheetFile(xlsx());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/could not reach the server/i);
  });

  it("posts the file as multipart to the convert route", async () => {
    respondWith(200, { csv: "a\n1", sheetName: "S", rowCount: 1, sheetCount: 1 });
    await convertSpreadsheetFile(xlsx());

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/import/convert");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
  });
});
