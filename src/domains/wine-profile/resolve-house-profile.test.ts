// The house aggregate's rules, tested without a database.
//
// The resolver itself is one `loadWineNotes` call and one call to the pure
// function below, so the rules that can actually be got wrong — what counts as
// a mention, whose n goes in which basis, what a mean over nothing is — are
// tested here where a case costs nothing to add. The live-DB half, which
// proves the query only ever sees confirmed descriptors from this tenant, is
// in resolve-house-profile.db.test.ts.
import { describe, expect, it } from "vitest";
import type { HouseNote } from "@/domains/notes/note-list";
import { AGGREGATE_FLOOR, aggregateHouseTaste } from "./resolve-house-profile";

let seq = 0;

function note(overrides: Partial<HouseNote> = {}): HouseNote {
  seq += 1;
  return {
    id: `n-${seq}`,
    body: "A note.",
    score: null,
    tastedOn: null,
    createdAt: "2026-09-01T12:00:00.000Z",
    attributed: true,
    authorName: "Somm",
    descriptors: [],
    ...overrides,
  };
}

const OAKY = { slug: "oaky", label: "Oaky", family: "oak" };
const RED_FRUIT = { slug: "red-fruit", label: "Red fruit", family: "fruit" };

describe("descriptor counts", () => {
  it("counts the notes that mention a descriptor, not the rows", () => {
    // Two different authors each confirming 'oaky' is two mentions. The
    // composite primary key makes one note carrying it twice impossible, so
    // anything other than 2 here means the aggregate is counting join rows.
    const { taste } = aggregateHouseTaste([
      note({ descriptors: [OAKY] }),
      note({ descriptors: [OAKY, RED_FRUIT] }),
      note({ descriptors: [RED_FRUIT] }),
    ]);

    expect(taste.value.descriptors).toEqual([
      { slug: "oaky", label: "Oaky", family: "oak", notes: 2 },
      { slug: "red-fruit", label: "Red fruit", family: "fruit", notes: 2 },
    ]);
  });

  it("orders by mentions, then alphabetically, so the order never wobbles", () => {
    // Without the tiebreak, two descriptors on the same count would come back
    // in whatever order the rows arrived, and the chip cloud would reshuffle
    // itself between two renders of identical data.
    const { taste } = aggregateHouseTaste([
      note({ descriptors: [RED_FRUIT, OAKY] }),
      note({ descriptors: [RED_FRUIT] }),
    ]);

    expect(taste.value.descriptors.map((d) => d.slug)).toEqual(["red-fruit", "oaky"]);
  });

  it("reports a corpus below the floor rather than hiding it", () => {
    // The resolver reports; the block decides. Returning an empty aggregate
    // below the floor would leave the block unable to tell "nobody has written
    // about this" apart from "two people have".
    const { taste } = aggregateHouseTaste([note({ descriptors: [OAKY] }), note()]);

    expect(taste.value.corpusSize).toBe(2);
    expect(taste.value.corpusSize).toBeLessThan(AGGREGATE_FLOOR);
    expect(taste.value.descriptors).toHaveLength(1);
  });

  it("has no descriptors and a zero corpus when nobody has written yet", () => {
    const { taste } = aggregateHouseTaste([]);

    expect(taste.value).toEqual({ descriptors: [], corpusSize: 0 });
    expect(taste.basis).toEqual({ kind: "house", notes: 0 });
  });
});

describe("the basis", () => {
  it("carries the note count the taste was aggregated from", () => {
    const { taste } = aggregateHouseTaste([note(), note(), note()]);

    expect(taste.basis).toEqual({ kind: "house", notes: 3 });
  });

  it("counts only scored notes in the SCORE's basis", () => {
    // The two n's are different claims. "Three people have written about this"
    // and "one person scored it 92" must not borrow each other's sample size:
    // a 92 captioned "from 3 notes" is a fabricated consensus.
    const { taste, score } = aggregateHouseTaste([
      note({ score: 92 }),
      note(),
      note(),
    ]);

    expect(taste.basis).toEqual({ kind: "house", notes: 3 });
    expect(score!.basis).toEqual({ kind: "house", notes: 1 });
  });
});

describe("the house score", () => {
  it("means the scores that exist and states the 100 scale", () => {
    const { score } = aggregateHouseTaste([
      note({ score: 90 }),
      note({ score: 93 }),
    ]);

    expect(score!.value).toEqual({ n: 91.5, scale: 100 });
  });

  it("rounds to one decimal rather than repeating", () => {
    // 91.66666666666667 beside a wine name is a machine talking, and a score
    // is a judgement — the extra digits claim a precision no palate has.
    const { score } = aggregateHouseTaste([
      note({ score: 90 }),
      note({ score: 92 }),
      note({ score: 93 }),
    ]);

    expect(score!.value.n).toBe(91.7);
  });

  it("is null, never NaN or zero, when no note carries a score", () => {
    // A mean over nothing is NaN, and NaN rendered through a number formatter
    // becomes 0 — a wine this house apparently rated zero out of a hundred.
    const { score } = aggregateHouseTaste([note(), note(), note()]);

    expect(score).toBeNull();
    expect(JSON.stringify(aggregateHouseTaste([note()]))).not.toContain("NaN");
  });

  it("does not let an unscored note drag the mean down", () => {
    // Treating null as 0 would turn one 92 among three notes into 30.7.
    const { score } = aggregateHouseTaste([
      note({ score: 92 }),
      note(),
      note(),
    ]);

    expect(score!.value.n).toBe(92);
  });
});
