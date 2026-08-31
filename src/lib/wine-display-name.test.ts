import { describe, expect, it } from "vitest";
import { wineDisplayName } from "./wine-display-name";

describe("wineDisplayName", () => {
  describe("BUG-01 — the exact strings Devin photographed", () => {
    it("drops the producer from the wine side-panel title", () => {
      // "Benoit Ente Benoit Ente, Puligny-Montrachet"
      expect(wineDisplayName("Benoit Ente", "Benoit Ente, Puligny-Montrachet"))
        .toBe("Puligny-Montrachet");
    });

    it("drops the producer from the bin panel title", () => {
      // "Puy Florent, Puy Florent, Merlot, Pays d'Oc"
      expect(wineDisplayName("Puy Florent", "Puy Florent, Merlot, Pays d'Oc"))
        .toBe("Merlot, Pays d'Oc");
    });
  });

  describe("rows migration 0137 created", () => {
    it("drops a producer 0137 recovered from lwin_catalog", () => {
      expect(wineDisplayName("Benjamin Leroux", "Benjamin Leroux Vosne-Romanée"))
        .toBe("Vosne-Romanée");
    });

    it("handles the two such rows this checkout actually holds", () => {
      expect(wineDisplayName("Esporão", "Esporão Reserva Tinto"))
        .toBe("Reserva Tinto");
      // The trap: a DIFFERENT word that opens the same way. A startsWith strip
      // renders this as "er Spätburgunder Spätlese Trocken".
      expect(
        wineDisplayName("Oberrotweil", "Oberrotweiler Spätburgunder Spätlese Trocken"),
      ).toBe("Oberrotweiler Spätburgunder Spätlese Trocken");
    });
  });

  describe("leaves the name alone", () => {
    it("when there is no producer", () => {
      expect(wineDisplayName(null, "Vosne-Romanée")).toBe("Vosne-Romanée");
      expect(wineDisplayName("", "Vosne-Romanée")).toBe("Vosne-Romanée");
      expect(wineDisplayName("   ", "Vosne-Romanée")).toBe("Vosne-Romanée");
    });

    it("when the producer is not at the front", () => {
      expect(wineDisplayName("Leroux", "Vosne-Romanée Leroux"))
        .toBe("Vosne-Romanée Leroux");
    });

    it("when only some of the producer's words match", () => {
      expect(wineDisplayName("Benjamin Leroux", "Benjamin Vosne-Romanée"))
        .toBe("Benjamin Vosne-Romanée");
    });

    it("when the name IS the producer, rather than rendering nothing", () => {
      expect(wineDisplayName("Château Margaux", "Château Margaux"))
        .toBe("Château Margaux");
      expect(wineDisplayName("Château Margaux", "Château Margaux,"))
        .toBe("Château Margaux,");
    });

    it("when the name is empty or missing", () => {
      expect(wineDisplayName("Esporão", "")).toBe("");
      expect(wineDisplayName("Esporão", null)).toBe("");
    });
  });

  describe("matches words, not bytes", () => {
    it("ignores accent and case differences between the two columns", () => {
      expect(wineDisplayName("esporao", "Esporão Reserva Tinto")).toBe("Reserva Tinto");
      expect(wineDisplayName("CHÂTEAU LATOUR", "Chateau Latour Grand Vin"))
        .toBe("Grand Vin");
    });

    it("steps over punctuation words inside the producer", () => {
      expect(wineDisplayName("Bérêche & Fils", "Bérêche & Fils Brut Réserve"))
        .toBe("Brut Réserve");
      expect(wineDisplayName("Bereche et Fils", "Bérêche & Fils Brut Réserve"))
        .toBe("Bérêche & Fils Brut Réserve");
    });

    it("tolerates collapsed and repeated whitespace", () => {
      expect(wineDisplayName("Benoit  Ente", "Benoit   Ente   Puligny"))
        .toBe("Puligny");
    });

    it("does not reorder — this is a prefix test, not an identity key", () => {
      // normalizeProducerOrCuvee sorts tokens so these two collide. Here they
      // must not: the producer is not at the front of this name.
      expect(wineDisplayName("Domaine Jean Grivot", "Jean Grivot Domaine Nuits"))
        .toBe("Jean Grivot Domaine Nuits");
    });
  });
});
