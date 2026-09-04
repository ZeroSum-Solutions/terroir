import { afterEach, describe, expect, it } from "vitest";
import { cleanup, mount } from "@/test/render";
import { DrinkWindowBlock } from "./drink-window-block";

afterEach(cleanup);

describe("DrinkWindowBlock", () => {
  it("renders the window's years with the source it came from", async () => {
    const el = await mount(
      <DrinkWindowBlock
        window={{
          value: { start: 2024, end: 2032 },
          basis: { kind: "sourced", name: "Domaine Sheet", url: "https://example.test/sheet", asOf: "2026-08-14" },
        }}
        currentYear={2026}
      />,
    );
    expect(el.textContent).toContain("2024");
    expect(el.textContent).toContain("2032");
    expect(el.textContent).toMatch(/Domaine Sheet/);
    expect(el.textContent).toMatch(/14 August 2026/);
  });

  it("names the person behind a house override", async () => {
    const el = await mount(
      <DrinkWindowBlock
        window={{ value: { start: 2024, end: 2032 }, basis: { kind: "override", by: "Devin", at: "2026-08-20" } }}
        currentYear={2026}
      />,
    );
    expect(el.textContent).toMatch(/set by the house/i);
    expect(el.textContent).toContain("Devin");
  });
});
