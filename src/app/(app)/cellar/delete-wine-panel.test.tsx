import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteWinePanel } from "./delete-wine-panel";

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

function button(text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === text)!;
}

function Harness({ onDeleted }: { onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [, setErrorMsg] = useState<string | null>(null);
  return (
    <DeleteWinePanel
      wineId="wine-1"
      busy={busy}
      setBusy={setBusy}
      setErrorMsg={setErrorMsg}
      toast={{ success: vi.fn(), error: vi.fn() }}
      refresh={vi.fn()}
      onDeleted={onDeleted}
    />
  );
}

describe("DeleteWinePanel", () => {
  it("shows the trigger first, requires confirmation before deleting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const onDeleted = vi.fn();
    await act(async () => {
      root.render(<Harness onDeleted={onDeleted} />);
    });

    expect(button("Delete wine")).toBeDefined();
    await act(async () => {
      button("Delete wine").click();
    });
    expect(container.textContent).toContain("Permanently delete this wine?");

    await act(async () => {
      button("Delete").click();
    });

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/cellar/wine-1", { method: "DELETE" });
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it("cancel returns to the trigger without deleting", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await act(async () => {
      root.render(<Harness onDeleted={vi.fn()} />);
    });
    await act(async () => {
      button("Delete wine").click();
    });
    await act(async () => {
      button("Cancel").click();
    });
    expect(button("Delete wine")).toBeDefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("surfaces the server error and does not call onDeleted on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "In use elsewhere." } }), { status: 409 }),
      ),
    );
    const onDeleted = vi.fn();
    let lastError: string | null = null;
    function ErrorHarness() {
      const [busy, setBusy] = useState(false);
      const [errorMsg, setErrorMsg] = useState<string | null>(null);
      lastError = errorMsg;
      return (
        <DeleteWinePanel
          wineId="wine-1"
          busy={busy}
          setBusy={setBusy}
          setErrorMsg={setErrorMsg}
          toast={{ success: vi.fn(), error: vi.fn() }}
          refresh={vi.fn()}
          onDeleted={onDeleted}
        />
      );
    }
    await act(async () => {
      root.render(<ErrorHarness />);
    });
    await act(async () => {
      button("Delete wine").click();
    });
    await act(async () => {
      button("Delete").click();
    });

    expect(lastError).toBe("In use elsewhere.");
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
