import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MergeDuplicatesPanel } from "./merge-duplicates-panel";
import { baseRow } from "./test-row";

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

function Harness({ onMerged }: { onMerged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [, setErrorMsg] = useState<string | null>(null);
  return (
    <MergeDuplicatesPanel
      wineId="wine-target"
      duplicateRows={[baseRow({ wine_id: "wine-dup", producer: "Chateau", name: "Margaux", vintage: 2015 })]}
      busy={busy}
      setBusy={setBusy}
      setErrorMsg={setErrorMsg}
      toast={{ success: vi.fn(), error: vi.fn() }}
      refresh={vi.fn()}
      onMerged={onMerged}
    />
  );
}

describe("MergeDuplicatesPanel", () => {
  it("renders nothing when there are no duplicate rows", async () => {
    await act(async () => {
      root.render(
        <MergeDuplicatesPanel
          wineId="wine-target"
          duplicateRows={[]}
          busy={false}
          setBusy={vi.fn()}
          setErrorMsg={vi.fn()}
          toast={{ success: vi.fn(), error: vi.fn() }}
          refresh={vi.fn()}
          onMerged={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toBe("");
  });

  it("requires a confirm step, then posts source/target ids and calls onMerged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const onMerged = vi.fn();
    await act(async () => {
      root.render(<Harness onMerged={onMerged} />);
    });

    await act(async () => {
      button('Merge “Chateau Margaux 2015” into this record').click();
    });
    expect(button("Confirm merge")).toBeDefined();

    await act(async () => {
      button("Confirm merge").click();
    });

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/wines/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: "wine-dup", target_id: "wine-target" }),
    });
    expect(onMerged).toHaveBeenCalledOnce();
  });

  it("shows the server error message and does not call onMerged on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "Already merged." } }), { status: 409 }),
      ),
    );
    const onMerged = vi.fn();
    let lastError: string | null = null;
    function ErrorHarness() {
      const [busy, setBusy] = useState(false);
      const [errorMsg, setErrorMsg] = useState<string | null>(null);
      // In an effect, not during render: the React Compiler lint rejects
      // reassigning an outer binding while rendering.
      useEffect(() => {
        lastError = errorMsg;
      }, [errorMsg]);
      return (
        <MergeDuplicatesPanel
          wineId="wine-target"
          duplicateRows={[baseRow({ wine_id: "wine-dup" })]}
          busy={busy}
          setBusy={setBusy}
          setErrorMsg={setErrorMsg}
          toast={{ success: vi.fn(), error: vi.fn() }}
          refresh={vi.fn()}
          onMerged={onMerged}
        />
      );
    }
    await act(async () => {
      root.render(<ErrorHarness />);
    });
    await act(async () => {
      button('Merge “Producer Test Wine 2024” into this record').click();
    });
    await act(async () => {
      button("Confirm merge").click();
    });

    expect(lastError).toBe("Already merged.");
    expect(onMerged).not.toHaveBeenCalled();
  });
});
