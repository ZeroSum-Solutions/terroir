import { describe, expect, it } from "vitest";
import { renderTemplate } from "./templates";

/**
 * BUG-01 in the PDF. `renderItem` composes `${producer} ${name}` for all three
 * templates, and `wine-list-pdf-service` renders through it — so the printed
 * PDF a restaurant hands a guest carried the same doubled producer the screen
 * did, on every row whose `name` still holds its producer.
 */
function list(producer: string, name: string, nameOverride: string | null = null) {
  return {
    name: "Dinner",
    restaurantName: "Terroir Test",
    sections: [
      {
        name: "Reds",
        items: [
          {
            glass_price: 14,
            bottle_price: 58,
            tasting_note: null,
            name_override: nameOverride,
            wines: {
              name,
              producer,
              vintage: 2021,
              region: null,
              varietal: null,
            },
          },
        ],
      },
    ],
  };
}

describe.each(["classic", "modern", "minimal"] as const)(
  "renderTemplate(%s) — the producer, shown once",
  (template) => {
    it("does not repeat a producer already inside the wine name", () => {
      const html = renderTemplate(template, list("Esporão", "Esporão Reserva Tinto"), null);
      expect(html).toContain("Esporão Reserva Tinto");
      expect(html).not.toContain("Esporão Esporão");
    });

    it("keeps a name that merely opens with the producer's letters intact", () => {
      const html = renderTemplate(
        template,
        list("Oberrotweil", "Oberrotweiler Spätburgunder Spätlese Trocken"),
        null,
      );
      expect(html).toContain(
        "Oberrotweil Oberrotweiler Spätburgunder Spätlese Trocken",
      );
    });

    it("never rewrites a name_override", () => {
      const html = renderTemplate(
        template,
        list("Esporão", "Esporão Reserva Tinto", "Esporão Esporão, house pour"),
        null,
      );
      expect(html).toContain("Esporão Esporão, house pour");
    });
  },
);
