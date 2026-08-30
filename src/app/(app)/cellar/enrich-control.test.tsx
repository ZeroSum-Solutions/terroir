import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EnrichControl } from "./enrich-control";

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

function button() {
  return container.querySelector<HTMLButtonElement>("button")!;
}

function Harness({ setErrorMsg, refresh }: { setErrorMsg: (m: string | null) => void; refresh: () => void }) {
  return <EnrichControl wineId="wine-1" setErrorMsg={setErrorMsg} refresh={refresh} />;
}

describe("EnrichControl", () => {
  it("labels the source and calls refresh when enrichment finds one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ source: "claude_inference" }), { status: 200 }),
      ),
    );
    const refresh = vi.fn();
    await act(async () => {
      root.render(<Harness setErrorMsg={vi.fn()} refresh={refresh} />);
    });
    await act(async () => {
      button().click();
    });
    expect(container.textContent).toContain("Enriched via Claude AI.");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("shows the no-source message and does not refresh when enrichment finds nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ source: null, message: "No match found." }), { status: 200 }),
      ),
    );
    const refresh = vi.fn();
    await act(async () => {
      root.render(<Harness setErrorMsg={vi.fn()} refresh={refresh} />);
    });
    await act(async () => {
      button().click();
    });
    expect(container.textContent).toContain("No match found.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("forwards the failure message to the shared error banner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Rate limited." }), { status: 429 })),
    );
    const setErrorMsg = vi.fn();
    await act(async () => {
      root.render(<Harness setErrorMsg={setErrorMsg} refresh={vi.fn()} />);
    });
    await act(async () => {
      button().click();
    });
    expect(setErrorMsg).toHaveBeenCalledWith("Rate limited.");
    expect(button().textContent).toContain("Re-enrich");
  });
});
