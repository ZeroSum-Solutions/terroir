import { accessSync, constants, statSync } from "node:fs";
import puppeteer from "puppeteer";

const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ??
  (process.platform === "linux" ? "/usr/bin/chromium" : puppeteer.executablePath());

try {
  const executable = statSync(executablePath);
  if (!executable.isFile()) throw new Error("not a file");
  accessSync(executablePath, constants.X_OK);
} catch {
  throw new Error(
    `Worker browser executable is unavailable at ${executablePath}.`,
  );
}

let browser;
try {
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setContent("<title>worker-browser-ready</title>", {
    waitUntil: "domcontentloaded",
    timeout: 10_000,
  });
  if ((await page.title()) !== "worker-browser-ready") {
    throw new Error("unexpected document title");
  }
} catch {
  throw new Error("Worker browser failed its headless launch smoke test.");
} finally {
  await browser?.close();
}

console.log("worker-browser: ready");
