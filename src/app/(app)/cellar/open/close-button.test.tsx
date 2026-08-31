import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/lib/toast";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const { CloseBottleButton } = await import("./close-button");

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
const roots: Root[] = [];

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  refresh.mockClear();
  document.body.innerHTML = "";
});

describe("CloseBottleButton mobile target", () => {
  it("keeps the close action at least 44px tall", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <CloseBottleButton bottleId="bottle-1" remainingOz={4.2} />
      </ToastProvider>,
    );

    expect(html).toContain("min-h-11");
  });
});

/**
 * SD-06 — a non-ok response from POST /api/open-bottles/{id}/close was
 * `console.error`'d and the confirm state reset. The bottle stayed open, the
 * page did not change, and nothing told the operator the discard had not
 * happened. Every other mutation in the app surfaces a toast or a
 * `role="alert"`; this one now does too.
 */
describe("CloseBottleButton failure reporting", () => {
  it("tells the operator when the close is refused, and does not refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "Bottle is already closed." } }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const container = await mount();
    await click(container, "Close bottle");
    await click(container, "Confirm discard 4.2 oz");

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Bottle is already closed.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("tells the operator when the request never reaches the server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network down")));

    const container = await mount();
    await click(container, "Close bottle");
    await click(container, "Confirm discard 4.2 oz");

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "Network down",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stays silent and refreshes when the close succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );

    const container = await mount();
    await click(container, "Close bottle");
    await click(container, "Confirm discard 4.2 oz");

    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });
});

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <ToastProvider>
        <CloseBottleButton bottleId="bottle-1" remainingOz={4.2} />
      </ToastProvider>,
    ),
  );
  return container;
}

async function click(container: HTMLElement, label: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!button) throw new Error(`No control labelled "${label}"`);
  await act(async () => {
    button.click();
  });
}
