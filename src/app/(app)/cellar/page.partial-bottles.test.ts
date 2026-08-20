import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Cellar partial-bottle row wiring", () => {
  it("keeps stored open remainder separate from recomputed theoretical remainder", () => {
    const source = readFileSync(resolve("src/app/(app)/cellar/page.tsx"), "utf8");

    expect(source).toMatch(/open_remaining_ml:\s*directOpen\?\.remaining_ml\s*\?\?\s*ob\?\.open_remaining_ml\s*\?\?\s*null/);
    expect(source).toMatch(/theoretical_remaining_ml:\s*directOpen\s*\?\s*theoreticalRemaining\(/);
  });
});
