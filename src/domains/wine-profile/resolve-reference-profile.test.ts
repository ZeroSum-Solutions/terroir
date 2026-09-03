// The reference side's selection rules, tested without a database.
//
// Every rule here decides what the page is ALLOWED to claim a source for, so
// each test names the lie it prevents rather than the branch it covers.
import { describe, expect, it } from "vitest";
import type { XWinesProfile } from "@/lib/wine-intelligence/xwines-profile";
import {
  selectReferenceProfile,
  type ReferenceNoteRow,
  type ReferenceWine,
} from "./resolve-reference-profile";

const WINE: ReferenceWine = {
  canonicalWineId: "cw-1",
  vintage: 2019,
  drinkWindowStart: null,
  drinkWindowEnd: null,
  drinkWindowBasis: null,
  drinkWindowSetBy: null,
  drinkWindowSetAt: null,
};

function row(overrides: Partial<ReferenceNoteRow> = {}): ReferenceNoteRow {
  return {
    vintage: 2019,
    source_kind: "producer",
    source_name: "Domaine Sheet",
    source_url: "https://example.test/sheet.pdf",
    fetched_at: "2026-08-14T00:00:00.000Z",
    body: "Tight now, opening after 2027.",
    score: null,
    score_scale: null,
    drink_window_start: null,
    drink_window_end: null,
    ...overrides,
  };
}

const PROFILE = {
  body: { low: "Light", high: "Bold", position: 0.75, label: "Full-bodied" },
  acidity: { low: "Soft", high: "Acidic", position: 0.85, label: "High acidity" },
} as XWinesProfile;

describe("the drink window", () => {
  it("prefers the house override over any source", () => {
    const { window } = selectReferenceProfile({
      wine: {
        ...WINE,
        drinkWindowStart: 2024,
        drinkWindowEnd: 2032,
        drinkWindowBasis: "override",
        drinkWindowSetBy: "u-1",
        drinkWindowSetAt: "2026-08-20T00:00:00.000Z",
      },
      rows: [row({ drink_window_start: 2022, drink_window_end: 2028 })],
      profile: null,
      overrideAuthorName: "Devin",
    });

    expect(window!.value).toEqual({ start: 2024, end: 2032 });
    expect(window!.basis).toEqual({
      kind: "override",
      by: "Devin",
      at: "2026-08-20T00:00:00.000Z",
    });
  });

  it("names the override's author even when we cannot resolve their name", () => {
    // "Set by someone here" is worth more than an unattributed window: the
    // reader still learns a person decided it, not a machine.
    const { window } = selectReferenceProfile({
      wine: {
        ...WINE,
        drinkWindowStart: 2024,
        drinkWindowEnd: 2032,
        drinkWindowBasis: "override",
        drinkWindowSetBy: "u-gone",
        drinkWindowSetAt: "2026-08-20T00:00:00.000Z",
      },
      rows: [],
      profile: null,
      overrideAuthorName: null,
    });

    expect(window!.basis).toMatchObject({ kind: "override", by: "someone here" });
  });

  it("falls back to a sourced window and carries its url and date", () => {
    const { window } = selectReferenceProfile({
      wine: WINE,
      rows: [row({ drink_window_start: 2022, drink_window_end: 2028 })],
      profile: null,
      overrideAuthorName: null,
    });

    expect(window!.value).toEqual({ start: 2022, end: 2028 });
    expect(window!.basis).toEqual({
      kind: "sourced",
      name: "Domaine Sheet",
      url: "https://example.test/sheet.pdf",
      asOf: "2026-08-14T00:00:00.000Z",
    });
  });

  it("returns null rather than an inferred window", () => {
    // The whole point of the retirement: an invented window is removed, not
    // captioned. There is deliberately no "estimate" basis to put it behind.
    const { window } = selectReferenceProfile({
      wine: {
        ...WINE,
        drinkWindowStart: 2020,
        drinkWindowEnd: 2030,
        drinkWindowBasis: "inferred",
      },
      rows: [],
      profile: null,
      overrideAuthorName: null,
    });

    expect(window).toBeNull();
  });

  it("ignores a window on the wine row that claims no basis at all", () => {
    // Pre-0148 rows carry values with no provenance. Rendering one would be the
    // same unsourced claim the rebuild exists to remove, minus even the label.
    const { window } = selectReferenceProfile({
      wine: { ...WINE, drinkWindowStart: 2020, drinkWindowEnd: 2030 },
      rows: [],
      profile: null,
      overrideAuthorName: null,
    });

    expect(window).toBeNull();
  });

  it("ignores an override whose years were never actually set", () => {
    // manual_overrides could name drink_window while the columns stayed null;
    // 0148's backfill writes basis from that array, so the pairing is possible.
    const { window } = selectReferenceProfile({
      wine: { ...WINE, drinkWindowBasis: "override", drinkWindowSetBy: "u-1" },
      rows: [],
      profile: null,
      overrideAuthorName: "Devin",
    });

    expect(window).toBeNull();
  });

  it("takes no window from a reference row that carries only half of one", () => {
    const { window } = selectReferenceProfile({
      wine: WINE,
      rows: [row({ drink_window_start: 2022 })],
      profile: null,
      overrideAuthorName: null,
    });

    expect(window).toBeNull();
  });
});

