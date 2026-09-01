// Issue #101: the scan-history "All" option summed only
// complete + processing + failed, so a restaurant with review-status scans
// (PR #95's arithmetic-mismatch retry outcome) saw an All count smaller
// than the header's real row total, and had no option to filter down to
// just the rows that need a second look.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ScanStatusSelect } from "./scan-status-select";

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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("ScanStatusSelect", () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  async function mount() {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <ScanStatusSelect
          status="all"
          counts={{ complete: 5, processing: 2, review: 3, failed: 1 }}
        />,
      );
    });
    return container;
  }

  it("sums every status into the All option, including review rows", async () => {
    const container = await mount();
    const options = [...container.querySelectorAll("option")];
    const allOption = options.find((o) => o.value === "all")!;
    // 5 + 2 + 3 + 1 = 11, not the pre-fix 8 (complete + processing + failed).
    expect(allOption.textContent).toContain("11");
  });

  it("offers a chip to select review rows on their own, showing their count", async () => {
    const container = await mount();
    const options = [...container.querySelectorAll("option")];
    const reviewOption = options.find((o) => o.value === "review");
    expect(reviewOption).toBeDefined();
    expect(reviewOption!.textContent).toContain("Review");
    expect(reviewOption!.textContent).toContain("3");
  });
});
