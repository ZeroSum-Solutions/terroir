import { act, createElement, type ChangeEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHeroImageActions } from "./use-hero-image-actions";

let container: HTMLDivElement;
let root: Root;
let hook: ReturnType<typeof useHeroImageActions>;

function Harness(props: Parameters<typeof useHeroImageActions>[0]) {
  hook = useHeroImageActions(props);
  return null;
}

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

async function mount(props: Parameters<typeof useHeroImageActions>[0]) {
  await act(async () => {
    root.render(createElement(Harness, props));
  });
}

function fileChangeEvent(file: File) {
  return { target: { files: [file] } } as unknown as ChangeEvent<HTMLInputElement>;
}

describe("useHeroImageActions", () => {
  it("uploads the file, toasts success, and refreshes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const toast = { success: vi.fn(), error: vi.fn() };
    const refresh = vi.fn();
    const setErrorMsg = vi.fn();
    await mount({ wineId: "wine-1", setErrorMsg, toast, refresh });

    const file = new File(["x"], "bottle.jpg", { type: "image/jpeg" });
    await act(async () => {
      await hook.handleImageUpload(fileChangeEvent(file));
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/wines/wine-1/image",
      expect.objectContaining({ method: "POST" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Image uploaded");
    expect(refresh).toHaveBeenCalledOnce();
    expect(hook.uploading).toBe(false);
  });

  it("reports the upload failure through setErrorMsg without toasting success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Too large." } }), { status: 413 })),
    );
    const toast = { success: vi.fn(), error: vi.fn() };
    const setErrorMsg = vi.fn();
    await mount({ wineId: "wine-1", setErrorMsg, toast, refresh: vi.fn() });

    const file = new File(["x"], "bottle.jpg", { type: "image/jpeg" });
    await act(async () => {
      await hook.handleImageUpload(fileChangeEvent(file));
    });

    expect(setErrorMsg).toHaveBeenCalledWith("Too large.");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("shares the busy flag between upload and delete", async () => {
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    await mount({
      wineId: "wine-1",
      setErrorMsg: vi.fn(),
      toast: { success: vi.fn(), error: vi.fn() },
      refresh: vi.fn(),
    });

    let deletePromise!: Promise<void>;
    act(() => {
      deletePromise = hook.handleImageDelete();
    });
    expect(hook.uploading).toBe(true);

    await act(async () => {
      resolveFetch(new Response("{}", { status: 200 }));
      await deletePromise;
    });
    expect(hook.uploading).toBe(false);
  });
});
