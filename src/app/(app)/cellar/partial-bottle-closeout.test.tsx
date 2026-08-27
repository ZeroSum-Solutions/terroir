import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PartialBottleCloseout } from "./partial-bottle-closeout";

describe("PartialBottleCloseout", () => {
  it("EV-10.1/10.2: shows live theoretical remaining and closeout inputs with spoilage reasons", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <PartialBottleCloseout
        bottle={{
          id: "b-1",
          wineId: "w-1",
          theoreticalRemainingMl: 515,
          preservationMethod: "coravin",
          openedBy: "u-1",
        }}
        reasons={[{ id: "reason-1", label: "Spoiled", category: "spoilage" }]}
      />,
    );

    expect(document.body.textContent).toContain("515 ml theoretical remaining");
    expect(document.body.textContent).toContain("Coravin");
    expect(document.querySelector('input[name="actual_remaining_ml"]')).not.toBeNull();
    expect(document.querySelector('input[name="written_off_ml"]')).not.toBeNull();
    expect(document.querySelector('option[value="reason-1"]')?.textContent).toBe("Spoiled");
  });

  it("never renders the raw opened-by user id — a UUID must never leak into the UI", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <PartialBottleCloseout
        bottle={{
          id: "b-1",
          wineId: "w-1",
          theoreticalRemainingMl: 515,
          preservationMethod: "coravin",
          openedBy: "d88b0a20-4b1e-4a3b-9c2f-1a2b3c4d5e6f",
        }}
        reasons={[]}
      />,
    );

    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(document.body.textContent).toContain("opened");
  });

  it("keeps every close-out control at least 44px tall", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <PartialBottleCloseout
        bottle={{
          id: "b-1",
          wineId: "w-1",
          theoreticalRemainingMl: 515,
          preservationMethod: "coravin",
          openedBy: "u-1",
        }}
        reasons={[{ id: "reason-1", label: "Spoiled", category: "spoilage" }]}
      />,
    );

    for (const control of document.querySelectorAll<HTMLElement>("input, select, button")) {
      expect(control.className).toContain("h-11");
    }
  });
});
