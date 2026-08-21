import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field } from "./field";

describe("Field", () => {
  it("connects label, description, and error to the input", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <Field
        id="unit-cost"
        label="Unit cost"
        description="Per bottle"
        error="Enter a number"
        required
      >
        {(a11y) => <input {...a11y} />}
      </Field>,
    );

    const input = document.querySelector<HTMLInputElement>("#unit-cost")!;
    expect(document.querySelector('label[for="unit-cost"]')?.textContent).toBe(
      "Unit cost",
    );
    expect(input.getAttribute("aria-label")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(
      "unit-cost-description unit-cost-error",
    );
    expect(document.querySelector("#unit-cost-error")?.getAttribute("role")).toBe(
      "alert",
    );
  });

  it("can visually hide only the label when a table header names the column", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <Field id="desktop-vintage" label="Vintage" srOnlyLabel>
        {(a11y) => <input {...a11y} />}
      </Field>,
    );

    const label = document.querySelector('label[for="desktop-vintage"]')!;
    expect(label.className).toContain("sr-only");
    expect(document.querySelector<HTMLInputElement>("#desktop-vintage")).not.toBeNull();
  });
});
