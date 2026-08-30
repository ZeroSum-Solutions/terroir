import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecantTimeSection } from "./decant-time-section";
import { baseRow } from "./test-row";

describe("DecantTimeSection", () => {
  it("shows minutes only under an hour", () => {
    const html = renderToStaticMarkup(
      <DecantTimeSection row={baseRow({ decant_minutes: 45 })} />,
    );
    expect(html).toContain("45 min");
  });

  it("shows whole hours with no minutes", () => {
    const html = renderToStaticMarkup(
      <DecantTimeSection row={baseRow({ decant_minutes: 60 })} />,
    );
    expect(html).toContain("1 hour");
    expect(html).not.toContain("1 hours");
  });

  it("pluralizes multiple whole hours", () => {
    const html = renderToStaticMarkup(
      <DecantTimeSection row={baseRow({ decant_minutes: 120 })} />,
    );
    expect(html).toContain("2 hours");
  });

  it("combines hours and minutes", () => {
    const html = renderToStaticMarkup(
      <DecantTimeSection row={baseRow({ decant_minutes: 90 })} />,
    );
    expect(html).toContain("1h 30m");
  });
});
