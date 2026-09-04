/**
 * Mount a React element into a real DOM node under `act`, the way this
 * codebase tests components: raw react-dom/client on happy-dom, no
 * testing-library. Returns the container so assertions read `textContent`
 * and query the DOM directly.
 *
 * Call `cleanup()` in `afterEach`; each render owns one root.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { root: Root; container: HTMLDivElement }[] = [];

export async function mount(element: ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(element);
  });
  return container;
}

export async function cleanup() {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
}

/** Click a button and let React settle. */
export async function click(button: Element) {
  await act(async () => {
    (button as HTMLElement).click();
  });
}
