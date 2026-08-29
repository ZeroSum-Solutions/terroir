// Two more doors onto the same upload: dragging a file in from the desktop,
// and pasting one from the clipboard.
//
// Both are pure extraction here — turning a browser event (or the async
// clipboard) into a plain File[] — so the routing and validation each screen
// already applies to a picked file applies unchanged to a dropped or pasted
// one. Neither door gets its own idea of what a valid upload is.

/** Reads the files a drag-and-drop or paste event actually carried. */
export function filesFromDataTransfer(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) return [];

  // `items` is the richer view: it distinguishes a dragged/pasted FILE from
  // dragged text or HTML, which `files` alone cannot. Screenshots pasted from
  // the clipboard arrive alongside a text/html flavour of the same content,
  // and only `items` shows that the file half is there.
  const items = transfer.items;
  if (items && items.length > 0) {
    const found: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item || item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) found.push(file);
    }
    return found;
  }

  const files = transfer.files;
  if (!files) return [];
  const found: File[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (file) found.push(file);
  }
  return found;
}

/** Names every clipboard screenshot arrives under. A pasted image has no
 * filename of its own — the browser invents one, and invents the SAME one
 * every time. */
const GENERIC_PASTED_NAMES = new Set(["", "image", "image.png", "image.jpeg", "image.jpg", "blob"]);

const EXTENSION_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

function timestampSlug(now: Date): string {
  // Local-time, filename-safe, sorts chronologically: 2026-08-29-1432.
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

/**
 * Gives pasted screenshots distinguishable names.
 *
 * Every screenshot the clipboard hands over is called "image.png". Two pages of
 * one invoice pasted together would therefore arrive under one identical name,
 * shown identically in the file list and in any error naming the file. Files
 * that came with a real name of their own (copied in Finder or Explorer) keep
 * it — only the invented ones are replaced.
 */
export function namePastedFiles(files: File[], now: Date): File[] {
  const needsName = files.filter((file) => GENERIC_PASTED_NAMES.has(file.name.toLowerCase()));
  if (needsName.length === 0) return files;

  const stamp = timestampSlug(now);
  let sequence = 0;

  return files.map((file) => {
    if (!GENERIC_PASTED_NAMES.has(file.name.toLowerCase())) return file;
    sequence += 1;
    const extension = EXTENSION_FOR_MIME[file.type] ?? "png";
    // A lone pasted file needs no counter; a batch does.
    const suffix = needsName.length > 1 ? `-${sequence}` : "";
    return new File([file], `pasted-${stamp}${suffix}.${extension}`, {
      type: file.type,
      lastModified: file.lastModified,
    });
  });
}

/**
 * Whether this browser can be ASKED for the clipboard's contents, as opposed
 * to only being told about them by a paste gesture.
 *
 * This is the difference between the two paste doors. A keyboard paste fires a
 * `paste` event and needs nothing here. On a phone there is no keyboard, and
 * the long-press Paste menu only appears over an editable field — so a
 * button that reads the clipboard directly is the only paste a phone has.
 */
export function canReadClipboardFiles(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.read === "function" &&
    typeof ClipboardItem !== "undefined"
  );
}

export type ClipboardReadOutcome =
  | { ok: true; files: File[] }
  | { ok: false; reason: "unsupported" | "denied" | "empty" };

/** MIME types worth pulling out of the clipboard. Deliberately images only:
 * an OS clipboard carries a copied photo or screenshot faithfully, and little
 * else — a copied .csv reaches the page through the paste EVENT (which does
 * carry real files), never through this API. */
function isReadableClipboardType(type: string): boolean {
  return type.startsWith("image/");
}

/**
 * Asks the clipboard for its contents directly — the phone's paste door.
 *
 * Must be called from inside a user gesture: both Safari and Chrome refuse
 * otherwise, and Safari additionally shows its own confirmation before handing
 * anything over. A refusal is a normal outcome, not an error to throw.
 */
export async function readClipboardFiles(now: Date = new Date()): Promise<ClipboardReadOutcome> {
  if (!canReadClipboardFiles()) return { ok: false, reason: "unsupported" };

  let items: Awaited<ReturnType<Clipboard["read"]>>;
  try {
    items = await navigator.clipboard.read();
  } catch {
    // Permission refused, no gesture, or nothing readable — all indistinguishable
    // from here and all meaning the same thing to the operator.
    return { ok: false, reason: "denied" };
  }

  const files: File[] = [];
  for (const item of items) {
    // One clipboard item usually offers the same content in several flavours
    // (a screenshot is both image/png and text/html). Take the first usable
    // one, or the same image is added twice.
    const type = item.types.find(isReadableClipboardType);
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      const extension = EXTENSION_FOR_MIME[type] ?? "png";
      files.push(new File([blob], `image.${extension}`, { type }));
    } catch {
      // One unreadable flavour must not lose the rest of the clipboard.
    }
  }

  if (files.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, files: namePastedFiles(files, now) };
}

/**
 * Whether a paste landed in something the operator is typing into.
 *
 * The paste listener is on the window so it works without the upload zone
 * being focused — which means it also sees pastes meant for a text field
 * elsewhere on the screen. Those belong to the field.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Partial<HTMLElement>).tagName !== "string") return false;
  const element = target as HTMLElement;
  const tag = element.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return element.isContentEditable === true;
}

/** Whether a drag carries files at all, as opposed to selected text or a link
 * being dragged around the page. Checked on dragover, where the files
 * themselves are not yet readable but their presence is. */
export function dragCarriesFiles(transfer: DataTransfer | null | undefined): boolean {
  if (!transfer) return false;
  const types = transfer.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === "Files") return true;
  }
  return false;
}

/** A file input handles a drop onto itself natively; intercepting it would
 * only add the same files twice. */
export function isFileInputTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Partial<HTMLElement>).tagName !== "string") return false;
  const element = target as HTMLInputElement;
  return element.tagName.toUpperCase() === "INPUT" && element.type === "file";
}
