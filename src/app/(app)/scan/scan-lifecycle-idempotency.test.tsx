// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { ScanReview } = await import("./components/scan-review");
const { ReExtractButton } = await import(
  "./[id]/components/re-extract-button"
);

const SCAN_ID = "11111111-1111-4111-8111-111111111111";

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function keyAt(index: number) {
  const init = mockFetch.mock.calls[index]?.[1] as RequestInit;
  return new Headers(init.headers).get("Idempotency-Key");
}

function bodyAt(index: number) {
  return String((mockFetch.mock.calls[index]?.[1] as RequestInit).body);
}

function button(container: HTMLElement, text: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Button ${text} not found`);
  return match as HTMLButtonElement;
}

function renderReview(root: Root) {
  root.render(
    <ScanReview
      id={SCAN_ID}
      distributor="Test Importer"
      invoiceNumber="INV-42"
      invoiceDate="2026-07-24"
      accuracy={98}
      itemCount={1}
      createdAt="2026-07-24T12:00:00.000Z"
      hasImage={false}
      items={[
        {
          id: "line-1",
          name: "Barolo",
          producer: "Test Producer",
          vintage: 2019,
          varietal: "Nebbiolo",
          region: "Piedmont",
          qty: 2,
          unitCost: 95,
          currency: "EUR",
          format: "1.5L",
          confidence: 0.98,
        },
      ]}
    />,
  );
}

describe("scan lifecycle idempotency callers", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    sessionStorage.clear();
    vi.stubGlobal("confirm", vi.fn(() => true));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.clear();
  });

  it("guards scan saves and reuses the exact command after ambiguity", async () => {
    const pending = deferredResponse();
    mockFetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(
        Response.json({ success: true, itemCount: 1 }),
      );
    await act(async () => renderReview(root));

    await act(async () => {
      button(container, "Save Edits").click();
      button(container, "Save Edits").click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const originalKey = keyAt(0);
    const originalBody = bodyAt(0);
    expect(originalKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);

    await act(async () => {
      pending.resolve(
        Response.json(
          {
            error: {
              code: "idempotency_unavailable",
              message: "Request idempotency is temporarily unavailable.",
            },
          },
          { status: 503 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Save outcome is unknown",
      ),
    );
    expect(sessionStorage.length).toBe(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      button(container, "Save Edits").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Edits saved.",
      ),
    );
    expect(keyAt(1)).toBe(originalKey);
    expect(bodyAt(1)).toBe(originalBody);
    expect(sessionStorage.length).toBe(0);
  });

  it("guards inventory commits and reuses the key after a lost response", async () => {
    const pending = deferredResponse();
    mockFetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(
        Response.json({ scanId: SCAN_ID, itemCount: 1, wineCount: 1 }),
      );
    await act(async () => renderReview(root));

    await act(async () => {
      button(container, "Commit to Inventory").click();
      button(container, "Commit to Inventory").click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const originalKey = keyAt(0);
    expect(originalKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(JSON.parse(bodyAt(0))).toBeNull();

    await act(async () => {
      pending.reject(new TypeError("connection reset after commit"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Commit outcome is unknown",
      ),
    );
    expect(sessionStorage.length).toBe(1);

    await act(async () => {
      button(container, "Commit to Inventory").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Committed ✓"),
    );
    expect(keyAt(1)).toBe(originalKey);
    expect(bodyAt(1)).toBe(bodyAt(0));
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps re-extract ambiguity visible while refreshing for reconciliation", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: "idempotency_unavailable",
            message: "Request idempotency is temporarily unavailable.",
          },
        },
        { status: 503 },
      ),
    );
    await act(async () => {
      root.render(<ReExtractButton scanId={SCAN_ID} />);
    });

    await act(async () => {
      button(container, "Re-run extraction").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "Re-extraction outcome is unknown",
      ),
    );
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(1);
  });

  it("guards re-extraction and starts a new command after proven non-commit failures", async () => {
    const pending = deferredResponse();
    mockFetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "rate_limited",
              message: "Extraction provider rate limited.",
            },
          },
          { status: 429 },
        ),
      );
    await act(async () => {
      root.render(<ReExtractButton scanId={SCAN_ID} />);
    });

    await act(async () => {
      button(container, "Re-run extraction").click();
      button(container, "Re-run extraction").click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const upstreamKey = keyAt(0);

    await act(async () => {
      pending.resolve(
        Response.json(
          {
            error: {
              code: "bad_gateway",
              message: "Extraction provider unavailable.",
            },
          },
          { status: 502 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "Extraction provider unavailable.",
      ),
    );
    expect(sessionStorage.length).toBe(0);

    await act(async () => {
      button(container, "Re-run extraction").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(keyAt(1)).not.toBe(upstreamKey);
    expect(sessionStorage.length).toBe(0);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
