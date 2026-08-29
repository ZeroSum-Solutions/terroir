// A one-shot handoff for a spreadsheet chosen on the wrong screen.
//
// The scan screen is the invoice scanner: it sends photos and PDFs to document
// intelligence, which cannot read a spreadsheet. Rather than refusing a .csv or
// .xlsx dropped there, the scanner parks the file here and sends the operator
// to /import, which picks it up and proceeds exactly as if they had chosen it
// there. Module state survives client-side navigation, which is all this needs;
// a hard reload legitimately loses it and /import simply shows its own picker.

let pending: File | null = null;

export function setHandoffFile(file: File): void {
  pending = file;
}

/** Single-consumption by design: reading the file clears it, so returning to
 * /import later never silently re-imports a file the operator handed over once
 * and has since dealt with. */
export function takeHandoffFile(): File | null {
  const file = pending;
  pending = null;
  return file;
}

/** Extensions /import can accept, whichever door they arrive at. */
export function isImportableSpreadsheet(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".csv") || name.endsWith(".xlsx");
}
