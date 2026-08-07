#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTROL_TAGS = new Set(["Link", "a", "button", "form", "input", "select", "textarea"]);

function maskComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/^[\t ]*\/\/.*$/gm, (comment) => comment.replace(/[^\n]/g, " "));
}

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function attributeValue(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attributes.match(
    new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*("[^"]*"|'[^']*'|\\{[^}]*\\})`),
  );
  return match?.[1] ?? null;
}

function hasAttribute(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s*=|\\s|$)`).test(attributes);
}

function cleanValue(value) {
  if (!value) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim() || null;
  }
  return value.replace(/^\{\s*|\s*\}$/g, "").trim() || null;
}

function visibleText(source, openingEnd, tag) {
  if (!['Link', 'a', 'button'].includes(tag)) return null;
  const close = source.indexOf(`</${tag}>`, openingEnd);
  if (close === -1) return null;
  return source
    .slice(openingEnd, close)
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[^}]*\}/g, "{dynamic}")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || null;
}

function isPermanentDisabled(attributes) {
  if (!hasAttribute(attributes, "disabled") && !hasAttribute(attributes, "aria-disabled")) return false;
  const disabled = attributeValue(attributes, "disabled") ?? attributeValue(attributes, "aria-disabled");
  return disabled === null || /^(?:"true"|'true'|\{\s*true\s*\})$/.test(disabled);
}

function actorsForFile(file) {
  if (file.includes("src/app/(app)/")) return ["owner", "manager", "staff"];
  if (file.includes("src/app/list/") || file.includes("src/app/login/") || file.includes("src/app/auth/")) return ["guest"];
  if (file.includes("src/app/invite/")) return ["owner", "manager", "staff", "guest"];
  return ["owner", "manager", "staff", "guest"];
}

function sourceMapping(file, policy) {
  return policy.sourceMappings.find((mapping) => new RegExp(mapping.pattern).test(file));
}

function openingTags(source) {
  const tags = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "<" || source[start + 1] === "/" || source[start + 1] === "!") continue;
    const name = source.slice(start + 1).match(/^([A-Za-z][\w.]*)/)?.[1];
    if (!name) continue;
    let quote = null;
    let braceDepth = 0;
    let end = start + name.length + 1;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (quote) {
        if (character === quote && source[end - 1] !== "\\") quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "{") braceDepth += 1;
      else if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (character === ">" && braceDepth === 0) break;
    }
    if (end >= source.length) continue;
    tags.push({
      tag: name,
      attributes: source.slice(start + name.length + 1, end),
      start,
      end: end + 1,
    });
    start = end;
  }
  return tags;
}

export function scanSourceFile(file, source, policy) {
  const masked = maskComments(source);
  const controls = [];
  const violations = [];
  const occurrence = new Map();
  for (const match of openingTags(masked)) {
    const { tag, attributes } = match;
    if (!CONTROL_TAGS.has(tag)) continue;
    if (tag === "input" && cleanValue(attributeValue(attributes, "type")) === "hidden") continue;

    const index = (occurrence.get(tag) ?? 0) + 1;
    occurrence.set(tag, index);
    const line = lineAt(masked, match.start);
    const href = cleanValue(attributeValue(attributes, "href"));
    const permanentDisabled = isPermanentDisabled(attributes);
    const unavailableReason = cleanValue(attributeValue(attributes, "data-ui-unavailable-reason"));
    const recoveryAction = cleanValue(attributeValue(attributes, "data-ui-recovery-action"));
    const mapping = sourceMapping(file, policy);
    const label = cleanValue(attributeValue(attributes, "aria-label"))
      ?? cleanValue(attributeValue(attributes, "title"))
      ?? cleanValue(attributeValue(attributes, "placeholder"))
      ?? visibleText(masked, match.end, tag)
      ?? `${tag} at ${file}:${line}`;

    if (!mapping) violations.push(`${file}:${line} has no active requirement mapping`);
    if (permanentDisabled && (!unavailableReason || !recoveryAction)) {
      violations.push(`${file}:${line} permanently disables ${tag} without an approved reason and recovery action`);
    }
    if ((tag === "Link" || tag === "a") && (!href || href === "#" || href === "javascript:void(0)")) {
      violations.push(`${file}:${line} has a dead ${tag} href`);
    }
    if (tag === "form" && !hasAttribute(attributes, "action") && !hasAttribute(attributes, "onSubmit")) {
      violations.push(`${file}:${line} form has no action or onSubmit handler`);
    }
    if (
      tag === "button"
      && cleanValue(attributeValue(attributes, "type")) === "button"
      && !hasAttribute(attributes, "onClick")
      && !/\.\.\.[\w.]*listeners\b/.test(attributes)
      && !permanentDisabled
    ) {
      violations.push(`${file}:${line} type=button has no click handler`);
    }

    controls.push({
      id: `${file}#${tag.toLowerCase()}-${String(index).padStart(3, "0")}`,
      source: file,
      line,
      kind: tag === "Link" || tag === "a" ? "link" : tag,
      label,
      href,
      actors: actorsForFile(file),
      requirementId: mapping?.requirementId ?? null,
      interactionTest: policy.interactionTest,
      transientDisabled: (hasAttribute(attributes, "disabled") || hasAttribute(attributes, "aria-disabled")) && !permanentDisabled,
      unavailableState: permanentDisabled
        ? { reason: unavailableReason, recoveryAction }
        : null,
    });
  }

  const withoutInputPlaceholders = masked
    .replace(/\bplaceholder\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\})/g, "")
    .replace(/placeholder:[\w\-\/[\].]+/g, "");
  for (const phrase of policy.placeholderPhrases) {
    const offset = withoutInputPlaceholders.toLowerCase().indexOf(phrase.toLowerCase());
    if (offset !== -1) {
      violations.push(`${file}:${lineAt(withoutInputPlaceholders, offset)} contains prohibited placeholder copy ${JSON.stringify(phrase)}`);
    }
  }

  return { controls, violations };
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return [absolute];
  });
}

