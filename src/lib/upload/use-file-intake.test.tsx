import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFileIntake } from "./use-file-intake";

const csv = () => new File(["a,b\n"], "cellar.csv", { type: "text/csv" });
const shot = (bytes: string) => new File([bytes], "image.png", { type: "image/png" });

function fileItem(file: File): DataTransferItem {
  return { kind: "file", type: file.type, getAsFile: () => file } as unknown as DataTransferItem;
}

/** A drag or paste event carrying files, assembled by hand: happy-dom has no
 * constructible DataTransfer. */
function fileEvent(type: string, files: File[], types: string[] = ["Files"]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const transfer = { items: files.map(fileItem), files, types, dropEffect: "none" };
  Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", { value: transfer });
  return { event, transfer };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Harness({ onFiles, enabled }: { onFiles: (files: File[]) => void; enabled?: boolean }) {
  const { isDragging, canPasteFromClipboard, pasteFromClipboard } = useFileIntake({ onFiles, enabled });
  return (
    <div>
      <span data-dragging={String(isDragging)} />
      <button type="button" data-role="paste" disabled={!canPasteFromClipboard} onClick={() => void pasteFromClipboard()}>
        Paste
      </button>
      <input type="file" data-role="picker" />
      <input type="text" data-role="field" />
    </div>
  );
}

async function renderHarness(onFiles: (files: File[]) => void, enabled?: boolean) {
  await act(async () => {
    root.render(<Harness onFiles={onFiles} enabled={enabled} />);
  });
}

function dragging(): string | null {
  return container.querySelector("span")?.getAttribute("data-dragging") ?? null;
}

function el(role: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-role="${role}"]`);
  if (!found) throw new Error(`no [data-role="${role}"]`);
  return found;
}

function send(event: Event, target: EventTarget = window): Event {
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("useFileIntake — drag and drop", () => {
  it("hands a dropped file to the same callback the file picker feeds", async () => {
    const onFiles = vi.fn();
    await renderHarness(onFiles);
    const file = csv();

    send(fileEvent("drop", [file]).event);

    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it("keeps every page of a multi-file drop, in order", async () => {
    const onFiles = vi.fn();
    await renderHarness(onFiles);
    const one = new File(["1"], "page-1.pdf", { type: "application/pdf" });
    const two = new File(["2"], "page-2.pdf", { type: "application/pdf" });

    send(fileEvent("drop", [one, two]).event);

    expect(onFiles).toHaveBeenCalledWith([one, two]);
  });

  it("cancels the browser default, which is to navigate away from the app", async () => {
    await renderHarness(vi.fn());
    const { event } = fileEvent("drop", [csv()]);

    send(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("still cancels that navigation while disabled, so an import in progress survives a stray drop", async () => {
    const onFiles = vi.fn();
    await renderHarness(onFiles, false);
    const { event } = fileEvent("drop", [csv()]);

    send(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("leaves a drag of selected text completely alone", async () => {
    const onFiles = vi.fn();
    await renderHarness(onFiles);
    const { event } = fileEvent("drop", [], ["text/plain"]);

    send(event);

    expect(onFiles).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("lets a file input handle its own drop rather than taking the files twice", async () => {
    const onFiles = vi.fn();
    await renderHarness(onFiles);
    const { event } = fileEvent("drop", [csv()]);

    send(event, el("picker"));

    expect(onFiles).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("cancels dragover, without which no drop event is ever delivered", async () => {
    await renderHarness(vi.fn());
    const { event, transfer } = fileEvent("dragover", [csv()]);

    send(event);

    expect(event.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe("copy");
  });

  it("shows the drag as refused while disabled", async () => {
    await renderHarness(vi.fn(), false);
    const { transfer } = fileEvent("dragover", [csv()]);

    send(fileEvent("dragover", [csv()]).event);

    expect(transfer.dropEffect).toBe("none");
  });

  it("stays in the dragging state while the pointer crosses nested elements", async () => {
    await renderHarness(vi.fn());

    send(fileEvent("dragenter", [csv()]).event);
    expect(dragging()).toBe("true");

    // Entering a child fires its enter before the parent's leave.
    send(fileEvent("dragenter", [csv()]).event);
    send(fileEvent("dragleave", [csv()]).event);
    expect(dragging()).toBe("true");

    send(fileEvent("dragleave", [csv()]).event);
    expect(dragging()).toBe("false");
  });

  it("leaves the dragging state after a drop, however deep the drag went", async () => {
    await renderHarness(vi.fn());

    send(fileEvent("dragenter", [csv()]).event);
    send(fileEvent("dragenter", [csv()]).event);
    send(fileEvent("drop", [csv()]).event);

    expect(dragging()).toBe("false");
  });

  it("never enters the dragging state while disabled", async () => {
    await renderHarness(vi.fn(), false);

    send(fileEvent("dragenter", [csv()]).event);

    expect(dragging()).toBe("false");
  });
});

describe("useFileIntake — paste", () => {
  it("accepts a file pasted from the clipboard", async () => {
    const onFiles = vi.fn();
    await renderHarness(onFiles);
    const file = csv();

    send(fileEvent("paste", [file]).event);

    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it("renames pasted screenshots, which all arrive called image.png", async () => {
    const onFiles = vi.fn();
    await renderHarness(onFiles);

    send(fileEvent("paste", [shot("a"), shot("b")]).event);

    const names = (onFiles.mock.calls[0][0] as File[]).map((f) => f.name);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toMatch(/^pasted-\d{4}-\d{2}-\d{2}-\d{4}-1\.png$/);
  });

  it("leaves a paste aimed at a text field to that field", async () => {
    const onFiles = vi.fn();
    await renderHarness(onFiles);
    const { event } = fileEvent("paste", [csv()]);

    send(event, el("field"));

    expect(onFiles).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores a paste carrying no files, leaving ordinary text pasting untouched", async () => {
    const onFiles = vi.fn();
    await renderHarness(onFiles);
    const { event } = fileEvent("paste", [], ["text/plain"]);

    send(event);

    expect(onFiles).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("accepts nothing while disabled", async () => {
    const onFiles = vi.fn();
    await renderHarness(onFiles, false);

    send(fileEvent("paste", [csv()]).event);

    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe("useFileIntake — reading the clipboard on demand", () => {
  it("reports the paste button unavailable on a browser without the API", async () => {
    vi.stubGlobal("navigator", {});
    await renderHarness(vi.fn());

    expect((el("paste") as HTMLButtonElement).disabled).toBe(true);
  });

  it("forwards what it reads to the same callback", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    vi.stubGlobal("navigator", {
      clipboard: { read: async () => [{ types: ["image/png"], getType: async () => blob }] },
    });
    vi.stubGlobal("ClipboardItem", class {});

    const onFiles = vi.fn();
    await renderHarness(onFiles);
    expect((el("paste") as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      el("paste").click();
    });

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect((onFiles.mock.calls[0][0] as File[])[0].name).toMatch(/^pasted-.*\.png$/);
  });

  it("forwards nothing when the browser refuses, and does not throw", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        read: async () => {
          throw new Error("denied");
        },
      },
    });
    vi.stubGlobal("ClipboardItem", class {});

    const onFiles = vi.fn();
    await renderHarness(onFiles);
    await act(async () => {
      el("paste").click();
    });

    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe("useFileIntake — teardown", () => {
  it("stops listening once unmounted", async () => {
    const onFiles = vi.fn();
    await renderHarness(onFiles);
    act(() => root.render(null));

    const { event } = fileEvent("drop", [csv()]);
    send(event);

    expect(onFiles).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
