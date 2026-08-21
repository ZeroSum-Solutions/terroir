import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicMenuShare } from "./public-menu-share";

let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

describe("PublicMenuShare", () => {
  it("uses native share when available", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    });
    window.history.replaceState({}, "", "/list/dinner");

    const container = await renderShare();
    await act(async () => findButton(container, "Share menu").click());

    expect(share).toHaveBeenCalledWith({
      title: "Dinner · Example",
      text: "View the current wine list at Example.",
      url: window.location.href,
    });
    expect(container.textContent).toContain("Menu shared");
  });

  it("copies the current URL when native share is unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    window.history.replaceState({}, "", "/list/lunch");

    const container = await renderShare();
    await act(async () => findButton(container, "Share menu").click());

    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Link copied",
    );
  });

  it("recovers from a native-share failure by copying the current URL", async () => {
    const share = vi.fn().mockRejectedValue(new Error("share unavailable"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const container = await renderShare();
    await act(async () => findButton(container, "Share menu").click());

    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(container.textContent).toContain("Link copied");
  });

  it("treats an error named AbortError as cancellation without copying", async () => {
    const cancelled = new Error("cancelled");
    cancelled.name = "AbortError";
    const share = vi.fn().mockRejectedValue(cancelled);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const container = await renderShare();
    await act(async () => findButton(container, "Share menu").click());

    expect(writeText).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("announces a recoverable instruction when sharing and copying fail", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const container = await renderShare();
    await act(async () => findButton(container, "Share menu").click());

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Unable to share. Copy the address from your browser.",
    );
  });
});

async function renderShare(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <PublicMenuShare
        title="Dinner · Example"
        text="View the current wine list at Example."
      />,
    );
  });
  return container;
}

function findButton(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}
