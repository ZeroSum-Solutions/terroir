import { describe, expect, it } from "vitest";
import {
  cellarSectionDropId,
  cellarWineDragId,
  isCellarSectionAssignable,
  parseCellarSectionDropId,
  parseCellarWineDragId,
  UNCATEGORIZED_SECTION_KEY,
} from "./sections";

describe("cellar section drag boundaries", () => {
  it("makes only wines backed by inventory assignable", () => {
    expect(
      isCellarSectionAssignable({ has_inventory_record: true }),
    ).toBe(true);
    expect(
      isCellarSectionAssignable({ has_inventory_record: false }),
    ).toBe(false);
  });

  it("round-trips section and wine drag identifiers", () => {
    expect(parseCellarSectionDropId(cellarSectionDropId("Reserve"))).toBe(
      "Reserve",
    );
    expect(parseCellarWineDragId(cellarWineDragId("wine-uuid"))).toBe(
      "wine-uuid",
    );
    expect(parseCellarSectionDropId(cellarWineDragId("wine-uuid"))).toBe(
      undefined,
    );
  });

  it("maps the uncategorized drop target to a cleared section", () => {
    expect(
      parseCellarSectionDropId(
        cellarSectionDropId(UNCATEGORIZED_SECTION_KEY),
      ),
    ).toBeNull();
  });
});
