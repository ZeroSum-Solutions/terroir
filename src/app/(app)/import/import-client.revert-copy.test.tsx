// Sol audit 2026-08-27 round 5, findings 2 and 3 — pins the revert
// confirmation dialog's copy (must never claim absolute authorship/
// "nothing else is touched") and the post-revert success panel's copy
// (must compose every applicable cleanup notice, never swallow one via an
// else-if, and name orphan-wine cleanup specifically rather than a vague
// "catalog cleanup").
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { ImportClient } = await import("./import-client");

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

const BATCH_ID = "batch-1";

const BATCH_SUMMARY = {
  id: BATCH_ID,
  filename: "cellar.csv",
  status: "completed" as const,
  total_rows: 3,
  created_at: "2026-08-27T00:00:00.000Z",
  reverted_at: null,
};

const BATCH_ROW = {
  id: "row-1",
  row_number: 1,
  raw: { producer: "Domaine A", name: "Cuvee One" },
  row_state: "valid" as const,
  validation_errors: [],
  lwin_status: "matched" as const,
  lwin_id: "LWIN-1",
  cost_status: "present" as const,
  resolution: "auto" as const,
  manual_unit_cost: null,
  apply_status: "applied" as const,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Routes fetch calls this component makes on the way to the "batch" step
 * (recent-imports load + open-detail) and the revert POST itself. */
function stubFetch(revertBody: unknown) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/import/batches") ) {
      return Promise.resolve(jsonResponse({ batches: [BATCH_SUMMARY] }));
    }
    if (url.endsWith(`/api/import/batches/${BATCH_ID}`)) {
      return Promise.resolve(jsonResponse({ batch: BATCH_SUMMARY, rows: [BATCH_ROW] }));
    }
    if (url.endsWith(`/api/import/batches/${BATCH_ID}/revert`)) {
      return Promise.resolve(jsonResponse(revertBody));
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ImportClient revert copy", () => {
  const roots: Root[] = [];

  beforeEach(() => {
    // readStoredSession/writeStoredSession touch localStorage.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    });
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(element));
    return container;
  }

  /** Opens the recent import from the landing step, gets to "batch", then
   * opens the revert confirmation dialog. */
  async function openBatchWithRevertDialog(container: HTMLElement) {
    // Wait for the recent-imports list to render (loadRecent effect).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const openButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("cellar.csv"),
    )!;
    await act(async () => openButton.click());

    const revertButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Revert this import",
    )!;
    await act(async () => revertButton.click());
  }

  it("states the revert dialog's copy plainly — no absolute 'nothing else is touched' claim, no 'cannot confirm' completeness guarantee either (Sol audit round 7, finding 2 — replaces round 6's pinned string, which still claimed 'anything it cannot confirm is left in place and reported below,' overpromising completeness the child-insert race (import-client.tsx:862) does not keep: a same-moment reference can be deleted with no flag at all)", async () => {
    stubFetch({});
    const container = await mount(<ImportClient />);
    await openBatchWithRevertDialog(container);

    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain(
      "Removes the inventory this import created. Where it can safely confirm it, it also deletes wines only this import added and clears the wine-catalog (LWIN) links it wrote — including a link identical to one that existed before the import. Cleanup is best-effort: it deletes only wines it can confirm are unreferenced at that moment, and reports what it did below.",
    );
    expect(dialog.textContent).not.toContain("Nothing beyond this import's own additions is touched");
    expect(dialog.textContent).not.toContain("nothing else in your cellar is touched");
    expect(dialog.textContent).not.toContain("nothing else in your cellar references");
    expect(dialog.textContent).not.toContain("anything it cannot confirm is left in place");
  });

  it("pins the success-panel copy for a fully-clean revert — mirrors the dialog's 'where it can safely confirm it' framing with the actual counts (Sol audit round 6, finding 2)", async () => {
    stubFetch({
      revertedCount: 1,
      orphanWinesDeleted: 1,
      lwinStampsCleared: 2,
      cleanupTruncated: false,
      orphanCleanupSkipped: false,
      cleanupFailures: 0,
    });
    const container = await mount(<ImportClient />);
    await openBatchWithRevertDialog(container);

    const confirmButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Revert import",
    )!;
    await act(async () => confirmButton.click());

    expect(container.querySelector("h2")?.textContent).toBe("Import reverted");
    const text = container.textContent ?? "";
    expect(text).toContain(
      "Removed 1 inventory row(s) this import created. Where it could safely confirm it, this also deleted 1 wine(s) this import added and cleared 2 wine-catalog (LWIN) link(s) it wrote",
    );
    expect(text).not.toContain("Orphan-wine cleanup was skipped");
    expect(text).not.toContain("didn't finish in time");
    expect(text).not.toContain("Some cleanup steps failed");
  });

  it("composes BOTH the skipped and truncated notices when both flags are set — no else-if swallowing one (Sol audit round 5, finding 3)", async () => {
    stubFetch({
      revertedCount: 1,
      orphanWinesDeleted: 0,
      lwinStampsCleared: 0,
      cleanupTruncated: true,
      orphanCleanupSkipped: true,
      cleanupFailures: 0,
    });
    const container = await mount(<ImportClient />);
    await openBatchWithRevertDialog(container);
    const confirmButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Revert import",
    )!;
    await act(async () => confirmButton.click());

    const text = container.textContent ?? "";
    // The skipped notice must name orphan-wine cleanup specifically, not a
    // vague "Catalog cleanup" that would wrongly imply LWIN unstamping was
    // skipped too (it isn't — the unstamp path needs no service client).
    expect(text).toContain("Orphan-wine cleanup was skipped");
    expect(text).toContain("didn't finish in time and was left partial");
  });

  it("composes ALL THREE notices — skipped, truncated, AND failed — when all three flags are set (Sol audit round 6, finding 3 — the round-5 test only ever combined two of the three flags, leaving a three-flag composition unpinned)", async () => {
    stubFetch({
      revertedCount: 1,
      orphanWinesDeleted: 0,
      lwinStampsCleared: 0,
      cleanupTruncated: true,
      orphanCleanupSkipped: true,
      cleanupFailures: 3,
    });
    const container = await mount(<ImportClient />);
    await openBatchWithRevertDialog(container);
    const confirmButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Revert import",
    )!;
    await act(async () => confirmButton.click());

    const text = container.textContent ?? "";
    expect(text).toContain("Orphan-wine cleanup was skipped");
    expect(text).toContain("didn't finish in time and was left partial");
    expect(text).toContain("Some cleanup steps failed");
  });

  it("renders the failure notice when cleanupFailures > 0", async () => {
    stubFetch({
      revertedCount: 1,
      orphanWinesDeleted: 0,
      lwinStampsCleared: 0,
      cleanupTruncated: false,
      orphanCleanupSkipped: false,
      cleanupFailures: 2,
    });
    const container = await mount(<ImportClient />);
    await openBatchWithRevertDialog(container);
    const confirmButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Revert import",
    )!;
    await act(async () => confirmButton.click());

    const text = container.textContent ?? "";
    expect(text).toContain("Some cleanup steps failed");
  });
});
