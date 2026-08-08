import { accessSync, constants, statSync } from "node:fs";
import puppeteer from "puppeteer";
import { downloadBrowsers } from "puppeteer/internal/node/install.js";

await downloadBrowsers();

const executablePath = puppeteer.executablePath();
const executable = statSync(executablePath);
if (!executable.isFile()) {
  throw new Error("Installed browser executable is not a file.");
}
accessSync(executablePath, constants.X_OK);
console.log("worker-browser: installed");
