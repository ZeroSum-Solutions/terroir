import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canReadClipboardFiles,
  dragCarriesFiles,
  filesFromDataTransfer,
  isEditableTarget,
  isFileInputTarget,
  namePastedFiles,
  readClipboardFiles,
} from "./file-intake";

function fileItem(file: File): DataTransferItem {
  return { kind: "file", type: file.type, getAsFile: () => file } as unknown as DataTransferItem;
}

function stringItem(value: string): DataTransferItem {
  return { kind: "string", type: "text/plain", getAsFile: () => null, value } as unknown as DataTransferItem;
}

function transfer(partial: Partial<{ items: DataTransferItem[]; files: File[]; types: string[] }>): DataTransfer {
  return {
    items: partial.items,
    files: partial.files,
    types: partial.types ?? ["Files"],
  } as unknown as DataTransfer;
}

const csv = () => new File(["a,b\n1,2\n"], "cellar.csv", { type: "text/csv" });
const shot = () => new File(["png-bytes"], "image.png", { type: "image/png" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("filesFromDataTransfer", () => {
  it("returns nothing when there is no dataTransfer at all", () => {
    expect(filesFromDataTransfer(null)).toEqual([]);
    expect(filesFromDataTransfer(undefined)).toEqual([]);
  });

  it("reads files from items, which is what a paste populates", () => {
    const file = csv();
    expect(filesFromDataTransfer(transfer({ items: [fileItem(file)] }))).toEqual([file]);
  });

  it("ignores the text flavours a pasted screenshot arrives alongside", () => {
    const file = shot();
    const found = filesFromDataTransfer(
      transfer({ items: [stringItem("<img src=…>"), fileItem(file), stringItem("plain")] }),
    );
    expect(found).toEqual([file]);
  });

  it("trusts the item's own kind, not what getAsFile happens to return", () => {
    // `kind` is the browser's declaration of what an item IS. A string item is
    // spec-bound to yield null from getAsFile, so relying on that instead would
    // work today — but it makes the filter depend on a subtler guarantee than
    // the one actually being asserted.
    const lying = {
      kind: "string",
      type: "text/plain",
      getAsFile: () => csv(),
    } as unknown as DataTransferItem;

    expect(filesFromDataTransfer(transfer({ items: [lying] }))).toEqual([]);
  });

  it("skips an item that claims to be a file but yields none", () => {
    const empty = { kind: "file", type: "", getAsFile: () => null } as unknown as DataTransferItem;
    expect(filesFromDataTransfer(transfer({ items: [empty] }))).toEqual([]);
  });

  it("falls back to files when items is absent", () => {
    const file = csv();
    expect(filesFromDataTransfer(transfer({ files: [file] }))).toEqual([file]);
  });

  it("falls back to files when items is present but empty", () => {
    const file = csv();
    expect(filesFromDataTransfer(transfer({ items: [], files: [file] }))).toEqual([file]);
  });

  it("keeps every page of a multi-file drop, in order", () => {
    const one = new File(["1"], "page-1.pdf", { type: "application/pdf" });
    const two = new File(["2"], "page-2.pdf", { type: "application/pdf" });
    expect(filesFromDataTransfer(transfer({ items: [fileItem(one), fileItem(two)] }))).toEqual([one, two]);
  });

  it("returns nothing when a drag carried only text", () => {
    expect(filesFromDataTransfer(transfer({ items: [stringItem("hello")], types: ["text/plain"] }))).toEqual([]);
  });
});

describe("namePastedFiles", () => {
  const now = new Date(2026, 7, 29, 14, 32);

  it("renames the invented name every screenshot shares", () => {
    const [renamed] = namePastedFiles([shot()], now);
    expect(renamed.name).toBe("pasted-2026-08-29-1432.png");
    expect(renamed.type).toBe("image/png");
  });

  it("keeps a real filename, which a file copied in Finder has", () => {
    const file = csv();
    expect(namePastedFiles([file], now)).toEqual([file]);
  });

  it("distinguishes two pages pasted together, which would otherwise share one name", () => {
    const names = namePastedFiles([shot(), shot()], now).map((f) => f.name);
    expect(names).toEqual(["pasted-2026-08-29-1432-1.png", "pasted-2026-08-29-1432-2.png"]);
    expect(new Set(names).size).toBe(2);
  });

  it("numbers only the invented names when a paste mixes both kinds", () => {
    const real = csv();
    const names = namePastedFiles([real, shot(), shot()], now).map((f) => f.name);
    expect(names).toEqual(["cellar.csv", "pasted-2026-08-29-1432-1.png", "pasted-2026-08-29-1432-2.png"]);
  });

  it("uses the extension the MIME type implies, not always .png", () => {
    const jpeg = new File(["j"], "image.jpeg", { type: "image/jpeg" });
    expect(namePastedFiles([jpeg], now)[0].name).toBe("pasted-2026-08-29-1432.jpg");
  });

  it("falls back to .png for an image type it has no extension for", () => {
    const odd = new File(["x"], "", { type: "image/tiff" });
    expect(namePastedFiles([odd], now)[0].name).toBe("pasted-2026-08-29-1432.png");
  });

  it("preserves the bytes it renames", async () => {
    const [renamed] = namePastedFiles([new File(["png-bytes"], "image.png", { type: "image/png" })], now);
    await expect(renamed.text()).resolves.toBe("png-bytes");
  });

  it("pads single-digit months, days and times so names sort chronologically", () => {
    const early = new Date(2026, 0, 5, 9, 7);
    expect(namePastedFiles([shot()], early)[0].name).toBe("pasted-2026-01-05-0907.png");
  });
});

describe("canReadClipboardFiles", () => {
  it("is false when the browser exposes no clipboard read", () => {
    vi.stubGlobal("navigator", {});
    expect(canReadClipboardFiles()).toBe(false);
  });

  it("is false when ClipboardItem is missing even though read exists", () => {
    vi.stubGlobal("navigator", { clipboard: { read: () => Promise.resolve([]) } });
    vi.stubGlobal("ClipboardItem", undefined);
    expect(canReadClipboardFiles()).toBe(false);
  });

  it("is true when both halves are present", () => {
    vi.stubGlobal("navigator", { clipboard: { read: () => Promise.resolve([]) } });
    vi.stubGlobal("ClipboardItem", class {});
    expect(canReadClipboardFiles()).toBe(true);
  });
});

describe("readClipboardFiles", () => {
  const now = new Date(2026, 7, 29, 14, 32);

  function stubClipboard(read: () => Promise<unknown[]>) {
    vi.stubGlobal("navigator", { clipboard: { read } });
    vi.stubGlobal("ClipboardItem", class {});
  }

  function clipboardItem(types: string[], blobs: Record<string, Blob | Error>) {
    return {
      types,
      getType: async (type: string) => {
        const value = blobs[type];
        if (value instanceof Error) throw value;
        return value;
      },
    };
  }

  it("reports unsupported rather than throwing on a browser without the API", async () => {
    vi.stubGlobal("navigator", {});
    await expect(readClipboardFiles(now)).resolves.toEqual({ ok: false, reason: "unsupported" });
  });

  it("reports denied when the browser refuses, which is a normal answer", async () => {
    stubClipboard(() => Promise.reject(new DOMException("Read permission denied", "NotAllowedError")));
    await expect(readClipboardFiles(now)).resolves.toEqual({ ok: false, reason: "denied" });
  });

  it("reports empty when the clipboard holds nothing usable", async () => {
    stubClipboard(async () => [clipboardItem(["text/plain"], {})]);
    await expect(readClipboardFiles(now)).resolves.toEqual({ ok: false, reason: "empty" });
  });

  it("returns a named file for a copied screenshot", async () => {
    const blob = new Blob(["png-bytes"], { type: "image/png" });
    stubClipboard(async () => [clipboardItem(["text/html", "image/png"], { "image/png": blob })]);

    const outcome = await readClipboardFiles(now);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.files).toHaveLength(1);
    expect(outcome.files[0].name).toBe("pasted-2026-08-29-1432.png");
    expect(outcome.files[0].type).toBe("image/png");
    await expect(outcome.files[0].text()).resolves.toBe("png-bytes");
  });

  it("takes one flavour per item, so an image offered twice is not added twice", async () => {
    const png = new Blob(["p"], { type: "image/png" });
    const jpeg = new Blob(["j"], { type: "image/jpeg" });
    stubClipboard(async () => [
      clipboardItem(["image/png", "image/jpeg"], { "image/png": png, "image/jpeg": jpeg }),
    ]);

    const outcome = await readClipboardFiles(now);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.files).toHaveLength(1);
    // The first usable flavour, read as itself — not a composite of every
    // flavour the item offered.
    expect(outcome.files[0].type).toBe("image/png");
    await expect(outcome.files[0].text()).resolves.toBe("p");
  });

  it("keeps the readable items when one flavour fails to read", async () => {
    const good = new Blob(["g"], { type: "image/png" });
    stubClipboard(async () => [
      clipboardItem(["image/png"], { "image/png": new Error("gone") }),
      clipboardItem(["image/png"], { "image/png": good }),
    ]);

    const outcome = await readClipboardFiles(now);
    expect(outcome.ok && outcome.files).toHaveLength(1);
  });

  it("ignores non-image flavours entirely", async () => {
    const png = new Blob(["p"], { type: "image/png" });
    stubClipboard(async () => [
      clipboardItem(["text/plain"], { "text/plain": new Blob(["hi"]) }),
      clipboardItem(["image/png"], { "image/png": png }),
    ]);

    const outcome = await readClipboardFiles(now);
    expect(outcome.ok && outcome.files).toHaveLength(1);
  });
});

