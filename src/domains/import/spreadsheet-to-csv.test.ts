import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv-parser";
import { convertSpreadsheetToCsv } from "./spreadsheet-to-csv";

async function workbookBuffer(
  build: (workbook: ExcelJS.Workbook) => void,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function sheetBuffer(rows: ExcelJS.CellValue[][], name = "Sheet1"): Promise<Buffer> {
  return workbookBuffer((workbook) => {
    const sheet = workbook.addWorksheet(name);
    for (const row of rows) sheet.addRow(row);
  });
}

describe("convertSpreadsheetToCsv", () => {
  it("converts a plain sheet to CSV and reports the sheet it used", async () => {
    const buffer = await sheetBuffer(
      [
        ["producer", "wine", "vintage", "quantity"],
        ["Ridge", "Monte Bello", 2019, 6],
        ["Guigal", "Cote Rotie", 2018, 12],
      ],
      "Cellar",
    );

    const result = await convertSpreadsheetToCsv(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.csv).toBe(
      "producer,wine,vintage,quantity\nRidge,Monte Bello,2019,6\nGuigal,Cote Rotie,2018,12",
    );
    expect(result.sheetName).toBe("Cellar");
    // Header is not import data.
    expect(result.rowCount).toBe(2);
    expect(result.sheetCount).toBe(1);
  });

  it("produces CSV the existing import parser accepts unchanged", async () => {
    // The whole point of converting is that nothing downstream needs to know a
    // spreadsheet was involved. Prove it against the real parser, not a stub.
    const buffer = await sheetBuffer([
      ["producer", "wine"],
      ["Domaine, Ltd", 'The "Good" One'],
    ]);

    const result = await convertSpreadsheetToCsv(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parseCsv(result.csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.header).toEqual(["producer", "wine"]);
    expect(parsed.rows[0]).toEqual(["Domaine, Ltd", 'The "Good" One']);
  });

  it("quotes fields that would otherwise break the CSV", async () => {
    const buffer = await sheetBuffer([
      ["a", "b", "c", "d"],
      ["has,comma", 'has"quote', "has\nnewline", " padded "],
    ]);

    const result = await convertSpreadsheetToCsv(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [, dataLine] = result.csv.split("\n");
    expect(result.csv).toContain('"has,comma"');
    expect(result.csv).toContain('"has""quote"');
    expect(result.csv).toContain('" padded "');
    // A newline inside a quoted field is legal CSV and must stay inside quotes.
    expect(dataLine).toContain('"has');
  });

  it("renders each Excel cell type as the text the operator sees", async () => {
    const buffer = await workbookBuffer((workbook) => {
      const sheet = workbook.addWorksheet("Types");
      sheet.addRow(["number", "bool", "date", "datetime", "formula", "rich", "link", "blank"]);
      const row = sheet.addRow([]);
      row.getCell(1).value = 1234.5;
      row.getCell(2).value = true;
      row.getCell(3).value = new Date(Date.UTC(2019, 0, 15));
      row.getCell(4).value = new Date(Date.UTC(2019, 0, 15, 13, 30));
      row.getCell(5).value = { formula: "A2*2", result: 2469 };
      row.getCell(6).value = { richText: [{ text: "Chateau " }, { text: "Margaux" }] };
      row.getCell(7).value = { text: "Producer site", hyperlink: "https://example.test" };
      row.getCell(8).value = null;
      row.commit();
    });

    const result = await convertSpreadsheetToCsv(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [, values] = result.csv.split("\n");
    expect(values).toBe(
      "1234.5,true,2019-01-15,2019-01-15T13:30:00.000Z,2469,Chateau Margaux,Producer site,",
    );
  });

  it("uses a formula's cached result, never the formula text", async () => {
    // An importer that ingested "=A2*2" would write that string into inventory.
    const buffer = await workbookBuffer((workbook) => {
      const sheet = workbook.addWorksheet("F");
      sheet.addRow(["total"]);
      sheet.addRow([]).getCell(1).value = { formula: "SUM(B1:B9)", result: 42 };
    });

    const result = await convertSpreadsheetToCsv(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.csv).toContain("42");
    expect(result.csv).not.toContain("SUM");
  });

  it("skips blank rows rather than emitting empty CSV lines", async () => {
    const buffer = await workbookBuffer((workbook) => {
      const sheet = workbook.addWorksheet("Gappy");
      sheet.addRow(["producer"]);
      sheet.addRow([]);
      sheet.addRow(["Ridge"]);
    });

    const result = await convertSpreadsheetToCsv(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.csv.split("\n")).toEqual(["producer", "Ridge"]);
    expect(result.rowCount).toBe(1);
  });

  it("pads rows whose trailing columns are empty so the CSV stays rectangular", async () => {
    // exceljs drops trailing empty cells. A sheet with an empty last column
    // therefore yields short rows, and a ragged CSV silently shifts every
    // value left of the gap into the wrong column downstream.
    const buffer = await sheetBuffer([
      ["producer", "wine", "notes"],
      ["Ridge", "Monte Bello", "gift"],
      ["Guigal", "Cote Rotie", null],
      ["Krug", null, null],
    ]);

    const result = await convertSpreadsheetToCsv(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lines = result.csv.split("\n");
    for (const line of lines) {
      expect(line.split(",")).toHaveLength(3);
    }
    expect(lines[2]).toBe("Guigal,Cote Rotie,");
    expect(lines[3]).toBe("Krug,,");

    // And the real parser must agree every row has the header's width.
    const parsed = parseCsv(result.csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const row of parsed.rows) expect(row).toHaveLength(parsed.header.length);
  });

  it("reports how many sheets the workbook had, so the UI can say which one it read", async () => {
    const buffer = await workbookBuffer((workbook) => {
      workbook.addWorksheet("First").addRow(["producer"]);
      workbook.addWorksheet("Second").addRow(["ignored"]);
    });

    const result = await convertSpreadsheetToCsv(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sheetName).toBe("First");
    expect(result.sheetCount).toBe(2);
  });

  it("refuses a file that is not an xlsx workbook", async () => {
    // Covers a .xls (legacy binary, not a ZIP), a corrupt archive and a
    // password-protected workbook alike.
    const result = await convertSpreadsheetToCsv(Buffer.from("producer,wine\nRidge,MB\n"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unreadable_workbook");
    expect(result.message).toMatch(/\.xlsx or \.csv/);
  });

  it("refuses an empty sheet", async () => {
    const buffer = await workbookBuffer((workbook) => {
      workbook.addWorksheet("Empty");
    });
    const result = await convertSpreadsheetToCsv(buffer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("empty_sheet");
  });

  it("refuses a workbook with no sheets at all", async () => {
    const buffer = await workbookBuffer(() => {});
    const result = await convertSpreadsheetToCsv(buffer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_worksheets");
  });
});
