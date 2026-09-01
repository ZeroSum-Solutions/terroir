// P1 slice 2c — the palette's all-scope miss hands its query to the
// companion. What this suite pins: an assistant-open request (the event bus
// in assistant-open.ts) opens the dialog from anywhere with the question
// prefilled AND already asked — the user typed the query and clicked "Ask
// the companion"; making them retype or resubmit it would be a dead end
// wearing a CTA's clothes.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestAssistant } from "./assistant-open";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const { AssistantPanel } = await import("./assistant-panel");

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const EMPTY_ANSWER = {
  query: { understood: ["white"], unrecognized: [] },
  cellar: [],
  cellarTotal: 0,
  corpus: [],
};

describe("AssistantPanel", () => {
  it("opens on an assistant request with the question prefilled and already asked", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => EMPTY_ANSWER,
    } as unknown as Response);

    await act(async () => {
      root.render(<AssistantPanel />);
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      requestAssistant("volcanic white for oysters");
    });

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const input = document.querySelector<HTMLInputElement>('input[type="text"]');
    expect(input?.value).toBe("volcanic white for oysters");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assistant?q=volcanic%20white%20for%20oysters",
    );
  });

  // The chips are how the panel shows its working. A constraint the parser
  // read but the panel never renders is a filter applied behind the user's
  // back — the same class of dishonesty as one dropped without a notice.
  it("shows an understood vintage as a chip", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        query: { vintages: [2018], understood: ["vintage"], unrecognized: [] },
        cellar: [],
        cellarTotal: 0,
        corpus: [],
      }),
    } as unknown as Response);

    await act(async () => {
      root.render(<AssistantPanel />);
    });
    await act(async () => {
      requestAssistant("a 2018 Barolo");
    });
    await act(async () => {});

    const chips = document.querySelector('[aria-label="Understood as"]');
    expect(chips?.textContent).toContain("2018");
  });

  it("opens empty from a request that carries no question", async () => {
    await act(async () => {
      root.render(<AssistantPanel />);
    });

    await act(async () => {
      requestAssistant(null);
    });

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const input = document.querySelector<HTMLInputElement>('input[type="text"]');
    expect(input?.value).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
