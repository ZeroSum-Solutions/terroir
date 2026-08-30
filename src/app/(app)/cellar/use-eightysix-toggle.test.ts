import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEightysixToggle } from "./use-eightysix-toggle";

let container: HTMLDivElement;
let root: Root;
// Assigned from inside an effect, never during render — the React
// Compiler lint (react-hooks) rejects reassigning an outer binding
// while rendering. Mirrors use-cellar-url-state.test.tsx.
const holder: { current: ReturnType<typeof useEightysixToggle> | null } = { current: null };
function hookApi(): ReturnType<typeof useEightysixToggle> {
  if (!holder.current) throw new Error('Harness not rendered');
  return holder.current;
}

function Harness(props: {
  wineId: string | null;
  setErrorMsg: (m: string | null) => void;
  toast: { success: (t: string) => void; error: (t: string) => void };
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const value = useEightysixToggle({ ...props, busy, setBusy });
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

async function mount(props: {
  wineId: string | null;
  setErrorMsg: (m: string | null) => void;
  toast: { success: (t: string) => void; error: (t: string) => void };
  refresh: () => void;
}) {
  await act(async () => {
    root.render(createElement(Harness, props));
  });
}

describe("useEightysixToggle", () => {
  it("does nothing if confirmed with no pending direction", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const toast = { success: vi.fn(), error: vi.fn() };
    await mount({ wineId: "wine-1", setErrorMsg: vi.fn(), toast, refresh: vi.fn() });

    await act(async () => {
      await hookApi().onConfirm86("note");
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("PATCHes the availability endpoint and clears pendingDirection on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const toast = { success: vi.fn(), error: vi.fn() };
    const refresh = vi.fn();
    await mount({ wineId: "wine-1", setErrorMsg: vi.fn(), toast, refresh });

    act(() => {
      hookApi().setPendingDirection("eightysixed");
    });
    expect(hookApi().pendingDirection).toBe("eightysixed");

    await act(async () => {
      await hookApi().onConfirm86("Sold out");
    });

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/wines/wine-1/availability", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "eightysixed", note: "Sold out" }),
    });
    expect(toast.success).toHaveBeenCalledWith("Marked as 86'd");
    expect(hookApi().pendingDirection).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("toasts an error and keeps pendingDirection open on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Conflict." }), { status: 409 })),
    );
    const toast = { success: vi.fn(), error: vi.fn() };
    const setErrorMsg = vi.fn();
    await mount({ wineId: "wine-1", setErrorMsg, toast, refresh: vi.fn() });

    act(() => {
      hookApi().setPendingDirection("restored");
    });
    await act(async () => {
      await hookApi().onConfirm86(undefined);
    });

    expect(toast.error).toHaveBeenCalledWith("Toggle failed");
    expect(setErrorMsg).toHaveBeenCalledWith("Conflict.");
    expect(hookApi().pendingDirection).toBe("restored");
  });
});
