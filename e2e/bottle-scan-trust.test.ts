import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BottleScanResult } from "../src/lib/scanner/types";

/**
 * Evidence for AF-D (walkthrough §1.2 — bottle-scan result trust): the
 * bottle-label flow acknowledges a photo immediately, shows an overall +
 * per-field AI match confidence, offers alternatives when confidence is
 * low, and gates any inventory write behind an explicit Confirm-or-Correct
 * choice. /api/scan-bottle is intercepted via page.route() — these tests
 * exercise the client UI at a real mobile viewport, not the live Anthropic
 * pipeline (that's covered separately by the real end-to-end scans).
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const devEmail = process.env.DEV_BYPASS_EMAIL;
const hasLocalFixtureCredentials = Boolean(
  supabaseUrl && publishableKey && serviceRoleKey && devEmail,
);

const SCREENSHOT_DIR = path.join(__dirname, "..", "docs", "screenshots", "af01-bottle-trust");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const tinyJpeg = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function highConfidenceResult(): BottleScanResult {
  return {
    candidates: [
      {
        name: "Clos des Chênes",
        producer: "Domaine Michel Lafarge",
        vintage: 2019,
        varietal: "Pinot Noir",
        region: "Volnay, Burgundy",
        country: "France",
        format: "750ml",
        confidence: 0.96,
        lowFields: [],
        notes: null,
      },
    ],
    parsedAt: "2026-08-22T12:00:00.000Z",
  };
}

function lowConfidenceResult(): BottleScanResult {
  return {
    candidates: [
      {
        name: "Volnay 1er Cru",
        producer: "Domaine Michel Lafarge",
        vintage: null,
        varietal: "Pinot Noir",
        region: "Burgundy",
        country: "France",
        format: null,
        confidence: 0.52,
        lowFields: ["vintage", "format"],
        notes: "Vintage obscured by a water-damaged label corner.",
      },
      {
        name: "Volnay Villages",
        producer: "Domaine Michel Lafarge",
        vintage: null,
        varietal: "Pinot Noir",
        region: "Burgundy",
        country: "France",
        format: null,
        confidence: 0.34,
        lowFields: ["name", "vintage"],
        notes: null,
      },
    ],
    parsedAt: "2026-08-22T12:05:00.000Z",
  };
}

test.describe("bottle-scan result trust (AF-D, walkthrough §1.2)", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !hasLocalFixtureCredentials,
      "Requires Supabase credentials and DEV_BYPASS_EMAIL for dev-login.",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const res = await page.request.get("/api/dev-login");
    expect(res.ok()).toBeTruthy();
  });

  test("acknowledges the photo immediately with a preview and progress state, before the network call resolves", async ({ page }) => {
    let releaseResponse: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (releaseResponse = resolve));
    await page.route("**/api/scan-bottle", async (route) => {
      await held;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(highConfidenceResult()),
      });
    });
    await gotoFreshScanPage(page);
    await page.getByRole("button", { name: "Bottle", exact: true }).click();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload file" }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({ name: "label.jpg", mimeType: "image/jpeg", buffer: tinyJpeg });

    // Immediate acknowledgment: the captured preview + a progress state
    // render before /api/scan-bottle has resolved — the request is still
    // held open at this point.
    //
    // Commit 8eb2e34 (WCAG 2.2 AA lint + axe gates, 2026-08-27) reworded this
    // preview's alt text from "Captured photo" to "What you captured"
    // (processing-view.tsx) — an a11y copy tweak, not a behavior change.
    await expect(page.getByRole("img", { name: "What you captured" })).toBeVisible();
    await expect(page.getByRole("progressbar")).toBeVisible();
    await expect(page.getByText("Reading the label")).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01-immediate-acknowledgment.png") });

    releaseResponse?.();
    await expect(page.getByRole("heading", { name: "Wine identified" })).toBeVisible();
  });

  test("shows overall + per-field AI match confidence for a high-confidence single candidate", async ({ page }) => {
    await page.route("**/api/scan-bottle", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(highConfidenceResult()),
      });
    });
    await gotoFreshScanPage(page);
    await page.getByRole("button", { name: "Bottle", exact: true }).click();
    await selectBottlePhoto(page);

    await expect(page.getByRole("heading", { name: "Wine identified" })).toBeVisible();
    await expect(page.getByText("AI match confidence")).toBeVisible();
    await expect(page.getByText("96%")).toBeVisible();
    await expect(page.getByText("Clos des Chênes")).toBeVisible();
    await expect(page.getByText("Domaine Michel Lafarge")).toBeVisible();
    // Honesty rule: self-assessed confidence is never relabeled as accuracy.
    await expect(page.getByText(/accuracy/i)).toHaveCount(0);
    // No alternatives for a single confident candidate.
    await expect(page.getByText("Other possible matches")).toHaveCount(0);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-result-high-confidence.png") });
  });

  test("flags low-confidence fields and offers selectable alternatives when confidence is low", async ({ page }) => {
    await page.route("**/api/scan-bottle", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(lowConfidenceResult()),
      });
    });
    await gotoFreshScanPage(page);
    await page.getByRole("button", { name: "Bottle", exact: true }).click();
    await selectBottlePhoto(page);

    await expect(page.getByRole("heading", { name: "Wine identified" })).toBeVisible();
    await expect(page.getByText(/Low AI match confidence \(52%\)/)).toBeVisible();
    await expect(page.getByText("Needs review").first()).toBeVisible();
    await expect(page.getByText("Other possible matches")).toBeVisible();
    await expect(page.getByRole("button", { name: /Volnay Villages/ })).toBeVisible();

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-result-low-confidence-alternatives.png") });

    // Alternatives are selectable in place.
    await page.getByRole("button", { name: /Volnay Villages/ }).click();
    await expect(page.getByText("34%").first()).toBeVisible();
  });

  test("gates the inventory write behind an explicit Confirm-or-Correct choice, and Correct reveals inline editing", async ({ page }) => {
    await page.route("**/api/scan-bottle", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(highConfidenceResult()),
      });
    });
    let saveCalls = 0;
    await page.route("**/api/inventory/save-bottle-scan", async (route) => {
      saveCalls += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ wineId: "wine-1" }) });
    });
    await gotoFreshScanPage(page);
    await page.getByRole("button", { name: "Bottle", exact: true }).click();
    await selectBottlePhoto(page);

    await expect(page.getByRole("heading", { name: "Wine identified" })).toBeVisible();
    // Nothing has written to inventory just by viewing the result.
    expect(saveCalls).toBe(0);

    await page.getByRole("button", { name: /correct details/i }).click();

    const nameInput = page.getByRole("textbox", { name: "Wine name" });
    await expect(nameInput).toHaveValue("Clos des Chênes");
    await nameInput.fill("Clos des Chênes 1er Cru");
    await nameInput.blur();

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04-correct-flow-inline-editing.png") });

    // Correcting does not itself commit anything.
    expect(saveCalls).toBe(0);

    await page.getByRole("button", { name: "Save to inventory" }).click();
    await expect.poll(() => saveCalls).toBe(1);
  });
});

async function selectBottlePhoto(page: Page) {
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload file" }).click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles({ name: "label.jpg", mimeType: "image/jpeg", buffer: tinyJpeg });
}

async function gotoFreshScanPage(page: Page) {
  await page.goto("/scan");
  await page.evaluate(() => localStorage.removeItem("terroir:current-scan"));
  await page.reload();
}
