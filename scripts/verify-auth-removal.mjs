#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const self = "scripts/verify-auth-removal.mjs";
const negativeBrowserTest = "e2e/auth/bypass-removed.test.ts";
const operatorRevocationRunbook = "docs/runbooks/TER-011-auth-removal.md";
const forbiddenPatterns = [
  /TEMP_AUTH_BYPASS/i,
  /DEV_BYPASS_EMAIL/i,
  /temporary-bypass/i,
  /\/api\/dev-login/i,
  /\bdev-login\b/i,
];

function trackedFiles() {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: projectRoot,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean)
    .filter(
      (file) =>
        file !== self &&
        file !== negativeBrowserTest &&
        file !== operatorRevocationRunbook,
    );
}

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile() && lstatSync(path).size <= 10_000_000) files.push(path);
  }
  return files;
}

function scanFile(path, label) {
  if (!existsSync(path)) return [];
  const content = readFileSync(path).toString("utf8");
  return forbiddenPatterns
    .filter((pattern) => pattern.test(content) || pattern.test(label))
    .map((pattern) => `${label}: matches ${pattern}`);
}

const findings = trackedFiles().flatMap((file) =>
  scanFile(join(projectRoot, file), file),
);

for (const requiredControl of [negativeBrowserTest, operatorRevocationRunbook]) {
  const path = join(projectRoot, requiredControl);
  if (!existsSync(path) || lstatSync(path).size === 0) {
    findings.push(`${requiredControl}: required removal control is missing`);
  }
}

const routeDirectory = join(projectRoot, "src/app/api/dev-login");
if (filesBelow(routeDirectory).length > 0) {
  findings.push("src/app/api/dev-login: retired runtime route still exists");
}

const requireBuild = process.argv.includes("--require-build");
const buildDirectory = join(projectRoot, ".next");
const buildId = join(buildDirectory, "BUILD_ID");
if (requireBuild && !existsSync(buildId)) {
  findings.push(".next: build output is required but missing");
}
if (existsSync(buildId)) {
  const buildArtifacts = [
    ...filesBelow(join(buildDirectory, "server")),
    ...filesBelow(join(buildDirectory, "static")),
    ...[
      "app-path-routes-manifest.json",
      "build-manifest.json",
      "prerender-manifest.json",
      "required-server-files.json",
      "routes-manifest.json",
    ]
      .map((file) => join(buildDirectory, file))
      .filter(existsSync),
  ];
  findings.push(
    ...buildArtifacts.flatMap((path) =>
      scanFile(path, relative(projectRoot, path)),
    ),
  );
}

if (findings.length > 0) {
  console.error("Authentication removal verification failed:");
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exitCode = 1;
} else {
  console.log(
    `Authentication removal verified across ${trackedFiles().length} tracked files${
      existsSync(buildId) ? " and production build output" : ""
    }.`,
  );
}
