import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAsyncAction } from "./use-async-action";

let container: HTMLDivElement;
let root: Root;
let hook: ReturnType<typeof useAsyncAction>;

function Harness() {
  hook = useAsyncAction();
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
});

async function mount() {
  await act(async () => {
    root.render(createElement(Harness));
  });
}

describe("useAsyncAction", () => {
  it("tracks busy across the run and clears it on success", async () => {
    await mount();
    let resolveAction!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = hook.run(async () => {
        await pending;
      });
    });
    expect(hook.busy).toBe(true);

    await act(async () => {
      resolveAction();
      await runPromise;
    });
    expect(hook.busy).toBe(false);
    expect(hook.error).toBeNull();
  });

  it("captures the thrown Error's message", async () => {
    await mount();
    await act(async () => {
      await hook.run(async () => {
        throw new Error("boom");
      });
    });
    expect(hook.busy).toBe(false);
    expect(hook.error).toBe("boom");
  });

  it("falls back to the provided message for a non-Error throw", async () => {
    await mount();
    await act(async () => {
      await hook.run(
        async () => {
          throw "nope";
        },
        { fallbackMessage: "Request failed." },
      );
    });
    expect(hook.error).toBe("Request failed.");
  });

  it("calls onError with the resolved message before setting local error", async () => {
    await mount();
    const onError = vi.fn();
    await act(async () => {
      await hook.run(
        async () => {
          throw new Error("network down");
        },
        { onError },
      );
    });
    expect(onError).toHaveBeenCalledWith("network down");
    expect(hook.error).toBe("network down");
  });

  it("clears a previous error at the start of the next run", async () => {
    await mount();
    await act(async () => {
      await hook.run(async () => {
        throw new Error("first failure");
      });
    });
    expect(hook.error).toBe("first failure");

    await act(async () => {
      await hook.run(async () => {});
    });
    expect(hook.error).toBeNull();
  });
});
