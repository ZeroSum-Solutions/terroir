import { describe, expect, it } from "vitest";

import {
  isImportableSpreadsheet,
  setHandoffFile,
  takeHandoffFile,
} from "./spreadsheet-handoff";

const file = (name: string) => new File(["a,b"], name);

describe("spreadsheet handoff", () => {
  it("hands the parked file to the next taker", () => {
    const parked = file("cellar.xlsx");
    setHandoffFile(parked);
    expect(takeHandoffFile()).toBe(parked);
  });

  it("is consumed exactly once", () => {
    // Otherwise navigating back to /import later would silently re-import a
    // file the operator already dealt with.
    setHandoffFile(file("cellar.csv"));
    expect(takeHandoffFile()).not.toBeNull();
    expect(takeHandoffFile()).toBeNull();
  });

  it("returns null when nothing was parked", () => {
    expect(takeHandoffFile()).toBeNull();
  });

  it("replaces an unclaimed file rather than queueing", () => {
    setHandoffFile(file("first.csv"));
    const second = file("second.csv");
    setHandoffFile(second);
    expect(takeHandoffFile()).toBe(second);
    expect(takeHandoffFile()).toBeNull();
  });

  it("recognises the formats /import accepts, and nothing else", () => {
    expect(isImportableSpreadsheet(file("cellar.csv"))).toBe(true);
    expect(isImportableSpreadsheet(file("Cellar.XLSX"))).toBe(true);
    expect(isImportableSpreadsheet(file("invoice.pdf"))).toBe(false);
    expect(isImportableSpreadsheet(file("label.jpg"))).toBe(false);
    expect(isImportableSpreadsheet(file("cellar.xls"))).toBe(false);
  });
});
