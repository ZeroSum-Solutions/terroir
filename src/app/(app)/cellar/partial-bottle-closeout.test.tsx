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
});
