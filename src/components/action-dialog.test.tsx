import { act, useLayoutEffect, useState, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ActionDialog, actionNeedsConfirmation } from "./action-dialog";

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

describe("actionNeedsConfirmation", () => {
  it.each([
    ["immediate", false],
    ["undo", false],
    ["confirm", true],
  ] as const)("maps %s to %s", (tier, expected) => {
    expect(actionNeedsConfirmation(tier)).toBe(expected);
  });
});

describe("ActionDialog", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  it("labels the modal, wraps focus in both directions, closes on Escape, restores focus, and restores scroll", async () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.append(trigger);
    trigger.focus();

    const { container, root } = await mount(
      <ActionDialog
        open
        title="Delete section"
        description="Cannot be undone."
        confirmLabel="Delete section"
        onConfirm={vi.fn()}
        onClose={onClose}
      />,
    );
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Delete section",
    );
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Cannot be undone.",
    );
    expect(document.body.style.overflow).toBe("hidden");

    const controls = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
    await flushFocusFrame();
    expect(document.activeElement).toBe(controls[0]);
    controls.at(-1)!.focus();
    pressTab();
    expect(document.activeElement).toBe(controls[0]);
    controls[0].focus();
    pressTab(true);
    expect(document.activeElement).toBe(controls.at(-1));

    pressEscape();
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => {
      root.render(
        <ActionDialog
          open={false}
          title="Delete section"
          description="Cannot be undone."
          confirmLabel="Delete section"
          onConfirm={vi.fn()}
          onClose={onClose}
        />,
      );
    });
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps the trap stable while children type and busy state changes", async () => {
    const { container, trigger } = await mountFromTrigger(<BusyHarness />);
    await flushFocusFrame();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!;
    expect(document.activeElement).toBe(input);

    await change(input, "Cabernet");
    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(trigger);

    await click(button(container, "Start"));
    const cancel = button(container, "Cancel");
    const confirm = button(container, "Delete section");
    expect(cancel.disabled).toBe(false);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    expect(confirm.disabled).toBe(true);
    expect(cancel.className).toContain("min-h-11");
    expect(confirm.className).toContain("min-h-11");

    cancel.focus();
    pressTab();
    expect(document.activeElement).toBe(cancel);
    await click(cancel);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).not.toBe(trigger);
    pressEscape();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await mouseDown(backdrop(container));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).not.toBe(trigger);
  });

  it.each([
    ["Tab", false],
    ["Shift+Tab", true],
  ] as const)(
    "recovers %s into Cancel when the focused Confirm becomes disabled",
    async (_label, shiftKey) => {
      const { container } = await mount(<BusyHarness />);
      await flushFocusFrame();
      const confirm = button(container, "Delete section");
      confirm.focus();
      expect(document.activeElement).toBe(confirm);

      await click(button(container, "Start"));
      expect(confirm.disabled).toBe(true);
      pressTab(shiftKey);

      expect(document.activeElement).toBe(button(container, "Cancel"));
    },
  );

  it("blocks Cancel in the committed busy state before passive effects run", async () => {
    const previousClose = vi.fn();
    const replacementClose = vi.fn();
    const { root } = await mount(
      <ActionDialog
        open
        title="Delete section"
        description="Cannot be undone."
        confirmLabel="Delete section"
        cancelLabel="Keep section"
        onConfirm={vi.fn()}
        onClose={previousClose}
      />,
    );

    await act(async () => {
      flushSync(() => {
        root.render(
          <ActionDialog
            open
            busy
            title="Delete section"
            description="Cannot be undone."
            confirmLabel="Delete section"
            cancelLabel="Keep section"
            onConfirm={vi.fn()}
            onClose={replacementClose}
          >
            <LayoutCancelProbe label="Keep section" />
          </ActionDialog>,
        );
      });
    });

    expect(previousClose).not.toHaveBeenCalled();
    expect(replacementClose).not.toHaveBeenCalled();
  });

  it("uses a replacement onClose in the commit before passive effects run", async () => {
    const previousClose = vi.fn();
    const replacementClose = vi.fn();
    const { root } = await mount(
      <ActionDialog
        open
        title="Discard scan"
        description="All edits will be lost."
        confirmLabel="Discard scan"
        cancelLabel="Keep scan"
        onConfirm={vi.fn()}
        onClose={previousClose}
      />,
    );

    await act(async () => {
      flushSync(() => {
        root.render(
          <ActionDialog
            open
            title="Discard scan"
            description="All edits will be lost."
            confirmLabel="Discard scan"
            cancelLabel="Keep scan"
            onConfirm={vi.fn()}
            onClose={replacementClose}
          >
            <LayoutCancelProbe label="Keep scan" />
          </ActionDialog>,
        );
      });
    });

    expect(previousClose).not.toHaveBeenCalled();
    expect(replacementClose).toHaveBeenCalledOnce();
  });

  it("closes only for a safe backdrop activation when idle", async () => {
    const onClose = vi.fn();
    const { container } = await mount(
      <ActionDialog
        open
        title="Discard scan"
        description="All edits will be lost."
        confirmLabel="Discard scan"
        onConfirm={vi.fn()}
        onClose={onClose}
      >
        <input aria-label="Draft" />
      </ActionDialog>,
    );
    const overlay = backdrop(container);
    await mouseDown(container.querySelector<HTMLElement>('[role="dialog"]')!);
    expect(onClose).not.toHaveBeenCalled();
    await mouseDown(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }

  async function mountFromTrigger(element: ReactElement) {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.append(trigger);
    trigger.focus();
    return { ...(await mount(element)), trigger };
  }
});

function BusyHarness() {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState("");
  return (
    <ActionDialog
      open={open}
      busy={busy}
      title="Delete section"
      description="Cannot be undone."
      confirmLabel="Delete section"
      onClose={() => setOpen(false)}
      onConfirm={() => setBusy(true)}
    >
      <input
        aria-label="Draft"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="button" onClick={() => setBusy(true)}>
        Start
      </button>
    </ActionDialog>
  );
}

function LayoutCancelProbe({ label }: { label: string }) {
  useLayoutEffect(() => {
    button(document, label).click();
  }, [label]);
  return null;
}

function button(root: ParentNode, name: string) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === name,
  )!;
}

function backdrop(root: ParentNode) {
  return root.querySelector<HTMLElement>('[data-action-dialog-backdrop="true"]')!;
}

async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
      .set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function mouseDown(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
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
