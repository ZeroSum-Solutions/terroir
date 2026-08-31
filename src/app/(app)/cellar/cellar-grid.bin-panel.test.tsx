import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CellarGridView } from "./cellar-grid";
import type { BinWine, GridData } from "./grid-types";

/**
 * BUG-01 — the bin panel is the surface Devin photographed: it read
 * "Puy Florent, Puy Florent, Merlot, Pays d'Oc". Nothing concatenates the
 * producer twice; a CSV import wrote the producer into `name` and migration
 * `0137` recovered it into its own column without touching `name`, so the row
 * is right in the database and doubled here.
 *
 * The fixtures are shapes this checkout actually holds. `Oberrotweil` beside
 * `Oberrotweiler …` is the trap: a character-wise `startsWith` strip renders
 * it as "er Spätburgunder Spätlese Trocken".
 */

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
});

function binWine(overrides: Partial<BinWine> = {}): BinWine {
  return {
    wineId: "wine-1",
    name: "Reserva Tinto",
    producer: "Esporão",
    vintage: 2021,
    quantity: 3,
    heroImageUrl: null,
    colour: null,
    ...overrides,
  };
}

/** Open bin A1 and hand back its panel text. */
function openBinA1(wines: BinWine[]): string {
  const gridData: GridData = {
    A1: { wines, totalBottles: wines.reduce((n, w) => n + w.quantity, 0) },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <CellarGridView
        config={{ id: "cellar-1", rows: 2, columns: 2, name: "Main" }}
        gridData={gridData}
        onSelectWine={() => {}}
      />,
    );
  });

  const cell = container.querySelector<SVGRectElement>(
    '[aria-label^="Bin A1,"]',
  );
  if (!cell) throw new Error("Bin A1 cell not found");
  act(() => {
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  return container.textContent ?? "";
}

describe("bin panel — the producer, shown once", () => {
  it("does not repeat a producer that is already inside the wine name", () => {
    const text = openBinA1([
      binWine({ producer: "Puy Florent", name: "Puy Florent, Merlot, Pays d'Oc" }),
    ]);

    expect(text).toContain("Puy Florent, Merlot, Pays d'Oc");
    expect(text).not.toContain("Puy Florent, Puy Florent");
  });

  it("keeps a name that merely opens with the producer's letters intact", () => {
    const text = openBinA1([
      binWine({
        producer: "Oberrotweil",
        name: "Oberrotweiler Spätburgunder Spätlese Trocken",
      }),
    ]);

    expect(text).toContain(
      "Oberrotweil, Oberrotweiler Spätburgunder Spätlese Trocken",
    );
    expect(text).not.toContain("Oberrotweil, er Spätburgunder");
  });

  it("folds accents and case before deciding the producer is there", () => {
    const text = openBinA1([
      binWine({ producer: "Esporao", name: "Esporão Reserva Tinto" }),
    ]);

    expect(text).toContain("Esporao, Reserva Tinto");
  });

  it("leaves a wine whose producer is not in its name alone", () => {
    const text = openBinA1([binWine()]);

    expect(text).toContain("Esporão, Reserva Tinto");
  });

  it("shows a producer twice rather than nowhere when the name IS the producer", () => {
    const text = openBinA1([
      binWine({ producer: "Château Margaux", name: "Château Margaux" }),
    ]);

    expect(text).toContain("Château Margaux, Château Margaux");
  });
});
