import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NoteComposer } from "./note-composer";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

const VOCAB = [
  { slug: "oaky", label: "Oaky", family: "oak" },
  { slug: "toasty", label: "Toasty", family: "oak" },
  { slug: "black-fruit", label: "Black fruit", family: "fruit" },
];

type Props = Parameters<typeof NoteComposer>[0];

async function render(overrides: Partial<Props> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const props: Props = {
    vocabulary: VOCAB,
    onSave: vi.fn().mockResolvedValue(undefined),
    suggest: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  await act(async () => { root!.render(<NoteComposer {...props} />); });
  return { el: container, props };
}

const byText = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll("button, label")].find((n) => n.textContent?.trim() === text) as HTMLElement | undefined;

const textarea = (el: HTMLElement) => el.querySelector("textarea")!;
const saveButton = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].find((b) => /save note/i.test(b.textContent ?? ""))!;

async function type(el: HTMLElement, value: string) {
  const field = textarea(el);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(node: HTMLElement) {
  await act(async () => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

describe("NoteComposer", () => {
  it("will not save an empty note", async () => {
    const { el, props } = await render();
    await click(saveButton(el));
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("saves the prose", async () => {
    const { el, props } = await render();
    await type(el, "Tight now, should open up.");
    await click(saveButton(el));
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Tight now, should open up." }),
    );
  });

  it("saves only the chips still selected when the author saves", async () => {
    // The model suggested two; the author cleared one. Only what they left
    // ticked is stored, because only a confirmed descriptor is ever counted.
    const suggest = vi.fn().mockResolvedValue(["oaky", "toasty"]);
    const { el, props } = await render({ suggest });
    await type(el, "Lovely toasty oak");
    await click([...el.querySelectorAll("button")].find((b) => /suggest/i.test(b.textContent ?? ""))!);
    const toasty = el.querySelector<HTMLInputElement>('input[value="toasty"]')!;
    await click(toasty);
    await click(saveButton(el));
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ confirmedSlugs: ["oaky"] }),
    );
  });

  it("still saves when suggestion fails", async () => {
    const suggest = vi.fn().mockRejectedValue(new Error("down"));
    const { el, props } = await render({ suggest });
    await type(el, "Still writing this down");
    await click([...el.querySelectorAll("button")].find((b) => /suggest/i.test(b.textContent ?? ""))!);
    await click(saveButton(el));
    expect(props.onSave).toHaveBeenCalled();
  });

  it("groups chips by family", async () => {
    const { el } = await render();
    expect(el.textContent).toMatch(/oak/i);
    expect(el.textContent).toMatch(/fruit/i);
  });

  it("gives every control a 44px touch target", async () => {
    const { el } = await render();
    for (const button of el.querySelectorAll("button")) {
      expect(button.className).toMatch(/min-h-\[44px\]|h-\[44px\]/);
    }
  });

  it("does not offer a score by default, and keeps it optional", async () => {
    const { el, props } = await render();
    await type(el, "No number on this one");
    await click(saveButton(el));
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ score: null }));
  });

  it("clears itself after a successful save", async () => {
    const { el } = await render();
    await type(el, "Something worth recording");
    await click(saveButton(el));
    expect(textarea(el).value).toBe("");
  });

  it("keeps what the author wrote when the save fails", async () => {
    // Losing a sommelier's note because the network blinked is unforgivable.
    const onSave = vi.fn().mockRejectedValue(new Error("network"));
    const { el } = await render({ onSave });
    await type(el, "Do not lose this");
    await click(saveButton(el));
    expect(textarea(el).value).toBe("Do not lose this");
    expect(el.textContent).toMatch(/could not save/i);
  });
});
