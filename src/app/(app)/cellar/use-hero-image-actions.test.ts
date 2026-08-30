import { type ChangeEvent, act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHeroImageActions } from "./use-hero-image-actions";

let container: HTMLDivElement;
let root: Root;
// Assigned from inside an effect, never during render — the React
// Compiler lint (react-hooks) rejects reassigning an outer binding
// while rendering. Mirrors use-cellar-url-state.test.tsx.
const holder: { current: ReturnType<typeof useHeroImageActions> | null } = { current: null };
function hookApi(): ReturnType<typeof useHeroImageActions> {
  if (!holder.current) throw new Error('Harness not rendered');
  return holder.current;
}

function Harness(props: Parameters<typeof useHeroImageActions>[0]) {
  const value = useHeroImageActions(props);
  useEffect(() => {
    holder.current = value;
  });
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
      await hookApi().handleImageUpload(fileChangeEvent(file));
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/wines/wine-1/image",
      expect.objectContaining({ method: "POST" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Image uploaded");
    expect(refresh).toHaveBeenCalledOnce();
    expect(hookApi().uploading).toBe(false);
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
      await hookApi().handleImageUpload(fileChangeEvent(file));
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
      deletePromise = hookApi().handleImageDelete();
    });
    expect(hookApi().uploading).toBe(true);

    await act(async () => {
      resolveFetch(new Response("{}", { status: 200 }));
      await deletePromise;
    });
    expect(hookApi().uploading).toBe(false);
  });
});
