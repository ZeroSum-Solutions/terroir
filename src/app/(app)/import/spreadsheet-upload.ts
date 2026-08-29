// Client half of spreadsheet import: recognises a workbook and exchanges it
// for the CSV text the rest of the import flow already knows how to handle.
//
// Kept out of import-client.tsx so it can be tested as a unit rather than by
// driving a file input through the DOM, and so the component keeps one
// responsibility — rendering — instead of also owning a fetch protocol.

export type SpreadsheetUploadOutcome =
  | { ok: true; file: File; notice: string }
  | { ok: false; message: string };

/** Recognised by extension, not MIME: browsers and operating systems disagree
 * wildly about what an .xlsx is called (several report the generic
 * application/octet-stream, or nothing at all for a drag-and-drop). The server
 * re-validates both, so a wrong guess here fails safely there. */
export function isSpreadsheetFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(".xlsx");
}

function describeSheet(payload: { sheetName: string; rowCount: number; sheetCount: number }): string {
  const rows = `${payload.rowCount.toLocaleString()} ${payload.rowCount === 1 ? "row" : "rows"}`;
  // Only the first sheet is imported. When there are others, say so — silently
  // importing one sheet of several is exactly the kind of partial import an
  // operator would not notice until the counts came out wrong.
  return payload.sheetCount > 1
    ? `Read ${rows} from “${payload.sheetName}” — the first of ${payload.sheetCount} sheets.`
    : `Read ${rows} from “${payload.sheetName}”.`;
}

export async function convertSpreadsheetFile(selected: File): Promise<SpreadsheetUploadOutcome> {
  const body = new FormData();
  body.append("file", selected);

  let response: Response;
  try {
    response = await fetch("/api/import/convert", { method: "POST", body });
  } catch {
    return { ok: false, message: "Could not reach the server to read that spreadsheet." };
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      ok: false,
      message: payload?.error?.message ?? "Could not read that spreadsheet.",
    };
  }
  if (typeof payload?.csv !== "string") {
    // A 200 with a body we cannot use is a broken contract, not a usable file.
    return { ok: false, message: "Could not read that spreadsheet." };
  }

  return {
    ok: true,
    // Renamed to .csv because that is now genuinely what it is — the filename
    // is shown to the operator and travels with the import as its label.
    file: new File([payload.csv], `${selected.name.replace(/\.xlsx$/i, "")}.csv`, {
      type: "text/csv",
    }),
    notice: describeSheet(payload),
  };
}
