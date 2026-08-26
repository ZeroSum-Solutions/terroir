"use client";

import { useState } from "react";
import { Grid2x2, Loader2, X, Wine } from "lucide-react";
import { useRouter } from "next/navigation";

type CellarConfig = {
  id: string;
  rows: number;
  columns: number;
  name: string;
};

type BinData = {
  wines: Array<{
    wineId: string;
    name: string;
    producer: string;
    vintage: number | null;
    quantity: number;
  }>;
  totalBottles: number;
};

type GridData = Record<string, BinData>;

const CELL_SIZE = 48;
const GAP = 4;
const LABEL_OFFSET = 28;

export function CellarSetup({ restaurantName: _restaurantName }: { restaurantName: string }) {
  const router = useRouter();
  const [setupRows, setSetupRows] = useState(10);
  const [setupCols, setSetupCols] = useState(10);
  const [creating, setCreating] = useState(false);

  const createCellar = async () => {
    setCreating(true);
    const res = await fetch("/api/cellar/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: setupRows, columns: setupCols }),
    });
    if (res.ok) {
      router.refresh();
    }
    setCreating(false);
  };

  return (
    <div className="mx-auto w-full max-w-[420px] rounded-card card-surface p-lg">
      <div className="mb-lg text-center">
        <Grid2x2
          className="mx-auto mb-md h-10 w-10 text-grey"
          strokeWidth={1.5}
        />
        <h2 className="text-[18px] font-serif font-medium text-ink">
          Set up your cellar grid
        </h2>
        <p className="mt-xs text-[13px] text-grey">
          Choose a grid size that matches your storage layout. You can change
          this later.
        </p>
      </div>

      <div className="mb-lg grid grid-cols-2 gap-md">
        <div>
          <label className="text-caption block font-medium uppercase text-grey">
            Rows
          </label>
          <input
            type="number"
            min={1}
            max={26}
            value={setupRows}
            onChange={(e) =>
              setSetupRows(Math.max(1, Math.min(26, +e.target.value)))
            }
            className="tabular mt-xs w-full rounded-pill border border-ink/20 bg-surface px-md py-sm text-center text-[16px] text-ink"
          />
        </div>
        <div>
          <label className="text-caption block font-medium uppercase text-grey">
            Columns
          </label>
          <input
            type="number"
            min={1}
            max={30}
            value={setupCols}
            onChange={(e) =>
              setSetupCols(Math.max(1, Math.min(30, +e.target.value)))
            }
            className="tabular mt-xs w-full rounded-pill border border-ink/20 bg-surface px-md py-sm text-center text-[16px] text-ink"
          />
        </div>
      </div>

      {/* Quick presets */}
      <div className="mb-lg flex gap-sm">
        {[
          { label: "5 x 5", r: 5, c: 5 },
          { label: "8 x 10", r: 8, c: 10 },
          { label: "10 x 10", r: 10, c: 10 },
        ].map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => {
              setSetupRows(preset.r);
              setSetupCols(preset.c);
            }}
            className={`flex-1 rounded-pill border px-sm py-xs text-[13px] font-medium transition-colors ${
              setupRows === preset.r && setupCols === preset.c
                ? "border-accent bg-blush-wash text-accent"
                : "border-ink/20 bg-surface text-grey hover:border-beige-deep"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={createCellar}
        disabled={creating}
        className="flex h-[38px] w-full items-center justify-center gap-xs rounded-pill bg-primary text-[14px] font-medium text-white hover:bg-primary-hover disabled:opacity-60"
      >
        {creating && (
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
        )}
        Create cellar
      </button>
    </div>
  );
}

export function CellarGridView({
  config,
  gridData,
}: {
  config: CellarConfig;
  gridData: GridData;
}) {
  const [selectedBin, setSelectedBin] = useState<string | null>(null);

  const svgWidth = LABEL_OFFSET + config.columns * (CELL_SIZE + GAP);
  const svgHeight = LABEL_OFFSET + config.rows * (CELL_SIZE + GAP);
  const selectedData = selectedBin ? gridData[selectedBin] : null;

  return (
    <>
      <div className="flex flex-col gap-lg md:flex-row">
        {/* SVG Grid */}
        <div className="flex-1 overflow-x-auto rounded-card card-surface p-md">
          <svg
            width={svgWidth}
            height={svgHeight}
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="block"
          >
            {/* Column labels */}
            {Array.from({ length: config.columns }, (_, c) => (
              <text
                key={`col-${c}`}
                x={LABEL_OFFSET + c * (CELL_SIZE + GAP) + CELL_SIZE / 2}
                y={LABEL_OFFSET - 8}
                textAnchor="middle"
                className="fill-grey"
                style={{ fontSize: 11, fontFamily: "var(--font-sans)" }}
              >
                {c + 1}
              </text>
            ))}

            {/* Row labels + cells */}
            {Array.from({ length: config.rows }, (_, r) => (
              <g key={`row-${r}`}>
                <text
                  x={LABEL_OFFSET - 8}
                  y={LABEL_OFFSET + r * (CELL_SIZE + GAP) + CELL_SIZE / 2 + 4}
                  textAnchor="end"
                  className="fill-grey"
                  style={{ fontSize: 11, fontFamily: "var(--font-sans)" }}
                >
                  {String.fromCharCode(65 + r)}
                </text>
                {Array.from({ length: config.columns }, (_, c) => {
                  const binId = `${String.fromCharCode(65 + r)}${c + 1}`;
                  const data = gridData[binId];
                  const total = data?.totalBottles ?? 0;

                  // Contract tokens only: beige-deep (empty), amber (low), sage (in stock).
                  // --t-* runtime vars so both themes retint the SVG; the
                  // canvas color reads on amber and sage in both modes.
                  let fill = "var(--t-hairline-strong)"; // empty — beige-deep alias
                  const textFill = "var(--t-canvas)";
                  if (total > 0 && total <= 2) {
                    fill = "var(--t-amber)"; // low
                  } else if (total > 2) {
                    fill = "var(--t-sage)"; // in stock
                  }

                  const isSelected = selectedBin === binId;

                  return (
                    <g key={binId}>
                      <rect
                        x={LABEL_OFFSET + c * (CELL_SIZE + GAP)}
                        y={LABEL_OFFSET + r * (CELL_SIZE + GAP)}
                        width={CELL_SIZE}
                        height={CELL_SIZE}
                        rx={4}
                        fill={fill}
                        stroke={isSelected ? "var(--t-accent)" : "transparent"}
                        strokeWidth={isSelected ? 2 : 0}
                        role="button"
                        tabIndex={0}
                        aria-label={`Bin ${binId}${total > 0 ? `, ${total} bottles` : ", empty"}`}
                        className="cursor-pointer transition-opacity hover:opacity-80"
                        onClick={() =>
                          setSelectedBin(isSelected ? null : binId)
                        }
                        onKeyDown={(e: React.KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedBin(isSelected ? null : binId);
                          }
                        }}
                      />
                      {total > 0 && (
                        <text
                          x={
                            LABEL_OFFSET +
                            c * (CELL_SIZE + GAP) +
                            CELL_SIZE / 2
                          }
                          y={
                            LABEL_OFFSET +
                            r * (CELL_SIZE + GAP) +
                            CELL_SIZE / 2 +
                            4
                          }
                          textAnchor="middle"
                          fill={textFill}
                          style={{
                            fontSize: 12,
                            fontFamily: "var(--font-sans)",
                            fontWeight: 500,
                          }}
                        >
                          {total}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            ))}
          </svg>
        </div>

        {/* Bin detail drawer */}
        {selectedBin && (
          <div className="w-full shrink-0 rounded-card card-surface p-lg md:w-[280px]">
            <div className="mb-md flex items-center justify-between">
              <h3 className="tabular text-[18px] font-medium text-ink">
                Bin {selectedBin}
              </h3>
              <button
                type="button"
                onClick={() => setSelectedBin(null)}
                aria-label="Close bin detail"
                className="flex h-8 w-8 items-center justify-center rounded-pill text-grey hover:bg-bridge-surface"
              >
                <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              </button>
            </div>

            {selectedData ? (
              <>
                <div className="mb-md text-[12px] text-grey">
                  {selectedData.totalBottles} bottle
                  {selectedData.totalBottles !== 1 ? "s" : ""}
                </div>
                <div className="flex flex-col gap-sm">
                  {selectedData.wines.map((w, i) => (
                    <div
                      key={`${w.wineId}-${i}`}
                      className="rounded-lg border border-hairline px-sm py-sm"
                    >
                      <div className="font-serif text-[17px] font-medium leading-snug text-ink">
                        {w.producer}, {w.name}
                      </div>
                      <div className="mt-2xs flex items-center gap-sm text-[12px] font-light text-grey">
                        <span className="tabular">
                          {w.vintage ?? "NV"}
                        </span>
                        <span>&middot;</span>
                        <span className="tabular">Qty {w.quantity}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center py-lg text-center">
                <Wine
                  className="mb-sm h-8 w-8 text-grey"
                  strokeWidth={1.5}
                />
                <p className="text-[13px] text-grey">
                  This bin is empty
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="mt-lg flex items-center gap-lg text-[12px] text-grey">
        <div className="flex items-center gap-xs">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: "#ADAA8A" }} />
          In stock (3+)
        </div>
        <div className="flex items-center gap-xs">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: "#8B6914" }} />
          Low (1-2)
        </div>
        <div className="flex items-center gap-xs">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: "#E3D9CB" }} />
          Empty
        </div>
      </div>
    </>
  );
}
