import { describe, expect, it } from "vitest";
import {
  addWineMessages,
  buildAddedItem,
  listSectionNames,
  withAddedItems,
  type AddWineRequest,
} from "./use-add-wine";
import type { WineListEditorSection } from "./wine-list-editor.types";

const WINE = {
  id: "wine-1",
  name: "Vosne-Romanée",
  producer: "Benjamin Leroux",
  vintage: 2019,
  varietal: "Pinot Noir",
  region: "Burgundy",
  colour: "red",
  hero_image_url: null,
};

function request(overrides: Partial<AddWineRequest> = {}): AddWineRequest {
  return {
    wine: WINE,
    glassPrice: 24,
    bottlePrice: 180,
    suggestedGlassPrice: 22,
    suggestedBottlePrice: 175,
    sectionIds: ["section-red"],
    ...overrides,
  };
}

function section(
  id: string,
  items: WineListEditorSection["wine_list_items"] = [],
): WineListEditorSection {
  return {
    id,
    name: id === "section-red" ? "Red" : "Sparkling",
    position: 0,
    wine_list_id: "list-1",
    wine_list_items: items,
  };
}

describe("buildAddedItem", () => {
  it("produces a full-shape row from the wine the modal already holds", () => {
    const item = buildAddedItem("item-1", "section-red", request(), 3);

    expect(item).toMatchObject({
      id: "item-1",
      section_id: "section-red",
      wine_id: "wine-1",
      position: 3,
      glass_price: 24,
      bottle_price: 180,
      suggested_glass_price: 22,
      suggested_bottle_price: 175,
      glass_pour_ml: null,
      pour_size_mode: "fixed",
      hidden: false,
      wines: { producer: "Benjamin Leroux", name: "Vosne-Romanée", colour: "red" },
    });
  });
});

describe("withAddedItems", () => {
  it("appends the new row to its own section without a reload", () => {
    const next = withAddedItems(
      [section("section-red"), section("section-sparkling")],
      [{ sectionId: "section-red", itemId: "item-1" }],
      request(),
    );

    expect(next[0].wine_list_items.map((item) => item.id)).toEqual(["item-1"]);
    expect(next[1].wine_list_items).toHaveLength(0);
  });

  it("continues the section's position sequence", () => {
    const existing = buildAddedItem("item-0", "section-red", request(), 7);
    const next = withAddedItems(
      [section("section-red", [existing])],
      [{ sectionId: "section-red", itemId: "item-1" }],
      request(),
    );

    expect(next[0].wine_list_items.map((item) => item.position)).toEqual([7, 8]);
  });

  it("is idempotent, so a racing router.refresh() cannot duplicate the row", () => {
    const delivered = buildAddedItem("item-1", "section-red", request(), 0);
    const already = section("section-red", [delivered]);
    const next = withAddedItems(
      [already],
      [{ sectionId: "section-red", itemId: "item-1" }],
      request(),
    );

    expect(next[0].wine_list_items).toHaveLength(1);
    expect(next[0]).toBe(already);
  });

  it("leaves every section untouched when nothing was created", () => {
    const sections = [section("section-red")];
    expect(withAddedItems(sections, [], request())).toBe(sections);
  });

  it("does not disturb an unrelated in-flight edit on the same section", () => {
    const edited = {
      ...buildAddedItem("item-0", "section-red", request(), 0),
      blurb: "typed while the POST was in flight",
    };
    const next = withAddedItems(
      [section("section-red", [edited])],
      [{ sectionId: "section-red", itemId: "item-1" }],
      request(),
    );

    expect(next[0].wine_list_items[0].blurb).toBe(
      "typed while the POST was in flight",
    );
  });
});

describe("listSectionNames", () => {
  it.each([
    [[], ""],
    [["Red"], "Red"],
    [["Red", "Sparkling"], "Red and Sparkling"],
    [["Red", "White", "Sparkling"], "Red, White and Sparkling"],
  ])("renders %j as %j", (names, expected) => {
    expect(listSectionNames(names)).toBe(expected);
  });
});

describe("addWineMessages", () => {
  it("confirms the section the wine actually landed in", () => {
    expect(addWineMessages("Leroux, Vosne", ["Red"], [])).toEqual({
      notice: "Added Leroux, Vosne to Red.",
      error: null,
    });
  });

  it("reports a total failure instead of showing nothing", () => {
    expect(addWineMessages("Leroux, Vosne", [], ["Red"])).toEqual({
      notice: null,
      error: "Couldn't add Leroux, Vosne to Red. Please try again.",
    });
  });

  it("says what landed when a multi-section add half-succeeds", () => {
    expect(addWineMessages("Leroux, Vosne", ["Red"], ["Sparkling"])).toEqual({
      notice: null,
      error:
        "Added Leroux, Vosne to Red, but Sparkling failed. Please try again.",
    });
  });
});
