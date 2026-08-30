// The operator-facing wait estimate and its plain-language wording. Both
// used to live inside two different React component files (session-step.tsx
// and import-client.tsx) and could only be observed through rendered copy.
import { describe, expect, it } from "vitest";
import {
  describeWaitEstimate,
  estimateChunkedPhaseWaitSeconds,
  formatRoughDuration,
} from "./wait-estimate";
import { LWIN_MATCH_UX_CEILING_SECONDS } from "./constants";

describe("estimateChunkedPhaseWaitSeconds", () => {
  it("charges one per-chunk LWIN budget per chunk, because chunks run sequentially", () => {
    expect(estimateChunkedPhaseWaitSeconds(1)).toBe(LWIN_MATCH_UX_CEILING_SECONDS);
    expect(estimateChunkedPhaseWaitSeconds(5)).toBe(5 * LWIN_MATCH_UX_CEILING_SECONDS);
  });
});

describe("formatRoughDuration", () => {
  it("stays in seconds below 90s", () => {
    expect(formatRoughDuration(45)).toBe("45s");
    expect(formatRoughDuration(89)).toBe("89s");
  });

  it("rounds up to whole minutes at 90s and above", () => {
    expect(formatRoughDuration(90)).toBe("2 minutes");
    expect(formatRoughDuration(120)).toBe("2 minutes");
    expect(formatRoughDuration(121)).toBe("3 minutes");
  });

  // Observation, not a change: the `minutes === 1 ? "" : "s"` singular
  // branch is unreachable — anything reaching it is >= 90s, which always
  // ceils to 2 or more minutes. Pinned so a future change to the 90s
  // cutover notices.
  it("never emits a one-minute reading, because the seconds branch covers everything under 90s", () => {
    expect(formatRoughDuration(60)).toBe("60s");
    expect(formatRoughDuration(90)).toBe("2 minutes");
  });
});

describe("describeWaitEstimate", () => {
  it("states the figure as an estimate, never as a guaranteed cap", () => {
    const copy = describeWaitEstimate(120);
    expect(copy).toContain("approximately 2 minutes");
    expect(copy).toContain("not a guaranteed cap");
    expect(copy).not.toContain("worst case");
  });
});
