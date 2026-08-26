import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SettingsDropdown } from "./settings-dropdown";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe("SettingsDropdown touch targets", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("keeps the mobile Settings trigger at least 44px square", async () => {
    const container = await mount(<SettingsDropdown />);
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Settings"]',
    )!;

    expect(trigger.className).toContain("h-11");
    expect(trigger.className).toContain("w-11");
  });

  it("uses the immediate project focus outline on the Settings trigger", async () => {
    const container = await mount(<SettingsDropdown />);
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Settings"]',
    )!;

    expect(trigger.className).toContain("focus-visible:outline-accent");
    expect(trigger.className).toContain("focus-visible:outline-offset-2");
    expect(trigger.className).toContain("focus-visible:transition-none");
    expect(trigger.className).not.toMatch(/focus:ring/);
  });

  it("keeps every Settings menu action at least 44px tall", async () => {
    const container = await mount(<SettingsDropdown />);
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Settings"]',
    )!;

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const actions = [
      ...container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ];
    expect(actions.map((action) => action.textContent?.trim())).toEqual([
      "Pricing",
      "Bins",
      "Reconcile",
      "Team",
      "Import",
      "Sign out",
    ]);
    for (const action of actions) {
      expect.soft(action.className, action.textContent?.trim()).toContain(
        "min-h-11",
      );
    }
  });

  it("uses the project focus outline on every Settings menu action", async () => {
    const container = await mount(<SettingsDropdown />);
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Settings"]',
    )!;

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const actions = [
      ...container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ];
    for (const action of actions) {
      expect.soft(action.className, action.textContent?.trim()).toContain(
        "focus-visible:outline-accent",
      );
      expect.soft(action.className, action.textContent?.trim()).toContain(
        "focus-visible:transition-none",
      );
      expect.soft(action.className, action.textContent?.trim()).not.toMatch(
        /focus:ring/,
      );
    }
  });

  async function mount(element: React.ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return container;
  }
});
