import { describe, expect, it } from "vitest";
import { describeScanStatusReason } from "./scan-status-reason";

describe("stalled scans have a stated reason", () => {
  it("renders the stalled code as prose, not as a raw code", () => {
    const prose = describeScanStatusReason("stalled");
    expect(prose).toMatch(/did not finish/i);
    expect(prose).not.toMatch(/recorded as/);
  });
});
