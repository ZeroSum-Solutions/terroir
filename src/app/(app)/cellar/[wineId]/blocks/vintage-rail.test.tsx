import { afterEach, describe, expect, it } from "vitest";
import { cleanup, mount } from "@/test/render";
import { VintageRail } from "./vintage-rail";

afterEach(cleanup);

const ROWS = {
  value: [
    { vintage: 2019, ratingAvg: 3.7, ratingCount: 335 },
    { vintage: 2018, ratingAvg: 3.9, ratingCount: 960 },
  ],
  basis: { kind: "corpus" as const, name: "X-Wines" },
};

describe("VintageRail", () => {
  it("renders every vintage's rating with the corpus basis", async () => {
    const el = await mount(<VintageRail rows={ROWS} wineVintage={2018} matchedName="Koonunga Hill" />);
    expect(el.textContent).toContain("3.9");
    expect(el.textContent).toContain("960");
    expect(el.textContent).toMatch(/X-Wines reference corpus/);
  });

  it("marks the vintage this bottle actually is", async () => {
    const el = await mount(<VintageRail rows={ROWS} wineVintage={2018} matchedName="Koonunga Hill" />);
    const marked = [...el.querySelectorAll("tbody th")].find((row) => row.textContent?.includes("Yours"));
    expect(marked?.textContent).toContain("2018");
  });

  it("renders nothing with a single vintage: there is nothing to compare", async () => {
    const el = await mount(
      <VintageRail rows={{ ...ROWS, value: [ROWS.value[0]] }} wineVintage={2019} matchedName="Koonunga Hill" />,
    );
    expect(el.textContent).toBe("");
  });
});
