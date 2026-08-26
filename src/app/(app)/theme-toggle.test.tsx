import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "./theme-toggle";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete document.documentElement.dataset.theme;
});

function render() {
  act(() => {
    root.render(<ThemeToggle />);
  });
}

function press(label: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  expect(button).not.toBeNull();
  act(() => button!.click());
  return button!;
}

describe("ThemeToggle", () => {
  it("defaults to the system choice with no stored theme", () => {
    render();
    expect(
      container
        .querySelector('button[aria-label="Match device theme"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("applies and persists an explicit dark choice", () => {
    render();
    const dark = press("Dark theme");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("terroir-theme")).toBe("dark");
    expect(dark.getAttribute("aria-pressed")).toBe("true");
  });

  it("returns to system by clearing both the attribute and storage", () => {
    render();
    press("Dark theme");
    press("Match device theme");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("terroir-theme")).toBeNull();
  });

  it("restores a stored choice on mount", () => {
    localStorage.setItem("terroir-theme", "dark");
    render();
    expect(
      container
        .querySelector('button[aria-label="Dark theme"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  describe("browser-chrome theme-color sync", () => {
    // Mirrors the two metas Next renders from viewport.themeColor.
    let darkMeta: HTMLMetaElement;
    let lightMeta: HTMLMetaElement;

    beforeEach(() => {
      darkMeta = document.createElement("meta");
      darkMeta.name = "theme-color";
      darkMeta.media = "(prefers-color-scheme: dark)";
      darkMeta.content = "#0d0c09";
      lightMeta = document.createElement("meta");
      lightMeta.name = "theme-color";
      lightMeta.media = "(prefers-color-scheme: light)";
      lightMeta.content = "#f2ede3";
      document.head.append(darkMeta, lightMeta);
    });

    afterEach(() => {
      darkMeta.remove();
      lightMeta.remove();
    });

    it("forces both metas to the cellar color on an explicit dark choice", () => {
      render();
      press("Dark theme");
      expect(darkMeta.content).toBe("#0d0c09");
      expect(lightMeta.content).toBe("#0d0c09");
    });

    it("forces both metas to the tasting-room color on an explicit light choice", () => {
      render();
      press("Light theme");
      expect(darkMeta.content).toBe("#f2ede3");
      expect(lightMeta.content).toBe("#f2ede3");
    });

    it("restores each meta to its own media color on returning to system", () => {
      render();
      press("Dark theme");
      press("Match device theme");
      expect(darkMeta.content).toBe("#0d0c09");
      expect(lightMeta.content).toBe("#f2ede3");
    });
  });
});
