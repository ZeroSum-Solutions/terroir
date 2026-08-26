import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCellarControl } from "./voice-cellar-control";
import type { VoiceResolveResponse } from "@/lib/wine-intelligence/voice-resolve-types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class MockMediaRecorder {
  static isTypeSupported = vi.fn((type: string) => type.includes("webm"));
  static instances: MockMediaRecorder[] = [];

  readonly mimeType: string;
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    MockMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["voice"], { type: this.mimeType }),
    } as BlobEvent);
    this.onstop?.();
  }
}

const stopTrack = vi.fn();
const getUserMedia = vi.fn(async () => ({
  getTracks: () => [{ stop: stopTrack }],
}) as unknown as MediaStream);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  MockMediaRecorder.instances = [];
  vi.stubGlobal("MediaRecorder", MockMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockVoiceFetch(outcome: VoiceResolveResponse, available = true) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      return Response.json({ available });
    }
    return Response.json(outcome, {
      status:
        outcome.kind === "stt_failed"
          ? outcome.reason === "timeout" ? 504 : 502
          : outcome.kind === "unavailable"
            ? 503
            : 200,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockVoiceErrorFetch(status: number, message: string) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      return Response.json({ available: true });
    }
    return Response.json(
      { error: { code: "rejected", message } },
      { status },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderControl(onResolve = vi.fn()) {
  await act(async () => {
    root.render(<VoiceCellarControl onResolve={onResolve} />);
  });
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalled();
  });
  return onResolve;
}

async function recordOnce() {
  const start = await vi.waitFor(() => {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Find a cellar wine by voice"]',
    );
    expect(button).not.toBeNull();
    return button!;
  });
  await act(async () => start.click());
  const stop = await vi.waitFor(() => {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop voice search"]',
    );
    expect(button).not.toBeNull();
    return button!;
  });
  await act(async () => stop.click());
}

describe("VoiceCellarControl mobile flow", () => {
  it("hides the mic when the server reports voice unavailable", async () => {
    mockVoiceFetch({ kind: "unavailable", reason: "voice_unavailable" }, false);

    await renderControl();

    expect(
      container.querySelector('button[aria-label="Find a cellar wine by voice"]'),
    ).toBeNull();
  });

  it("records and applies a resolved wine through the parent selection mechanism", async () => {
    mockVoiceFetch({
      kind: "resolved",
      transcript: "find Guigal La Mouline",
      item: {
        itemId: "wine-1",
        name: "La Mouline",
        producer: "Guigal",
        locations: ["A-12"],
      },
    });
    const onResolve = await renderControl(vi.fn());

    await recordOnce();

    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledWith("wine-1"));
    expect(stopTrack).toHaveBeenCalled();
  });

  it("records an ambiguous result and applies the candidate chosen in the picker", async () => {
    mockVoiceFetch({
      kind: "ambiguous",
      transcript: "find Roumier Musigny",
      candidates: [
        {
          itemId: "wine-musigny",
          name: "Musigny",
          producer: "Roumier",
          locations: ["C-01"],
        },
        {
          itemId: "wine-vv",
          name: "Musigny Vieilles Vignes",
          producer: "Roumier",
          locations: ["C-02"],
        },
      ],
    });
    const onResolve = await renderControl(vi.fn());

    await recordOnce();

    const dialog = await vi.waitFor(() => {
      const value = container.querySelector<HTMLElement>('[role="dialog"]');
      expect(value?.textContent).toContain("Which cellar wine?");
      return value!;
    });
    const choice = [...dialog.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Musigny Vieilles Vignes"),
    )!;
    await act(async () => choice.click());
    expect(onResolve).toHaveBeenCalledWith("wine-vv");
  });

  it("shows a non-blocking heard-transcript notice when the resolver abstains", async () => {
    mockVoiceFetch({
      kind: "abstain",
      reason: "below_threshold",
      message: "Couldn't find that cellar wine.",
      transcript: "what is the weather tomorrow",
    });

    await renderControl();
    await recordOnce();

    await vi.waitFor(() => {
      const status = container.querySelector('[role="status"]');
      expect(status?.textContent).toContain("Didn't catch a cellar wine");
      expect(status?.textContent).toContain("heard: what is the weather tomorrow");
    });
  });

  it("keeps the mic mounted and shows a notice when a POST reports voice unavailable", async () => {
    // Regression: key present at GET, gone at POST (rotation mid-session).
    // The old catch-all did setAvailable(false), silently unmounting the mic
    // AND the notice — the feature vanished with zero feedback.
    mockVoiceFetch({ kind: "unavailable", reason: "voice_unavailable" }, true);

    await renderControl();
    await recordOnce();

    await vi.waitFor(() => {
      const status = container.querySelector('[role="status"]');
      expect(status?.textContent).toContain("temporarily unavailable");
    });
    expect(
      container.querySelector('button[aria-label="Find a cellar wine by voice"]'),
    ).not.toBeNull();
  });

  it("surfaces the server's rejection message when the POST returns an error envelope", async () => {
    mockVoiceErrorFetch(413, "Voice recording must be under 2 MB.");

    await renderControl();
    await recordOnce();

    await vi.waitFor(() => {
      const status = container.querySelector('[role="status"]');
      expect(status?.textContent).toContain("Voice recording must be under 2 MB.");
    });
  });

  it("handles microphone permission denial without posting audio", async () => {
    const fetchMock = mockVoiceFetch({
      kind: "abstain",
      reason: "empty_transcript",
      message: "Couldn't find that cellar wine.",
      transcript: "",
    });
    getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));

    await renderControl();
    const mic = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Find a cellar wine by voice"]',
    )!;
    await act(async () => mic.click());

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Microphone permission is needed for voice search.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
