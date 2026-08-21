import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NoteModal } from "./note-modal";

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

describe("NoteModal action confirmation", () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  it.each([
    ["eightysixed", "86 wine", "86 Test Wine"],
    ["restored", "Restore wine", "Restore Test Wine"],
  ] as const)(
    "renders the %s action label and lets the shared dialog focus the note",
    async (direction, title, confirmLabel) => {
      const onConfirm = vi.fn();
      const { container } = await mount(
        <NoteModal
          open
          wineName="Test Wine"
          direction={direction}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />,
      );

      const dialog = dialogByTitle(container, title);
      expect(dialog).toBeDefined();
      const textarea = dialog!.querySelector<HTMLTextAreaElement>("textarea")!;
      await flushFocusFrame();
      expect(document.activeElement).toBe(textarea);

      await change(textarea, "  last bottle just poured  ");
      await click(button(dialog!, confirmLabel));
      expect(onConfirm).toHaveBeenCalledOnce();
      expect(onConfirm).toHaveBeenCalledWith("last bottle just poured");
    },
  );

  it("cancels without submitting and blocks every close path while busy", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { container, root } = await mount(
      <NoteModal
        open
        wineName="Test Wine"
        direction="eightysixed"
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    let dialog = dialogByTitle(container, "86 wine")!;
    await click(button(dialog, "Cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    onCancel.mockClear();
    await act(async () => {
      root.render(
        <NoteModal
          open
          wineName="Test Wine"
          direction="eightysixed"
          busy
          onCancel={onCancel}
          onConfirm={onConfirm}
        />,
      );
    });
    dialog = dialogByTitle(container, "86 wine")!;
    expect(button(dialog, "86 Test Wine").disabled).toBe(true);
    await click(button(dialog, "Cancel"));
    pressEscape();
    await mouseDown(container.querySelector<HTMLElement>('[data-action-dialog-backdrop="true"]')!);
    expect(onCancel).not.toHaveBeenCalled();
    expect(dialogByTitle(container, "86 wine")).toBeDefined();
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

function dialogByTitle(root: ParentNode, title: string) {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (dialog) => dialog.querySelector("h2")?.textContent === title,
  );
}

function button(root: ParentNode, name: string) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === name,
  )!;
}

async function change(input: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!
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

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

async function flushFocusFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