describe("the reference score", () => {
  it("names one source rather than blending two", () => {
    // Averaging a producer's 92 with a retailer's 88 produces a 90 nobody
    // published, under a basis that can only name one url.
    const { score } = selectReferenceProfile({
      wine: WINE,
      rows: [
        row({ source_name: "Older Retailer", source_kind: "retailer", score: 88, score_scale: 100, fetched_at: "2026-06-01T00:00:00.000Z" }),
        row({ source_name: "Newer Retailer", source_kind: "retailer", score: 92, score_scale: 100, fetched_at: "2026-08-01T00:00:00.000Z" }),
      ],
      profile: null,
      overrideAuthorName: null,
    });

    expect(score!.value).toEqual({ n: 92, scale: 100 });
    expect(score!.basis).toMatchObject({ kind: "sourced", name: "Newer Retailer" });
  });

  it("keeps a 5-point score on its own scale", () => {
    // A 4.2 silently rendered against a 100-point house score is worse than
    // showing no comparison at all.
    const { score } = selectReferenceProfile({
      wine: WINE,
      rows: [row({ score: 4.2, score_scale: 5 })],
      profile: null,
      overrideAuthorName: null,
    });

    expect(score!.value).toEqual({ n: 4.2, scale: 5 });
  });

  it("is null when no source published a score", () => {
    const { score } = selectReferenceProfile({
      wine: WINE,
      rows: [row()],
      profile: null,
      overrideAuthorName: null,
    });

    expect(score).toBeNull();
  });
});

describe("vintage containment", () => {
  it("never reads a reference note from another vintage", () => {
    // A 2015 retailer score rendered against a 2019 bottle, with a URL beside
    // it, is a sourced lie — worse than an unsourced guess, because the page
    // claims provenance for it.
    const result = selectReferenceProfile({
      wine: WINE,
      rows: [row({ vintage: 2015, score: 95, score_scale: 100, drink_window_start: 2018, drink_window_end: 2025 })],
      profile: null,
      overrideAuthorName: null,
    });

    expect(result.notes).toHaveLength(0);
    expect(result.score).toBeNull();
    expect(result.window).toBeNull();
  });

  it("reads nothing at all for a wine with no vintage", () => {
    // Every reference row is vintage-specific by design (D12). A non-vintage
    // bottle matches none of them, and must not borrow one.
    const result = selectReferenceProfile({
      wine: { ...WINE, vintage: null },
      rows: [row({ score: 95, score_scale: 100 })],
      profile: null,
      overrideAuthorName: null,
    });

    expect(result.notes).toHaveLength(0);
    expect(result.score).toBeNull();
  });
});

describe("reference notes", () => {
  it("carries each note's own source, and orders producer before retailer", () => {
    const { notes } = selectReferenceProfile({
      wine: WINE,
      rows: [
        row({ source_kind: "retailer", source_name: "A Retailer", body: "Retailer words." }),
        row({ source_kind: "producer", source_name: "The Domaine", body: "Producer words." }),
      ],
      profile: null,
      overrideAuthorName: null,
    });

    expect(notes.map((n) => n.value)).toEqual(["Producer words.", "Retailer words."]);
    expect(notes[0].basis).toMatchObject({ kind: "sourced", name: "The Domaine" });
  });

  it("drops a row whose body is empty rather than rendering a blank quote", () => {
    const { notes } = selectReferenceProfile({
      wine: WINE,
      rows: [row({ body: null }), row({ source_name: "Other", body: "   " })],
      profile: null,
      overrideAuthorName: null,
    });

    expect(notes).toEqual([]);
  });
});

describe("corpus structure", () => {
  it("reports body and acidity under the corpus's own basis", () => {
    const { structure } = selectReferenceProfile({
      wine: WINE,
      rows: [],
      profile: PROFILE,
      overrideAuthorName: null,
    });

    expect(structure!.value.body!.label).toBe("Full-bodied");
    expect(structure!.value.acidity!.label).toBe("High acidity");
    expect(structure!.basis).toEqual({ kind: "corpus", name: "X-Wines" });
  });

  it("is null when the corpus knows neither axis", () => {
    // Not an empty structure: an empty one renders a heading over nothing.
    const { structure } = selectReferenceProfile({
      wine: WINE,
      rows: [],
      profile: { body: null, acidity: null } as XWinesProfile,
      overrideAuthorName: null,
    });

    expect(structure).toBeNull();
  });

  it("carries a single known axis rather than dropping the pair", () => {
    const { structure } = selectReferenceProfile({
      wine: WINE,
      rows: [],
      profile: { ...PROFILE, acidity: null } as XWinesProfile,
      overrideAuthorName: null,
    });

    expect(structure!.value.body).not.toBeNull();
    expect(structure!.value.acidity).toBeNull();
  });
});