function routeFromEntry(file) {
  const relative = file
    .replace(/^src\/app\//, "")
    .replace(/(?:^|\/)(?:page\.tsx|route\.ts)$/, "")
    .split("/")
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .map((segment) => segment.replace(/^\[(.+)\]$/, ":$1"))
    .join("/");
  return `/${relative}`.replace(/\/$/, "") || "/";
}

function routeMatches(candidate, route) {
  const candidateParts = candidate.split("/").filter(Boolean);
  const routeParts = route.split("/").filter(Boolean);
  return candidateParts.length === routeParts.length
    && routeParts.every((part, index) => part.startsWith(":") || part === candidateParts[index]);
}

export function findDeadInternalHrefs(controls, routes) {
  return controls.flatMap((control) => {
    if (!control.href || !control.href.startsWith("/")) return [];
    const candidate = control.href.split(/[?#]/, 1)[0] || "/";
    if (routes.some((route) => routeMatches(candidate, route))) return [];
    return [`${control.id} points to missing internal route ${candidate}`];
  });
}

export function buildAudit(root, policy, ledger) {
  const sourceRoot = path.join(root, "src/app");
  const sourceFiles = walk(sourceRoot)
    .filter((file) => file.endsWith(".tsx") && !/\.(?:test|spec)\.tsx$/.test(file))
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
  const controls = [];
  const violations = [];

  for (const file of sourceFiles) {
    const result = scanSourceFile(file, fs.readFileSync(path.join(root, file), "utf8"), policy);
    controls.push(...result.controls);
    violations.push(...result.violations);
  }

  const activeRequirementIds = new Set(
    ledger.items.filter((item) => item.status === "active" || item.status === "amended").map((item) => item.id),
  );
  for (const control of controls) {
    if (!activeRequirementIds.has(control.requirementId)) {
      violations.push(`${control.id} maps to inactive or unknown requirement ${String(control.requirementId)}`);
    }
    if (!fs.existsSync(path.join(root, control.interactionTest))) {
      violations.push(`${control.id} interaction test does not exist: ${control.interactionTest}`);
    }
  }

  const discoveredRoutes = walk(sourceRoot)
    .filter((file) => file.endsWith("/page.tsx"))
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .map((source) => ({ source, path: routeFromEntry(source) }))
    .sort((a, b) => a.source.localeCompare(b.source));
  const applicationRoutes = walk(sourceRoot)
    .filter((file) => file.endsWith("/page.tsx") || file.endsWith("/route.ts"))
    .map((file) => routeFromEntry(path.relative(root, file).split(path.sep).join("/")));
  violations.push(...findDeadInternalHrefs(controls, applicationRoutes));
  const policyBySource = new Map(policy.routes.map((route) => [route.source, route]));
  for (const route of discoveredRoutes) {
    const configured = policyBySource.get(route.source);
    if (!configured) violations.push(`${route.source} route ${route.path} is absent from UI route coverage`);
    else if (configured.path !== route.path) violations.push(`${route.source} route policy says ${configured.path}; discovered ${route.path}`);
  }
  for (const route of policy.routes) {
    if (!discoveredRoutes.some((candidate) => candidate.source === route.source)) {
      violations.push(`UI route coverage references missing page ${route.source}`);
    }
    if (route.roles.length === 0 || route.roles.some((role) => !policy.roles.includes(role))) {
      violations.push(`${route.source} has invalid or empty role coverage`);
    }
  }

  const inventory = {
    schemaVersion: 1,
    generatedFrom: {
      policy: "docs/ui-control-policy.json",
      featureLedger: "docs/feature-ledger.json",
      sourceRoot: "src/app",
    },
    routeCount: policy.routes.length,
    controlCount: controls.length,
    routes: policy.routes,
    controls,
  };
  return { inventory, violations };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function verifyUiControls(root, { write = false } = {}) {
  const policy = JSON.parse(fs.readFileSync(path.join(root, "docs/ui-control-policy.json"), "utf8"));
  const ledger = JSON.parse(fs.readFileSync(path.join(root, "docs/feature-ledger.json"), "utf8"));
  const { inventory, violations } = buildAudit(root, policy, ledger);
  const outputPath = path.join(root, "docs/ui-control-inventory.json");
  const output = stableJson(inventory);
  if (write) fs.writeFileSync(outputPath, output);
  else if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== output) {
    violations.push("docs/ui-control-inventory.json is stale; run pnpm run ui-controls:generate");
  }
  return {
    status: violations.length === 0 ? "ok" : "error",
    inventorySha256: crypto.createHash("sha256").update(output).digest("hex"),
    routeCount: inventory.routeCount,
    controlCount: inventory.controlCount,
    violations,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.cwd();
  const result = verifyUiControls(root, { write: process.argv.includes("--write") });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "ok") process.exitCode = 1;
}
