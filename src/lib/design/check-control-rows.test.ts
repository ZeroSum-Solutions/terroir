// GLOBAL-01 — the control-row ratchet's heuristic, tested against fixtures.
//
// Same shape as src/lib/feature-ledger/verify-feature-ledger.test.ts: the
// script exports its pure parts and the test imports them directly, so the
// gate's judgement is checked here rather than only in CI's exit code. The
// fixtures are the cases the heuristic was tuned on, written out so the next
// person changing it can see what it is supposed to say.

import { describe, expect, it } from "vitest";

import {
  countControlRows,
  findControlRows,
  routePathFor,
  total,
} from "../../../scripts/check-control-rows.mjs";

const ROW = (className: string, ...children: string[]) =>
  [`      <div className="${className}">`, ...children.map((c) => `        ${c}`), "      </div>"].join(
    "\n",
  );

describe("findControlRows", () => {
  it("counts a horizontal row of controls", () => {
    const source = ROW(
      "flex items-center gap-sm",
      '<button type="button">Open</button>',
      '<Link href="/x">Bins</Link>',
    );
    expect(findControlRows(source)).toEqual([1]);
  });

  it("counts stacked sibling rows separately — that is the violation", () => {
    const source = [
      ROW("flex items-center gap-sm", "<button>A</button>", "<button>B</button>"),
      ROW("flex items-center gap-xs", "<button>C</button>", "<button>D</button>"),
    ].join("\n");
    expect(countControlRows(source)).toBe(2);
  });

  it("counts a row holding several groups once, not once per group", () => {
    const source = [
      '      <div className="flex items-center gap-sm">',
      '        <div className="flex items-center gap-xs">',
      "          <button>A</button>",
      "          <button>B</button>",
      "        </div>",
      "        <button>C</button>",
      "      </div>",
    ].join("\n");
    expect(countControlRows(source)).toBe(1);
  });

  it("ignores a column — stacking is what the rule is about", () => {
    const source = ROW(
      "flex flex-col items-center gap-sm",
      "<button>A</button>",
      "<button>B</button>",
    );
    expect(countControlRows(source)).toBe(0);
  });

  it("ignores a row with only one control", () => {
    const source = ROW("flex items-center gap-sm", "<button>A</button>", "<span>label</span>");
    expect(countControlRows(source)).toBe(0);
  });

  it("ignores rows inside a repeated list item — they are one row, not N", () => {
    const source = [
      "      {wines.map((wine) => (",
      '        <div className="flex items-center gap-sm" key={wine.id}>',
      "          <button>Pour</button>",
      "          <button>86</button>",
      "        </div>",
      "      ))}",
    ].join("\n");
    expect(countControlRows(source)).toBe(0);
  });

  it("ignores rows inside a card, which belong to the card", () => {
    const source = [
      '      <div className="rounded-card border p-md">',
      '        <div className="flex items-center gap-sm">',
      "          <button>Edit</button>",
      "          <button>Delete</button>",
      "        </div>",
      "      </div>",
    ].join("\n");
    expect(countControlRows(source)).toBe(0);
  });

  it("ignores rows inside a dialog or overlay", () => {
    const source = [
      '      <div className="fixed inset-0 z-50">',
      '        <div className="flex items-center gap-sm">',
      "          <button>Cancel</button>",
      "          <button>Save</button>",
      "        </div>",
      "      </div>",
    ].join("\n");
    expect(countControlRows(source)).toBe(0);
  });

  it("reads a className that Prettier wrapped onto its own line", () => {
    const source = [
      "      <div",
      "        key={id}",
      '        className="flex items-center gap-sm"',
      "      >",
      "        <button>A</button>",
      "        <button>B</button>",
      "      </div>",
    ].join("\n");
    expect(countControlRows(source)).toBe(1);
  });

  it("still counts a control behind a conditional wrapper", () => {
    const source = [
      '      <div className="flex items-center gap-sm">',
      "        {canManage && (",
      "          <button>A</button>",
      "        )}",
      "        <button>B</button>",
      "      </div>",
    ].join("\n");
    expect(countControlRows(source)).toBe(1);
  });

  it("does not reach further than that — deep controls belong to the child", () => {
    const source = [
      '      <div className="flex items-center gap-sm">',
      "        <Summary>",
      "          <Detail>",
      "            <button>A</button>",
      "            <button>B</button>",
      "          </Detail>",
      "        </Summary>",
      "      </div>",
    ].join("\n");
    expect(countControlRows(source)).toBe(0);
  });
});

describe("routePathFor", () => {
  it("strips route groups the way the App Router does", () => {
    expect(routePathFor("root/lists/(index)", "root")).toBe("/lists");
    expect(routePathFor("root/cellar/[wineId]", "root")).toBe("/cellar/[wineId]");
  });
});

describe("total", () => {
  it("sums a baseline so the ratchet can refuse to grow", () => {
    expect(total({ "/cellar": 4, "/lists": 2 })).toBe(6);
  });
});
