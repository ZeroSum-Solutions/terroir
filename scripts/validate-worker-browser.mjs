import { accessSync, constants, statSync } from "node:fs";
import puppeteer from "puppeteer";

const executablePath = puppeteer.executablePath();

try {
  const executable = statSync(executablePath);
  if (!executable.isFile()) throw new Error("not a file");
  accessSync(executablePath, constants.X_OK);
} catch {
  throw new Error(
    "Worker browser executable is unavailable. Run pnpm worker:install-browser in the worker image.",
  );
}

console.log("worker-browser: ready");
