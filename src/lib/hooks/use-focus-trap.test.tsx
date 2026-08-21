import { act, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useFocusTrap } from "./use-focus-trap";

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

describe("useFocusTrap paused lifecycle", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lets a child trap own focus temporarily without losing the parent's original trigger", async () => {
    const outerTrigger = document.createElement("button");
    outerTrigger.textContent = "Open drawer";
    document.body.append(outerTrigger);
    outerTrigger.focus();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<NestedTrapHarness />));
    await flushFocusFrame();
    const nestedTrigger = button(container, "Open child");
    expect(document.activeElement).toBe(nestedTrigger);

    nestedTrigger.focus();
    await click(nestedTrigger);
    await flushFocusFrame();
    const childFirst = button(container, "Child first");
    const childLast = button(container, "Close child");
    expect(document.activeElement).toBe(childFirst);
    expect(document.activeElement).not.toBe(outerTrigger);

    childLast.focus();
    pressTab();
    expect(document.activeElement).toBe(childFirst);
    childFirst.focus();
    pressTab(true);
    expect(document.activeElement).toBe(childLast);

    await click(childLast);
    expect(document.activeElement).toBe(nestedTrigger);
    await flushFocusFrame();
    expect(document.activeElement).toBe(nestedTrigger);

    const outerFirst = nestedTrigger;
    const outerLast = button(container, "Close drawer");
    outerLast.focus();
    pressTab();
    expect(document.activeElement).toBe(outerFirst);
    outerFirst.focus();
    pressTab(true);
    expect(document.activeElement).toBe(outerLast);

    await click(outerLast);
    expect(document.activeElement).toBe(outerTrigger);
    await act(async () => root.unmount());
  });

  it("does not call Escape while paused", async () => {
    const onEscape = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<SingleTrap paused onEscape={onEscape} />));
    pressEscape();
    expect(onEscape).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});

function NestedTrapHarness() {
  const [outerOpen, setOuterOpen] = useState(true);
  const [childOpen, setChildOpen] = useState(false);
  const outerRef = useRef<HTMLDivElement>(null);
  const childRef = useRef<HTMLDivElement>(null);
  const closeOuter = useCallback(() => setOuterOpen(false), []);
  const closeChild = useCallback(() => setChildOpen(false), []);

  useFocusTrap({
    containerRef: outerRef,
    enabled: outerOpen,
    paused: childOpen,
    onEscape: closeOuter,
  });
  useFocusTrap({
    containerRef: childRef,
    enabled: childOpen,
    onEscape: closeChild,
  });

  if (!outerOpen) return null;
  return (
    <div ref={outerRef}>
      <button type="button" onClick={() => setChildOpen(true)}>
        Open child
      </button>
      <button type="button" onClick={() => setOuterOpen(false)}>
        Close drawer
      </button>
      {childOpen ? (
        <div ref={childRef}>
          <button type="button">Child first</button>
          <button type="button" onClick={() => setChildOpen(false)}>
            Close child
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SingleTrap({ paused, onEscape }: { paused: boolean; onEscape: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap({ containerRef: ref, paused, onEscape });
  return (
    <div ref={ref}>
      <button type="button">Only control</button>
    </div>
  );
}

function button(root: ParentNode, name: string) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === name,
  )!;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function pressTab(shiftKey = false) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }));
}

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

async function flushFocusFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
