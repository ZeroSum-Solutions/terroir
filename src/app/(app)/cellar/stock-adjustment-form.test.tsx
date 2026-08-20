import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StockAdjustmentForm } from "./stock-adjustment-form";

describe("StockAdjustmentForm", () => {
  it("EV-7.2: renders comp quantity and an active reason picker without a member-id field", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <StockAdjustmentForm
        wineId="wine-1"
        reasons={[
          { id: "reason-comp", label: "Guest recovery", category: "comp" },
        ]}
      />,
    );

    expect(document.body.textContent).toContain("Record comp or adjustment");
    expect(document.querySelector('select[name="kind"]')).not.toBeNull();
    expect(document.querySelector('input[name="quantity"]')).not.toBeNull();
    expect(document.querySelector('option[value="reason-comp"]')?.textContent).toBe("Guest recovery");
    expect(document.querySelector('[name*="member"]')).toBeNull();
    expect(document.querySelector('[name*="actor"]')).toBeNull();
  });
});
