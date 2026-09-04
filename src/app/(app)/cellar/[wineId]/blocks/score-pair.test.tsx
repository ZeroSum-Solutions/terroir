// Every number on the page renders WITH its basis sentence. These tests are
// the answer to "the Sourced type is decorative": the type stops a bare number
// reaching the component; this stops the component rendering only `.value`.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, mount } from "@/test/render";
import { ScorePair } from "./score-pair";

afterEach(cleanup);

const HOUSE = { value: { n: 88, scale: 100 as const }, basis: { kind: "house" as const, notes: 14 } };

describe("ScorePair", () => {
  it("renders the house score beside its basis sentence", async () => {
    const el = await mount(<ScorePair house={HOUSE} reference={null} />);
    expect(el.textContent).toMatch(/88\s*\/\s*100/);
    expect(el.textContent).toMatch(/across 14 house notes/i);
  });

  it("never compares across scales silently", async () => {
    // A 4.2 beside an 88 with no scales shown reads as 4.2 out of 100.
    const el = await mount(
      <ScorePair
        house={HOUSE}
        reference={{ value: { n: 4.2, scale: 5 }, basis: { kind: "corpus", name: "X-Wines" } }}
      />,
    );
    expect(el.textContent).toMatch(/4\.2\s*\/\s*5/);
    expect(el.textContent).toMatch(/88\s*\/\s*100/);
    expect(el.textContent).toMatch(/X-Wines reference corpus/);
  });

  it("renders nothing at all when neither side has a score", async () => {
    // Not a heading over an empty row: an empty frame reads as a failed load.
    const el = await mount(<ScorePair house={null} reference={null} />);
    expect(el.textContent).toBe("");
  });

  it("links a sourced reference score to where it was read", async () => {
    const el = await mount(
      <ScorePair
        house={null}
        reference={{
          value: { n: 92, scale: 100 },
          basis: { kind: "sourced", name: "The Domaine", url: "https://example.test/sheet", asOf: "2026-08-14" },
        }}
      />,
    );
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://example.test/sheet");
  });
});
