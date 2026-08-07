import { describe, expect, it } from "vitest";
import {
  findDeadInternalHrefs,
  scanSourceFile,
} from "../../../scripts/verify-ui-controls.mjs";

const policy = {
  placeholderPhrases: ["coming soon", "coming in v", "not implemented"],
  interactionTest: "e2e/ui-control-crawl.test.ts",
  sourceMappings: [{ pattern: "^src/app/", requirementId: "TER-CF-228" }],
};

function violations(source: string) {
  return scanSourceFile("src/app/example/page.tsx", source, policy).violations;
}

describe("UI control audit mutation shields", () => {
  it("rejects seeded placeholder copy", () => {
    expect(violations(`<button onClick={run}>Coming soon</button>`)).toEqual(
      expect.arrayContaining([expect.stringContaining("prohibited placeholder copy")]),
    );
  });

  it("rejects a seeded permanently disabled control", () => {
    expect(violations(`<button type="button" disabled>Export</button>`)).toEqual(
      expect.arrayContaining([expect.stringContaining("without an approved reason and recovery action")]),
    );
  });

  it("accepts an annotated unavailable state with a recovery action", () => {
    expect(
      violations(
        `<button type="button" disabled data-ui-unavailable-reason="Owner access required" data-ui-recovery-action="Ask an owner to change your role">Export</button>`,
      ),
    ).toEqual([]);
  });

  it("rejects a seeded dead link", () => {
    expect(violations(`<a href="#">Open report</a>`)).toEqual(
      expect.arrayContaining([expect.stringContaining("dead a href")]),
    );
  });

  it("rejects a seeded link to a missing internal route", () => {
    expect(
      findDeadInternalHrefs(
        [{ id: "example#link-001", href: "/missing" }],
        ["/", "/login", "/lists/:id"],
      ),
    ).toEqual(["example#link-001 points to missing internal route /missing"]);
  });

  it("rejects an explicit action button without a handler", () => {
    expect(violations(`<button type="button">Do work</button>`)).toEqual(
      expect.arrayContaining([expect.stringContaining("has no click handler")]),
    );
  });

  it("allows transient pending and validation disabled states", () => {
    expect(
      violations(
        `<form onSubmit={save}><button type="submit" disabled={pending || !valid}>Save</button></form>`,
      ),
    ).toEqual([]);
  });

  it("does not mistake input hints for promised placeholder UI", () => {
    expect(violations(`<input placeholder="Coming soon winery name" />`)).toEqual([]);
  });

  it("does not treat source comments as visible placeholder copy", () => {
    expect(violations(`// coming soon is not rendered\n<button onClick={run}>Run</button>`)).toEqual([]);
  });
});
