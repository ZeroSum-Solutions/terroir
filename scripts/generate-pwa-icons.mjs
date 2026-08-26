import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(projectRoot, "scripts/terroir-app-icon.svg");
const source = await readFile(sourcePath, "utf8");

const outputs = [
  { path: "src/app/icon.png", size: 512 },
  { path: "src/app/apple-icon.png", size: 180 },
  { path: "public/icons/icon-192.png", size: 192 },
  { path: "public/icons/icon-512.png", size: 512 },
  { path: "public/icons/icon-maskable-512.png", size: 512, maskable: true },
];

const browser = await chromium.launch({
  headless: true,
  args: ["--single-process"],
});

try {
  const page = await browser.newPage();

  for (const output of outputs) {
    await page.setViewportSize({ width: output.size, height: output.size });
    await page.setContent(`
      <style>
        html, body { margin: 0; width: 100%; height: 100%; background: transparent; }
        svg { display: block; width: 100%; height: 100%; }
      </style>
      ${source}
    `);

    if (output.maskable) {
      await page.locator("[data-background]").evaluate((background) => {
        background.setAttribute("rx", "0");
      });
      await page.locator("#glyph").evaluate((glyph) => {
        glyph.setAttribute(
          "transform",
          "translate(512 512) scale(0.82) translate(-512 -512)",
        );
      });
    }

    const outputPath = join(projectRoot, output.path);
    await mkdir(dirname(outputPath), { recursive: true });
    await page.screenshot({ path: outputPath, omitBackground: true });
  }
} finally {
  await browser.close();
}
