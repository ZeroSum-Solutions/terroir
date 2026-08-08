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

console.log("worker-browser: ready");
