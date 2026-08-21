import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ShellContext } from "./shell-context";

describe("ShellContext", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ["owner", "Owner"],
    ["manager", "Manager"],
    ["staff", "Staff"],
  ] as const)("shows restaurant and %s role", (role, label) => {
    const context = renderContext("Bar Norman", role);

    expect(context.textContent).toContain("Bar Norman");
    expect(context.textContent).toContain(label);
    expect(context.getAttribute("aria-label")).toBeNull();
  });

  it.each([null, "", "   "])(
    "uses a visible fallback for restaurant name %j",
    (restaurantName) => {
      const context = renderContext(restaurantName, "staff");

      expect(context.querySelector("span")?.textContent).toBe(
        "Unnamed restaurant",
      );
    },
  );

  it("keeps the middle context compact and truncatable at 390px", () => {
    const context = renderContext("Bar Norman", "manager");
    const [restaurant, role] = context.querySelectorAll("span");

    expect(context.className).toBe(
      "ml-sm flex min-w-0 items-center gap-xs border-l border-hairline pl-sm md:ml-md md:gap-sm md:pl-md",
    );
    expect(restaurant.className).toBe(
      "max-w-[112px] truncate text-[11px] font-medium text-ink md:max-w-[220px] md:text-[12px]",
    );
    expect(role.className).toBe(
      "shrink-0 rounded-pill bg-beige px-sm py-2xs text-[10px] font-medium uppercase tracking-wide text-ink-soft",
    );
  });
});

function renderContext(
  restaurantName: string | null,
  role: "owner" | "manager" | "staff",
): HTMLElement {
  document.body.innerHTML = renderToStaticMarkup(
    <ShellContext restaurantName={restaurantName} role={role} />,
  );
  return document.querySelector('[data-shell-context="true"]')!;
}
