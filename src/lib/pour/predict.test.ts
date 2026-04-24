import { describe, it, expect } from "vitest";
import { predictOpenBottleAfterPour } from "./predict";

describe("predictOpenBottleAfterPour", () => {
  // RPC case 3 — simple pour from the open bottle.
  describe("partial (enough in open bottle)", () => {
    it("subtracts ml from the open bottle's remaining", () => {
      expect(
        predictOpenBottleAfterPour({
          openRemainingMl: 600,
          sizeMl: 750,
          sealedCount: 2,
          mlPoured: 150,
        }),
      ).toEqual({ kind: "partial", openRemainingMl: 450, sealedCountAfter: 2 });
    });

    it("leaves sealed stock untouched on partial", () => {
      const result = predictOpenBottleAfterPour({
        openRemainingMl: 500,
        sizeMl: 750,
        sealedCount: 0,
        mlPoured: 150,
      });
      expect(result).toEqual({
        kind: "partial",
        openRemainingMl: 350,
        sealedCountAfter: 0,
      });
    });

    // Boundary — ml exactly equals remaining. RPC uses `>=`, so this is
    // still a partial pour; remaining drains to 0 and is_open stays true
    // until the next pour triggers a new_bottle.
    it("drains the bottle to 0 when ml equals remaining exactly", () => {
      expect(
        predictOpenBottleAfterPour({
          openRemainingMl: 150,
          sizeMl: 750,
          sealedCount: 3,
          mlPoured: 150,
        }),
      ).toEqual({ kind: "partial", openRemainingMl: 0, sealedCountAfter: 3 });
    });

    // Edge — a zero-ml "pour" is a degenerate spill; RPC rejects p_ml<=0,
    // but predictor stays defined and just returns a no-op partial.
    it("returns the same remaining for mlPoured = 0", () => {
      expect(
        predictOpenBottleAfterPour({
          openRemainingMl: 500,
          sizeMl: 750,
          sealedCount: 1,
          mlPoured: 0,
        }),
      ).toEqual({ kind: "partial", openRemainingMl: 500, sealedCountAfter: 1 });
    });
  });

  // RPC case 4 — overage on open bottle, sealed replacement available.
  describe("cascade (finish + new + pour)", () => {
    it("opens a fresh bottle when current can't cover the pour", () => {
      expect(
        predictOpenBottleAfterPour({
          openRemainingMl: 50,
          sizeMl: 750,
          sealedCount: 2,
          mlPoured: 150,
        }),
      ).toEqual({
        kind: "cascade",
        openRemainingMl: 600,
        sealedCountAfter: 1,
      });
    });

    it("decrements sealed count by exactly 1 on cascade", () => {
      const result = predictOpenBottleAfterPour({
        openRemainingMl: 10,
        sizeMl: 750,
        sealedCount: 5,
        mlPoured: 148,
      });
      expect(result.kind).toBe("cascade");
      if (result.kind === "cascade") {
        expect(result.sealedCountAfter).toBe(4);
        expect(result.openRemainingMl).toBe(750 - 148);
      }
    });
  });

  // RPC case 2 — no open bottle but sealed stock: open one, pour from it.
  describe("cascade from no open bottle", () => {
    it("opens a new bottle when none is open but sealed stock exists", () => {
      expect(
        predictOpenBottleAfterPour({
          openRemainingMl: null,
          sizeMl: 750,
          sealedCount: 3,
          mlPoured: 150,
        }),
      ).toEqual({
        kind: "cascade",
        openRemainingMl: 600,
        sealedCountAfter: 2,
      });
    });

    it("clamps remaining to 0 if the pour exceeds a full bottle", () => {
      // Pathological case — covered by router.refresh in practice.
      const result = predictOpenBottleAfterPour({
        openRemainingMl: null,
        sizeMl: 750,
        sealedCount: 2,
        mlPoured: 1000,
      });
      expect(result.kind).toBe("cascade");
      if (result.kind === "cascade") {
        expect(result.openRemainingMl).toBe(0);
        expect(result.sealedCountAfter).toBe(1);
      }
    });
  });

  // RPC case 1 / 5 — OUT_OF_STOCK.
  describe("out_of_stock", () => {
    it("returns out_of_stock with no open bottle and no sealed", () => {
      expect(
        predictOpenBottleAfterPour({
          openRemainingMl: null,
          sizeMl: 750,
          sealedCount: 0,
          mlPoured: 150,
        }),
      ).toEqual({ kind: "out_of_stock" });
    });

    it("returns out_of_stock when overage meets zero sealed", () => {
      expect(
        predictOpenBottleAfterPour({
          openRemainingMl: 20,
          sizeMl: 750,
          sealedCount: 0,
          mlPoured: 150,
        }),
      ).toEqual({ kind: "out_of_stock" });
    });
  });
});
