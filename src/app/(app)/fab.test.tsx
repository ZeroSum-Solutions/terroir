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

  it("uses the project focus outline on the trigger and action links", () => {
    document.body.innerHTML = renderToStaticMarkup(<Fab />);
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open actions"]',
    )!;
    const actions = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ];

    // DESIGN.md — Focus: one solid token, one recipe, :focus-visible only.
    // The ring idiom this replaced measured 1.54:1 on light and 1.59:1 on
    // dark — not a weaker indicator, a WCAG 2.2 SC 2.4.11 failure.
    expect(trigger.className).toContain("focus-ring");
    expect(trigger.className).not.toMatch(/focus(-visible)?:(ring|outline)/);
    for (const action of actions) {
      expect(action.className).toContain("focus-ring");
      expect(action.className).not.toMatch(/focus(-visible)?:(ring|outline)/);
    }
  });

  it("places the action menu after its trigger in forward keyboard order", () => {
    document.body.innerHTML = renderToStaticMarkup(<Fab />);
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open actions"]',
    )!;
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;

    expect(
      trigger.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
