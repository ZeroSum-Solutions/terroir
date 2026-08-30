import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServingTempSection } from "./serving-temp-section";
import { baseRow } from "./test-row";

describe("ServingTempSection", () => {
  it("renders the min–max range", () => {
    const html = renderToStaticMarkup(
      <ServingTempSection row={baseRow({ serving_temp_min: 55, serving_temp_max: 60 })} />,
    );
    expect(html).toContain("55");
    expect(html).toContain("60");
    expect(html).toContain("°F");
  });

  it("shows the label only when one is set", () => {
    const withLabel = renderToStaticMarkup(
      <ServingTempSection
        row={baseRow({ serving_temp_min: 55, serving_temp_max: 60, serving_temp_label: "Cellar temp" })}
      />,
    );
    expect(withLabel).toContain("Cellar temp");

    const withoutLabel = renderToStaticMarkup(
      <ServingTempSection row={baseRow({ serving_temp_min: 55, serving_temp_max: 60 })} />,
    );
    expect(withoutLabel).not.toContain("Cellar temp");
  });
});
