import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExportCsvButton } from "./export-csv-button";

describe("ExportCsvButton mobile reachability", () => {
  it("renders a 44px-tall download action", () => {
    const html = renderToStaticMarkup(
      <ExportCsvButton
        rows={[
          {
            invoice_date: "2026-08-21",
            created_at: "2026-08-21T12:00:00.000Z",
            distributor_name: "Demo Wines",
            invoice_number: "INV-1",
            item_count: 2,
            status: "complete",
            accuracy_score: 0.98,
          },
        ]}
      />,
    );

    expect(html).toContain("min-h-11");
  });
});
