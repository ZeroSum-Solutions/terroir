import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  producerPrefixCandidates,
  recoverProducerFromName,
  PRODUCER_PREFIX_MAX_WORDS,
} from "./producer-from-name";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

type Recorded = { table: string; column?: string; values?: unknown };

/**
 * Minimal PostgREST double. Builders are PLAIN thenables, not promises with an
 * assigned `then`, for the reason xwines-profile.test.ts records: `await`
 * short-circuits a native promise, so an own `then` on one never runs.
 */
function fakeSupabase(options: { winery?: string | null; fail?: boolean }) {
  const calls: Recorded[] = [];
  const supabase = {
    from: (table: string) => {
      const recorded: Recorded = { table };
      const settle = () => {
        calls.push(recorded);
        const payload = options.fail
          ? { data: null, error: { message: "boom" } }
          : {
              data:
                options.winery === undefined || options.winery === null
                  ? null
                  : { winery_name: options.winery },
              error: null,
            };
        return { then: (resolve: (value: unknown) => unknown) => resolve(payload) };
      };
      const self = {
        select: () => self,
        in: (column: string, values: unknown) => {
          recorded.column = column;
          recorded.values = values;
          return self;
        },
        order: () => self,
        limit: () => self,
        maybeSingle: settle,
      };
      return self;
    },
  } as unknown as SupabaseClient<Database>;
  return { supabase, calls };
}

describe("producerPrefixCandidates", () => {
  it("offers every leading-word prefix, longest first, with the rest as cuvée", () => {
    expect(producerPrefixCandidates("Benjamin Leroux Vosne-Romanée")).toEqual([
      { prefix: "Benjamin Leroux", cuvee: "Vosne-Romanée", words: 2 },
      { prefix: "Benjamin", cuvee: "Leroux Vosne-Romanée", words: 1 },
    ]);
  });

  it("always leaves at least one word behind for the cuvée", () => {
    // A name that is ENTIRELY a winery name has no cuvée to match on, and the
    // empty cuvée is not a question the corpus can answer.
    expect(producerPrefixCandidates("Penfolds")).toEqual([]);
    expect(producerPrefixCandidates("Bruno Giacosa").map((c) => c.prefix)).toEqual([
      "Bruno",
    ]);
  });

  it("stops at the longest producer the reference catalogues actually contain", () => {
    const name = Array.from({ length: 12 }, (_, i) => `w${i}`).join(" ");
    const words = producerPrefixCandidates(name).map((c) => c.words);
    expect(Math.max(...words)).toBe(PRODUCER_PREFIX_MAX_WORDS);
  });

  it("normalises the whitespace a pasted name arrives with", () => {
    expect(producerPrefixCandidates("  Bruno   Giacosa  Barolo ")[0]).toEqual({
      prefix: "Bruno Giacosa",
      cuvee: "Barolo",
      words: 2,
    });
  });

  it("drops a prefix it cannot send, rather than sending a broken filter", () => {
    // supabase-js quotes an `in.()` value containing [,()] but escapes nothing
    // inside the quotes, so a quote or backslash would change the shape of the
    // filter instead of the value in it. Losing a candidate costs a picture.
    const prefixes = producerPrefixCandidates('Ch"teau Back\\slash Rouge').map(
      (c) => c.prefix,
    );
    expect(prefixes).toEqual([]);
    // A comma or a dot is fine — those supabase-js does quote, or Postgrest
    // accepts bare. "A.F. Gros Richebourg Grand Cru" is a real row.
    expect(producerPrefixCandidates("A.F. Gros Richebourg")[0].prefix).toBe(
      "A.F. Gros",
    );
  });
});

describe("recoverProducerFromName", () => {
  it("returns the longest matching prefix with the cuvée that goes with it", async () => {
    const { supabase, calls } = fakeSupabase({ winery: "Benjamin Leroux" });
    const read = await recoverProducerFromName(supabase, "Benjamin Leroux Vosne-Romanée");
    expect(read).toEqual({
      status: "ok",
      value: { producer: "Benjamin Leroux", cuvee: "Vosne-Romanée", words: 2 },
    });
    // One query, and it asks the corpus about every candidate at once.
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("xwines_catalog");
    expect(calls[0].column).toBe("winery_name");
    expect(calls[0].values).toEqual(["Benjamin Leroux", "Benjamin"]);
  });

  it("asks nothing when the name cannot yield a candidate", async () => {
    const { supabase, calls } = fakeSupabase({ winery: "Penfolds" });
    expect(await recoverProducerFromName(supabase, "Penfolds")).toEqual({
      status: "ok",
      value: null,
    });
    expect(calls).toHaveLength(0);
  });

  it("reports an unmatched name as a real answer, not a failure", async () => {
    const { supabase } = fakeSupabase({ winery: null });
    expect(await recoverProducerFromName(supabase, "Unknown House Red")).toEqual({
      status: "ok",
      value: null,
    });
  });

  it("keeps 'we could not ask' separate from 'there is nothing'", async () => {
    const { supabase } = fakeSupabase({ fail: true });
    expect(await recoverProducerFromName(supabase, "Benjamin Leroux Vosne")).toEqual({
      status: "unavailable",
    });
  });

  it("refuses a winery the candidate list never proposed", async () => {
    // Ordering picked a row; if it is not one of the prefixes we asked about,
    // the cuvée that goes with it is unknown and inventing one would match on
    // a string this wine never contained.
    const { supabase } = fakeSupabase({ winery: "Somebody Else" });
    expect(await recoverProducerFromName(supabase, "Benjamin Leroux Vosne")).toEqual({
      status: "ok",
      value: null,
    });
  });
});
