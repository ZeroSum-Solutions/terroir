import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopNavLinks, MobileNavLinks } from "./nav-links";

vi.mock("next/navigation", () => ({
  usePathname: () => "/cellar",
}));

describe("primary navigation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it.each([DesktopNavLinks, MobileNavLinks])(
    "preserves the five primary destinations, Atlas center",
    (Navigation) => {
      document.body.innerHTML = renderToStaticMarkup(
        // eslint-disable-next-line jsx-a11y/aria-role -- `role` here is this component's own RBAC prop ("staff"/"owner"/"admin"), not a DOM ARIA role.
        <Navigation role="staff" />,
      );
      const links = [...document.querySelectorAll("a")];

      expect(
        links.map((link) => [
          link.textContent?.trim(),
          link.getAttribute("href"),
        ]),
      ).toEqual([
        ["Scan", "/scan"],
        ["Cellar", "/cellar"],
        ["Atlas", "/atlas"],
        ["Lists", "/lists"],
        ["Insights", "/insights"],
      ]);
      expect(
        links.find((link) => link.textContent?.trim() === "Cellar")
          ?.getAttribute("aria-current"),
      ).toBe("page");
    },
  );

  it("keeps desktop links touch-sized for phone landscape", () => {
    document.body.innerHTML = renderToStaticMarkup(
      // eslint-disable-next-line jsx-a11y/aria-role -- `role` here is this component's own RBAC prop ("staff"/"owner"/"admin"), not a DOM ARIA role.
      <DesktopNavLinks role="staff" />,
    );

    document.querySelectorAll("a").forEach((link) => {
      expect(link.className).toContain("min-h-11");
      expect(link.className).toContain("min-w-11");
    });
  });
});
