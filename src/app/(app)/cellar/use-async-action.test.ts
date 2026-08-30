import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAsyncAction } from "./use-async-action";

let container: HTMLDivElement;
let root: Root;
// Assigned from inside an effect, never during render — the React
// Compiler lint (react-hooks) rejects reassigning an outer binding
// while rendering. Mirrors use-cellar-url-state.test.tsx.
const holder: { current: ReturnType<typeof useAsyncAction> | null } = { current: null };
function hookApi(): ReturnType<typeof useAsyncAction> {
  if (!holder.current) throw new Error('Harness not rendered');
  return holder.current;
}

function Harness() {
  const value = useAsyncAction();
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
      runPromise = hookApi().run(async () => {
        await pending;
      });
    });
    expect(hookApi().busy).toBe(true);

    await act(async () => {
      resolveAction();
      await runPromise;
    });
    expect(hookApi().busy).toBe(false);
    expect(hookApi().error).toBeNull();
  });

  it("captures the thrown Error's message", async () => {
    await mount();
    await act(async () => {
      await hookApi().run(async () => {
        throw new Error("boom");
      });
    });
    expect(hookApi().busy).toBe(false);
    expect(hookApi().error).toBe("boom");
  });

  it("falls back to the provided message for a non-Error throw", async () => {
    await mount();
    await act(async () => {
      await hookApi().run(
        async () => {
          throw "nope";
        },
        { fallbackMessage: "Request failed." },
      );
    });
    expect(hookApi().error).toBe("Request failed.");
  });

  it("calls onError with the resolved message before setting local error", async () => {
    await mount();
    const onError = vi.fn();
    await act(async () => {
      await hookApi().run(
        async () => {
          throw new Error("network down");
        },
        { onError },
      );
    });
    expect(onError).toHaveBeenCalledWith("network down");
    expect(hookApi().error).toBe("network down");
  });

  it("clears a previous error at the start of the next run", async () => {
    await mount();
    await act(async () => {
      await hookApi().run(async () => {
        throw new Error("first failure");
      });
    });
    expect(hookApi().error).toBe("first failure");

    await act(async () => {
      await hookApi().run(async () => {});
    });
    expect(hookApi().error).toBeNull();
  });
});
