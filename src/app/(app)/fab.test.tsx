import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/cellar",
  useRouter: () => ({ push: navigation.push }),
}));

const { Fab } = await import("./fab");

describe("Fab", () => {
  beforeEach(() => {
    navigation.push.mockReset();
    document.body.innerHTML = "";
  });

  it("exposes exactly the three working actions and no Voice promise", () => {
    document.body.innerHTML = renderToStaticMarkup(<Fab />);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    const actions = [...menu.querySelectorAll<HTMLElement>("a, button")];

    expect(actions).toHaveLength(3);
    expect(actions.map((action) => action.getAttribute("aria-label"))).toEqual([
      "Scan invoice",
      "Pour",
      "86 a wine",
    ]);
    expect(
      actions.map((action) => action.getAttribute("href")),
    ).toEqual([
      "/scan",
      "/cellar?mode=pour",
      "/cellar?mode=eightysix",
    ]);
    expect(document.body.textContent).not.toContain("Voice command");
    expect(document.body.textContent).not.toContain("Coming in v2");
  });

  it("keeps the trigger above the fixed mobile navigation", () => {
    document.body.innerHTML = renderToStaticMarkup(<Fab />);
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open actions"]',
    );

    expect(trigger?.getAttribute("style")).toContain(
      "bottom:calc(env(safe-area-inset-bottom) + 80px)",
    );
  });
});