describe("isEditableTarget", () => {
  it("is false for nothing at all", () => {
    expect(isEditableTarget(null)).toBe(false);
  });

  it("is false for a plain element the operator cannot type into", () => {
    const div = document.createElement("div");
    expect(isEditableTarget(div)).toBe(false);
  });

  it.each(["input", "textarea", "select"])("is true for a %s", (tag) => {
    expect(isEditableTarget(document.createElement(tag))).toBe(true);
  });

  it("is true for a contenteditable element", () => {
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(isEditableTarget(div)).toBe(true);
  });

  it("is false for an EventTarget that is not an element at all", () => {
    expect(isEditableTarget(new EventTarget())).toBe(false);
  });
});

describe("isFileInputTarget", () => {
  it("is true only for a file input", () => {
    const file = document.createElement("input");
    file.type = "file";
    expect(isFileInputTarget(file)).toBe(true);
  });

  it("is false for a text input", () => {
    const text = document.createElement("input");
    text.type = "text";
    expect(isFileInputTarget(text)).toBe(false);
  });

  it("is false for a non-input element and for nothing", () => {
    expect(isFileInputTarget(document.createElement("label"))).toBe(false);
    expect(isFileInputTarget(null)).toBe(false);
  });
});

describe("dragCarriesFiles", () => {
  it("is true when the drag advertises Files", () => {
    expect(dragCarriesFiles(transfer({ types: ["Files"] }))).toBe(true);
  });

  it("is false for dragged text or a dragged link", () => {
    expect(dragCarriesFiles(transfer({ types: ["text/plain", "text/uri-list"] }))).toBe(false);
  });

  it("is false when there is no dataTransfer or no types", () => {
    expect(dragCarriesFiles(null)).toBe(false);
    expect(dragCarriesFiles({ types: undefined } as unknown as DataTransfer)).toBe(false);
  });
});
