import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { TemplatePicker } from "./template-picker";

it("exposes the template choices as a labelled group with touch-sized buttons", () => {
  document.body.innerHTML = renderToStaticMarkup(
    <TemplatePicker
      current="classic"
      onChange={vi.fn()}
      ariaLabelledby="mobile-template-heading"
    />,
  );

  expect(document.querySelector('[role="group"]')?.getAttribute("aria-labelledby"))
    .toBe("mobile-template-heading");
  const classic = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === "Classic",
  )!;
  expect(classic.className).toContain("min-h-11");
  expect(classic.getAttribute("aria-pressed")).toBe("true");
});
