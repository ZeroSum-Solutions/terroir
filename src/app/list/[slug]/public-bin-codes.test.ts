import { describe, expect, it } from "vitest";
import { buildBinCodesByWine } from "./public-bin-codes";

describe("buildBinCodesByWine", () => {
  it("EV-6.4: groups unique physical bin codes by wine", () => {
    expect(
      buildBinCodesByWine([
        { wine_id: "wine-a", bins: { code: "A-01" } },
        { wine_id: "wine-a", bins: { code: "A-01" } },
        { wine_id: "wine-a", bins: { code: "B-02" } },
        { wine_id: "wine-b", bins: { code: "C-03" } },
      ]),
    ).toEqual({
      "wine-a": ["A-01", "B-02"],
      "wine-b": ["C-03"],
    });
  });

  it("never creates a code for unplaced inventory", () => {
    expect(
      buildBinCodesByWine([
        { wine_id: "wine-a", bins: null },
        { wine_id: "wine-b", bins: [] },
      ]),
    ).toEqual({});
  });

  it("normalizes PostgREST to-one and array relationship shapes", () => {
    expect(
      buildBinCodesByWine([
        { wine_id: "wine-a", bins: [{ code: "B-02" }, { code: "A-01" }] },
      ]),
    ).toEqual({ "wine-a": ["A-01", "B-02"] });
  });
});
