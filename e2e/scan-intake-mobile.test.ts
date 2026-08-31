import { expect, test, type Page } from "@playwright/test";
import { makeScan } from "../src/test/fixtures/invoices/scans";

/**
 * Regression coverage for the M0-1 mobile scan intake fix.
 *
 * Requires localhost Supabase + DEV_BYPASS_EMAIL, same as
 * demo-critical-journeys.test.ts. /api/scan and /api/scan-bottle are
 * intercepted via page.route() — these tests exercise the client
 * plumbing (file selection, request shape, UI states) at a real mobile
 * viewport, not the live Azure/Anthropic pipeline.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const devEmail = process.env.DEV_BYPASS_EMAIL;
const hasLocalFixtureCredentials = Boolean(
  supabaseUrl &&
    publishableKey &&
    serviceRoleKey &&
    devEmail &&
    ["localhost", "127.0.0.1"].includes(new URL(supabaseUrl).hostname),
);

// A trivial "looks like a PDF" buffer. These tests mock /api/scan via
// page.route(), so the request never reaches real OCR — only the file's
// declared mimeType/size need to satisfy client + route validation.
const fakePdf = (label: string) => Buffer.from(`%PDF-1.4 e2e fixture: ${label}`);

test.describe("mobile scan intake regression (M0-1)", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !hasLocalFixtureCredentials,
      "Requires localhost Supabase credentials and DEV_BYPASS_EMAIL.",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const res = await page.request.get("/api/dev-login");
    expect(res.ok()).toBeTruthy();
  });

  test("a camera-captured JPEG reaches a reviewable result", async ({ page }) => {
    const scan = makeScan();
    await page.route("**/api/scan", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scan) });
    });
    await gotoFreshScanPage(page);

    // Kimi audit sprint 1 (commit 4ef6b11, 2026-08-26) merged the standalone
    // "Take photo" button into the dashed capture zone itself — "one camera
    // entrance … the old 'Take photo' button duplicated the zone exactly"
    // (ready-view.tsx). That zone is still the camera trigger (its hidden
    // input has no `multiple`, same as before); its accessible name is now
    // its own heading text, "Tap to photograph".
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Tap to photograph" }).click();
    const chooser = await fileChooserPromise;
    expect(chooser.isMultiple()).toBe(false);
    await chooser.setFiles({
      name: "camera-capture.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });

    await expect(page.getByRole("heading", { name: "Invoice scan results" })).toBeVisible();
  });

  test("a single-page PDF upload reaches a reviewable result", async ({ page }) => {
    const scan = makeScan();
    let requestBody: string[] = [];
    await page.route("**/api/scan", async (route) => {
      const request = route.request();
      requestBody = [request.headers()["content-type"] ?? ""];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scan) });
    });
    await gotoFreshScanPage(page);

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload file" }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: fakePdf("single page") });

    await expect(page.getByRole("heading", { name: "Invoice scan results" })).toBeVisible();
    expect(requestBody[0]).toContain("multipart/form-data");
  });

  test("a multi-page invoice batch (2 photographed pages) sends every page to /api/scan", async ({ page }) => {
    // AF01: a PDF is already a complete multi-page document, so batching
    // more than one together is rejected client-side (see the "three PDFs"
    // test below) — this multi-file batch path is for photographing
    // several pages of ONE physical invoice, hence images here, not PDFs.
    const scan = makeScan();
    let fileFieldCount = 0;
    await page.route("**/api/scan", async (route) => {
      const body = route.request().postDataBuffer();
      fileFieldCount = body ? body.toString("latin1").split('name="file"').length - 1 : 0;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scan) });
    });
    await gotoFreshScanPage(page);

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload file" }).click();
    const chooser = await fileChooserPromise;
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles([
      { name: "page-1.jpg", mimeType: "image/jpeg", buffer: Buffer.from("page one") },
      { name: "page-2.jpg", mimeType: "image/jpeg", buffer: Buffer.from("page two") },
    ]);

    await expect(page.getByRole("heading", { name: "Invoice scan results" })).toBeVisible();
    expect(fileFieldCount).toBe(2);
  });

  test("AF01: three PDFs selected together fail immediately with a specific message and no network call", async ({ page }) => {
    // The owner's exact production report — uploading three PDFs (each a
    // complete multi-entry invoice) produced no usable result and no
    // visible error. Each PDF is already a complete document, so batching
    // several is rejected instantly instead of merged into one invoice.
    let scanRequests = 0;
    await page.route("**/api/scan", async (route) => {
      scanRequests += 1;
      await route.continue();
    });
    await gotoFreshScanPage(page);

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload file" }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles([
      { name: "invoice-1.pdf", mimeType: "application/pdf", buffer: fakePdf("invoice one") },
      { name: "invoice-2.pdf", mimeType: "application/pdf", buffer: fakePdf("invoice two") },
      { name: "invoice-3.pdf", mimeType: "application/pdf", buffer: fakePdf("invoice three") },
    ]);

    await expect(page.getByText("Couldn’t read the invoice")).toBeVisible();
    await expect(page.getByText(/3 PDFs/)).toBeVisible();
    await expect(page.getByText(/one PDF per invoice/)).toBeVisible();
    expect(scanRequests).toBe(0);
  });

  test("AF01 round 2: a PDF mixed with a JPEG fails immediately with a specific message and no network call", async ({ page }) => {
    // Round-2 gap the critic found: 1 PDF + 1 JPEG was silently accepted
    // and merged as "one invoice" — the original bug's mechanism via a
    // different file combination. A PDF may never be combined with
    // anything else, not just with other PDFs.
    let scanRequests = 0;
    await page.route("**/api/scan", async (route) => {
      scanRequests += 1;
      await route.continue();
    });
    await gotoFreshScanPage(page);

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload file" }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles([
      { name: "invoice.pdf", mimeType: "application/pdf", buffer: fakePdf("invoice") },
      { name: "extra-page.jpg", mimeType: "image/jpeg", buffer: Buffer.from("extra page") },
    ]);

    await expect(page.getByText("Couldn’t read the invoice")).toBeVisible();
    await expect(page.getByText(/complete invoice on its own/)).toBeVisible();
    expect(scanRequests).toBe(0);
  });

  test("AF01: an unsupported file type fails immediately with a specific message and no network call", async ({ page }) => {
    let scanRequests = 0;
    await page.route("**/api/scan", async (route) => {
      scanRequests += 1;
      await route.continue();
    });
    await gotoFreshScanPage(page);

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload file" }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not an invoice"),
    });

    await expect(page.getByText("Couldn’t read the invoice")).toBeVisible();
    await expect(page.getByText(/supported file type/)).toBeVisible();
    expect(scanRequests).toBe(0);
  });

  test("an oversized invoice file fails immediately with a specific message and no network call", async ({ page }) => {
    let scanRequests = 0;
    await page.route("**/api/scan", async (route) => {
      scanRequests += 1;
      await route.continue();
    });
    await gotoFreshScanPage(page);

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload file" }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({
      name: "huge-invoice.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.alloc(11 * 1024 * 1024, 65),
    });

    await expect(page.getByText("Couldn’t read the invoice")).toBeVisible();
    await expect(page.getByText(/10 MB/)).toBeVisible();
    expect(scanRequests).toBe(0);
  });

  test("bottle mode does not allow selecting more than one label photo", async ({ page }) => {
    await gotoFreshScanPage(page);
    await page.getByRole("button", { name: "Bottle", exact: true }).click();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload file" }).click();
    const chooser = await fileChooserPromise;
    expect(chooser.isMultiple()).toBe(false);

    await expect(
      chooser.setFiles([
        { name: "label-1.jpg", mimeType: "image/jpeg", buffer: Buffer.from("one") },
        { name: "label-2.jpg", mimeType: "image/jpeg", buffer: Buffer.from("two") },
      ]),
    ).rejects.toThrow();
  });
});

async function gotoFreshScanPage(page: Page) {
  await page.goto("/scan");
  await page.evaluate(() => localStorage.removeItem("terroir:current-scan"));
  await page.reload();
}
