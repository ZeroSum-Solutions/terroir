// P1 slice 3b — turning a parsed query into per-source predicates.
//
// Every expectation here is a MEASURED fact about the three corpora as they
// stand in the local stack, not a guess about how they ought to be spelled.
// The counts quoted in the comments came from the corpora themselves; they
// are the reason each mapping exists.
import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "./query-parse";
import { bodyRank, planSource } from "./search-filters";

const plan = (source: Parameters<typeof planSource>[0], query: string) =>
  planSource(source, parseSearchQuery(query));

describe("planSource — each corpus filtered in its own vocabulary", () => {
  it("matches countries exactly, because all three spell them the same way", () => {
    // Measured: lwin_catalog and xwines_catalog both store "United States",
    // and wines.country does too — the gazetteer canonical needs no mapping.
    for (const source of ["cellar", "lwin", "xwines"] as const) {
      expect(plan(source, "american cabernet").countries).toEqual(["United States"]);
    }
  });

  it("spells colour the way each corpus spells it", () => {
    // wines.colour is lowercase; lwin_catalog.colour drops the accent;
    // xwines_catalog.type keeps it.
    expect(plan("cellar", "rosé").colours).toEqual(["rose"]);
    expect(plan("lwin", "rosé").colours).toEqual(["Rose"]);
    expect(plan("xwines", "rosé").colours).toEqual(["Rosé"]);
  });

  it("expands a colour the corpus splits into more than one value", () => {
    // xwines_catalog.type has both "Dessert" and "Dessert/Port"; asking for
    // dessert wine and getting only half of them is a wrong answer.
    expect(plan("xwines", "dessert").colours).toEqual(["Dessert", "Dessert/Port"]);
  });

  it("refuses LWIN for a colour its vocabulary cannot express", () => {
    // Measured: lwin_catalog files its 5,598 Champagne rows as White (4,610)
    // and Rose (856) — the colour column has no sparkling concept at all. So
    // there is no predicate that means "sparkling" here. Returning LWIN rows
    // unfiltered would answer a sparkling question with still reds, which is
    // worse than answering with fewer rows.
    expect(plan("lwin", "sparkling from france").answerable).toBe(false);
    expect(plan("xwines", "sparkling from france").answerable).toBe(true);
    expect(plan("cellar", "sparkling from france").answerable).toBe(true);
  });

  it("still searches LWIN for a vintage, which it models at a coarser grain", () => {
    // lwin_catalog has no vintage column BY DESIGN — an LWIN row is the wine,
    // not the bottling year. That is an absent dimension, not a contradicted
    // one: showing the right wine at the right grain is not a wrong row, so
    // this must NOT skip the source the way an unmappable colour does.
    const lwin = plan("lwin", "2016 barolo");
    expect(lwin.answerable).toBe(true);
    expect(lwin.vintages).toEqual([]);
    expect(plan("cellar", "2016 barolo").vintages).toEqual([2016]);
    expect(plan("xwines", "2016 barolo").vintages).toEqual([2016]);
  });

  it("carries every spelling of a region, because each corpus knows only its own", () => {
    // Measured: lwin_catalog has 25,420 rows under "Burgundy" and 0 under
    // "Bourgogne"; xwines_catalog has 2,429 under "Bourgogne" and 0 under
    // "Burgundy". One canonical name reaches neither corpus reliably; the
    // gazetteer's own surface terms reach both.
    const or = plan("xwines", "burgundy chardonnay").regionOr ?? "";
    expect(or).toContain("burgundy");
    expect(or).toContain("bourgogne");
  });

  it("looks for a region in the wine's name as well as its region column", () => {
    // Measured: lwin_catalog matches 0 rows on region ilike '%napa%' and
    // 3,930 on display_name ilike '%napa%' — it files Napa wines under
    // California. A region predicate confined to the region column would
    // exclude every one of them and call that an answer.
    const or = plan("lwin", "napa valley cabernet").regionOr ?? "";
    expect(or).toContain("region.ilike");
    expect(or).toContain("display_name.ilike");
  });

  it("leaves the needle as the text to match, with no region or colour words in it", () => {
    const parsed = plan("xwines", "a crisp white from portugal");
    expect(parsed.text).toBe("");
    expect(parsed.textOr).toBeNull();
    expect(plan("xwines", "burgundy chardonnay").text).toBe("chardonnay");
  });

  it("matches free text across the columns that name a wine in each corpus", () => {
    expect(plan("lwin", "chardonnay").textOr).toContain("display_name.ilike");
    expect(plan("xwines", "chardonnay").textOr).toContain("winery_name.ilike");
    expect(plan("cellar", "chardonnay").textOr).toContain("producer.ilike");
  });

  it("quotes a needle containing LIKE wildcards rather than letting them match", () => {
    const or = plan("cellar", "100%").textOr ?? "";
    expect(or).toContain("\\%");
  });
});

describe("bodyRank — a preference ranks, it never excludes", () => {
  it("puts a wine matching the asked-for body above one that does not", () => {
    const { preferences } = parseSearchQuery("a crisp white");
    expect(bodyRank("Light-bodied", preferences)).toBeGreaterThan(
      bodyRank("Full-bodied", preferences),
    );
  });

  it("does not push an unrecorded body below a body that plainly disagrees", () => {
    // Body is recorded for a fraction of the corpus (program plan D1). A null
    // body means "we don't know how this tastes", and ranking it below a wine
    // we KNOW is the wrong shape would turn missing data into a verdict.
    const { preferences } = parseSearchQuery("a crisp white");
    expect(bodyRank(null, preferences)).toBeGreaterThanOrEqual(
      bodyRank("Full-bodied", preferences),
    );
  });

  it("ranks nothing when no body was asked for", () => {
    const { preferences } = parseSearchQuery("chablis");
    expect(bodyRank("Full-bodied", preferences)).toBe(bodyRank(null, preferences));
  });
});
