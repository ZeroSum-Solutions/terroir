import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PourActionBar } from "./pour-action-bar";
import { baseRow } from "./test-row";

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
});

function button(text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === text);
}

describe("PourActionBar", () => {
  it("renders only Open bottle when the wine cannot be poured", async () => {
    const doOpenBottle = vi.fn();
    await act(async () => {
      root.render(
        <PourActionBar
          row={baseRow({ sealed_count: 2, glass_pour_ml: null })}
          canPour={false}
          outOfStock={false}
          pickerItem={null}
          busy={false}
          openBottleBusy={false}
          lastPour={null}
          doOpenBottle={doOpenBottle}
          doPour={vi.fn()}
          doUndo={vi.fn()}
          onOpenPicker={vi.fn()}
        />,
      );
    });

    expect(button("Open bottle")).toBeDefined();
    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Pour")),
    ).toBe(false);

    await act(async () => {
      button("Open bottle")!.click();
    });
    expect(doOpenBottle).toHaveBeenCalledOnce();
  });

  it("calls doPour with the glass pour size", async () => {
    const doPour = vi.fn();
    await act(async () => {
      root.render(
        <PourActionBar
          row={baseRow({ sealed_count: 0, glass_pour_ml: 150 })}
          canPour={true}
          outOfStock={false}
          pickerItem={null}
          busy={false}
          openBottleBusy={false}
          lastPour={null}
          doOpenBottle={vi.fn()}
          doPour={doPour}
          doUndo={vi.fn()}
          onOpenPicker={vi.fn()}
        />,
      );
    });

    const pourButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Pour"),
    )!;
    await act(async () => {
      pourButton.click();
    });
    expect(doPour).toHaveBeenCalledWith(150);
  });

  it("shows the undo button only when there is a last pour and canPour", async () => {
    const doUndo = vi.fn();
    await act(async () => {
      root.render(
        <PourActionBar
          row={baseRow({ sealed_count: 0, glass_pour_ml: 150 })}
          canPour={true}
          outOfStock={false}
          pickerItem={null}
          busy={false}
          openBottleBusy={false}
          lastPour={{ ml: 150 }}
          doOpenBottle={vi.fn()}
          doPour={vi.fn()}
          doUndo={doUndo}
          onOpenPicker={vi.fn()}
        />,
      );
    });

    const undoButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Undo last pour"),
    )!;
    expect(undoButton).toBeDefined();
    await act(async () => {
      undoButton.click();
    });
    expect(doUndo).toHaveBeenCalledOnce();
  });

  it("disables the pour button and shows Out of stock when out of stock", async () => {
    await act(async () => {
      root.render(
        <PourActionBar
          row={baseRow({ sealed_count: 0, glass_pour_ml: 150 })}
          canPour={true}
          outOfStock={true}
          pickerItem={null}
          busy={false}
          openBottleBusy={false}
          lastPour={null}
          doOpenBottle={vi.fn()}
          doPour={vi.fn()}
          doUndo={vi.fn()}
          onOpenPicker={vi.fn()}
        />,
      );
    });
    const pourButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Out of stock",
    )!;
    expect(pourButton).toBeDefined();
    expect(pourButton.disabled).toBe(true);
  });
});
