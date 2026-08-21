import { Trash2 } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IconButton } from "./icon-button";

describe("IconButton", () => {
  it("requires an accessible label and applies the target floor", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <IconButton label="Remove Cabernet">
        <Trash2 />
      </IconButton>,
    );

    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Cabernet"]',
    )!;
    expect(button.className).toContain("min-h-11");
    expect(button.className).toContain("min-w-11");
  });
});
