import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InsightScope } from "./insight-scope";

describe("InsightScope", () => {
  it("distinguishes a current snapshot from a selected range", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <>
        <InsightScope metric="inventory" kind="snapshot" />
        <InsightScope metric="scan-activity" kind="range" label="Aug 1 – Aug 20" />
      </>,
    );

    expect(document.body.textContent).toContain("Current snapshot");
    expect(document.body.textContent).toContain("Aug 1 – Aug 20");
  });
});
