import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Stat } from "./stat";

describe("Stat", () => {
  it("renders the label and value", () => {
    const html = renderToStaticMarkup(<Stat label="Sealed" value="4" />);
    expect(html).toContain("Sealed");
    expect(html).toContain("4");
  });

  it("uses the risk-ink tone for a warn stat", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <Stat label="Status" value="86'd" tone="warn" />,
    );
    const value = [...document.querySelectorAll("span")].find(
      (el) => el.textContent === "86'd",
    );
    expect(value?.className).toContain("text-risk-ink");
  });

  it("defaults to the ink tone when no tone is given", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <Stat label="Open" value="2.1 oz" />,
    );
    const value = [...document.querySelectorAll("span")].find(
      (el) => el.textContent === "2.1 oz",
    );
    expect(value?.className).toContain("text-ink");
    expect(value?.className).not.toContain("text-risk-ink");
  });
});
