import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/lib/toast";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { EditMetadataModal } = await import("./edit-metadata-modal");

describe("EditMetadataModal", () => {
  it("keeps every form action and field touch sized", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <ToastProvider>
        <EditMetadataModal
          wineId="wine-1"
          initial={{
            producer: "Producer",
            name: "Wine",
            vintage: 2024,
            varietal: "Pinot Noir",
            region: "Willamette Valley",
            tasting_notes: "Cherry",
            drink_window_start: 2025,
            drink_window_end: 2035,
            peak_year: 2030,
          }}
          onClose={() => undefined}
        />
      </ToastProvider>,
    );

    const controls = document.querySelectorAll<HTMLElement>("input, button");
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.className).toContain("h-11");
    }
  });
});
