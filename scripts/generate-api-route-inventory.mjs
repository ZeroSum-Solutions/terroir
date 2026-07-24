#!/usr/bin/env node

import * as fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const METHOD_SET = new Set(METHODS);
const METHOD_ORDER = new Map(
  ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map((m, i) => [m, i]),
);
const EXPORT_KINDS = new Set(["function-declaration", "variable-declaration", "named-export", "named-reexport"]);
const KEYS = {
  root: ["schemaVersion", "generatorVersion", "sourceRoot", "routeFileCount",
    "discoveredOperationCount", "discoveredOperations", "plannedOperations"],
  discovered: ["operationId", "method", "path", "source"],
  source: ["file", "exportKind", "localName", "moduleSpecifier"],
  planned: ["operationId", "method", "path", "sourceRequirementIds"],
};
export class ApiInventoryDiagnostic extends Error {
  constructor(code, message, file = null) {
    super(file ? `${file}: ${message}` : message);
    this.name = "ApiInventoryDiagnostic";
    this.code = code;
    this.file = file;
  }
}
function fail(code, message, file) {
  throw new ApiInventoryDiagnostic(code, message, file);
}
function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function operationIdFor(method, routePath) {
  if (!METHOD_SET.has(method)) throw new TypeError(`Unsupported method: ${method}`);
  const identityPath = routePath
    .split("/")
    .map((segment) => {
      if (/^\[\[\.\.\.[A-Za-z_$][\w$]*\]\]$/.test(segment)) return "{optional-catchall}";
      if (/^\[\.\.\.[A-Za-z_$][\w$]*\]$/.test(segment)) return "{catchall}";
      if (/^\[[A-Za-z_$][\w$]*\]$/.test(segment)) return "{param}";
      return segment.replaceAll("{", "%7B").replaceAll("}", "%7D");
    })
    .join("/");
  return `api:${method}:${identityPath}`;
}
export function routePathFromFile(filePath, sourceRoot = "src/app/api") {
  const file = filePath.replaceAll("\\", "/");
  const root = sourceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!file.startsWith(`${root}/`) || !file.endsWith("/route.ts"))
    fail("APIINV001", "Expected route.ts beneath the API source root.", file);
  const directory = file.slice(root.length + 1, -"/route.ts".length);
  const routeSegments = [];
  for (const segment of directory ? directory.split("/") : []) {
    const invalid =
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith("_") ||
      segment.startsWith("@") ||
      /^\(\.{1,3}\)/.test(segment);
    if (invalid) fail("APIINV001", `Unsupported segment "${segment}".`, file);
    if (/^\([^/()]+\)$/.test(segment)) continue;
    const dynamic =
      /^\[[A-Za-z_$][\w$]*\]$/.test(segment) ||
      /^\[\.\.\.[A-Za-z_$][\w$]*\]$/.test(segment) ||
      /^\[\[\.\.\.[A-Za-z_$][\w$]*\]\]$/.test(segment);
    if (
      /[()]/.test(segment) ||
      ((segment.includes("[") || segment.includes("]")) && !dynamic)
    )
      fail("APIINV001", `Unsupported segment "${segment}".`, file);
    routeSegments.push(segment);
  }
  return `/${["api", ...routeSegments].join("/")}`;
}
const hasModifier = (node, kind) =>
  node.modifiers?.some((modifier) => modifier.kind === kind);
function bindingHasMethod(name) {
  if (ts.isIdentifier(name)) return METHOD_SET.has(name.text);
  return name.elements.some(
    (item) => !ts.isOmittedExpression(item) && bindingHasMethod(item.name),
  );
}
export function extractHttpExports(sourceText, file) {
  const ast = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (ast.parseDiagnostics?.length)
    fail(
      "APIINV005",
      ts.flattenDiagnosticMessageText(ast.parseDiagnostics[0].messageText, "\n"),
      file,
    );
  const operations = [];
  const seen = new Set();
  const add = (method, exportKind, localName, moduleSpecifier = null) => {
    if (seen.has(method))
      fail("APIINV003", `${method} is exported more than once.`, file);
    seen.add(method);
    operations.push({
      method,
      source: { exportKind, localName, moduleSpecifier },
    });
  };
  for (const statement of ast.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (
      ts.isExportAssignment(statement) ||
      (exported && hasModifier(statement, ts.SyntaxKind.DefaultKeyword))
    )
      fail("APIINV002", "Default exports are unsupported.", file);

    if (
      exported &&
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      METHOD_SET.has(statement.name.text)
    ) {
      add(statement.name.text, "function-declaration", statement.name.text);
    } else if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          if (bindingHasMethod(declaration.name))
            fail("APIINV002", "Destructured method export.", file);
        } else if (METHOD_SET.has(declaration.name.text)) {
          add(declaration.name.text, "variable-declaration", declaration.name.text);
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause)
        fail("APIINV002", "Wildcard re-exports are unsupported.", file);
      if (statement.isTypeOnly || !ts.isNamedExports(statement.exportClause))
        continue;
      const moduleSpecifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
      for (const specifier of statement.exportClause.elements) {
        if (specifier.isTypeOnly || !METHOD_SET.has(specifier.name.text)) continue;
        add(
          specifier.name.text,
          moduleSpecifier ? "named-reexport" : "named-export",
          specifier.propertyName?.text ?? specifier.name.text,
          moduleSpecifier,
        );
      }
    }
  }
  if (!operations.length)
    fail("APIINV006", "No supported HTTP method export.", file);
  return operations;
}
function listRouteFiles(projectRoot, sourceRoot) {
  const source = path.join(projectRoot, sourceRoot);
  if (fs.lstatSync(source).isSymbolicLink())
    fail("APIINV007", "API source root cannot be a symlink.", sourceRoot);
  const files = [];
  const visit = (directory) => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => compare(a.name, b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(projectRoot, absolute).replaceAll("\\", "/");
      if (entry.isSymbolicLink())
        fail("APIINV007", "Symlinks are unsupported.", relative);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name === "route.ts") files.push(relative);
    }
  };
  visit(source);
  return files;
}
export function discoverRouteOperations({
  projectRoot,
  sourceRoot = "src/app/api",
}) {
  const files = listRouteFiles(projectRoot, sourceRoot);
  const operations = [];
  const identities = new Map();
  for (const file of files) {
    const routePath = routePathFromFile(file, sourceRoot);
    const exports = extractHttpExports(
      fs.readFileSync(path.join(projectRoot, file), "utf8"),
      file,
    );
    for (const item of exports) {
      const operationId = operationIdFor(item.method, routePath);
      if (identities.has(operationId))
        fail(
          "APIINV004",
          `${operationId} collides with ${identities.get(operationId)}.`,
          file,
        );
      identities.set(operationId, file);
      operations.push({
        operationId,
        method: item.method,
        path: routePath,
        source: { file, ...item.source },
      });
    }
  }
  operations.sort(
    (a, b) =>
      compare(a.path, b.path) ||
      METHOD_ORDER.get(a.method) - METHOD_ORDER.get(b.method),
  );
  return { routeFileCount: files.length, operations };
}
const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function checkKeys(value, allowed, location, errors) {
  if (!isObject(value)) {
    errors.push(`${location}: expected object`);
    return false;
  }
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) errors.push(`${location}: unexpected property ${key}`);
  for (const key of allowed)
    if (!(key in value)) errors.push(`${location}: missing property ${key}`);
  return true;
}
function checkIdentity(operation, location, errors) {
  if (!METHOD_SET.has(operation.method))
    errors.push(`${location}.method: unsupported HTTP method`);
  const validPath =
    typeof operation.path === "string" &&
    /^\/api(?:\/[^/]+)*$/.test(operation.path) &&
    !operation.path.endsWith("/") &&
    !operation.path.split("/").some((segment) => segment === "." || segment === "..");
  if (!validPath) errors.push(`${location}.path: invalid API route path`);
  if (typeof operation.operationId !== "string")
    errors.push(`${location}.operationId: expected string`);
  else if (
    METHOD_SET.has(operation.method) &&
    validPath &&
    operation.operationId !== operationIdFor(operation.method, operation.path)
  )
    errors.push(`${location}.operationId: does not match method and path`);
}
function checkDiscovered(operation, index, errors) {
  const location = `$.discoveredOperations[${index}]`;
  if (!checkKeys(operation, KEYS.discovered, location, errors)) return;
  checkIdentity(operation, location, errors);
  if (!checkKeys(operation.source, KEYS.source, `${location}.source`, errors))
    return;
  const source = operation.source;
  if (
    typeof source.file !== "string" ||
    !/^src\/app\/api(?:\/[^/]+)*\/route\.ts$/.test(source.file)
  )
    errors.push(`${location}.source.file: invalid route source path`);
  if (!EXPORT_KINDS.has(source.exportKind))
    errors.push(`${location}.source.exportKind: unsupported export kind`);
  if (typeof source.localName !== "string" || !/^[A-Za-z_$][\w$]*$/.test(source.localName))
    errors.push(`${location}.source.localName: expected identifier`);
  if (
    ["function-declaration", "variable-declaration"].includes(source.exportKind) &&
    source.localName !== operation.method
  )
    errors.push(`${location}.source.localName: direct export must match method`);
  const relativeModule = typeof source.moduleSpecifier === "string" && /^\.\.?\//.test(source.moduleSpecifier);
  if (source.moduleSpecifier !== null && !relativeModule)
    errors.push(`${location}.source.moduleSpecifier: expected relative module`);
  if ((source.exportKind === "named-reexport") !== relativeModule)
    errors.push(`${location}.source.moduleSpecifier: inconsistent export kind`);
}
function checkPlanned(operation, index, errors) {
  const location = `$.plannedOperations[${index}]`;
  if (!checkKeys(operation, KEYS.planned, location, errors)) return;
  checkIdentity(operation, location, errors);
  const ids = operation.sourceRequirementIds;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.some((id) => typeof id !== "string" || !/^TER-CF-\d{3}$/.test(id)) ||
    new Set(ids).size !== ids.length
  )
    errors.push(`${location}.sourceRequirementIds: invalid requirement IDs`);
}
export function validateInventoryShape(value) {
  const errors = [];
  if (!checkKeys(value, KEYS.root, "$", errors))
    return { valid: false, errors };
  if (value.schemaVersion !== 1) errors.push("$.schemaVersion: expected 1");
  if (value.generatorVersion !== 1) errors.push("$.generatorVersion: expected 1");
  if (value.sourceRoot !== "src/app/api")
    errors.push("$.sourceRoot: expected src/app/api");
  if (!Number.isInteger(value.routeFileCount) || value.routeFileCount < 0)
    errors.push("$.routeFileCount: expected non-negative integer");
  if (!Number.isInteger(value.discoveredOperationCount) || value.discoveredOperationCount < 0)
    errors.push("$.discoveredOperationCount: expected non-negative integer");
  if (!Array.isArray(value.discoveredOperations))
    errors.push("$.discoveredOperations: expected array");
  else {
    value.discoveredOperations.forEach((item, i) =>
      checkDiscovered(item, i, errors),
    );
    if (value.discoveredOperationCount !== value.discoveredOperations.length)
      errors.push("$.discoveredOperationCount: length mismatch");
  }
  if (!Array.isArray(value.plannedOperations))
    errors.push("$.plannedOperations: expected array");
  else
    value.plannedOperations.forEach((item, i) => checkPlanned(item, i, errors));
  return { valid: !errors.length, errors };
}
export function createInventory({
  routeFileCount,
  operations,
  plannedOperations,
}) {
  return {
    schemaVersion: 1,
    generatorVersion: 1,
    sourceRoot: "src/app/api",
    routeFileCount,
    discoveredOperationCount: operations.length,
    discoveredOperations: operations,
    plannedOperations,
  };
}
export const renderInventory = (inventory) =>
  `${JSON.stringify(inventory, null, 2)}\n`;
export function writeInventory({
  projectRoot,
  sourceRoot = "src/app/api",
  outputPath = "docs/api-route-inventory.json",
}) {
  const output = path.isAbsolute(outputPath)
    ? outputPath
    : path.join(projectRoot, outputPath);
  let plannedOperations = [];
  if (fs.existsSync(output)) {
    const previous = JSON.parse(fs.readFileSync(output, "utf8"));
    if (!Array.isArray(previous.plannedOperations))
      throw new TypeError(`${outputPath}: plannedOperations must be an array`);
    plannedOperations = structuredClone(previous.plannedOperations);
  }
  const discovered = discoverRouteOperations({ projectRoot, sourceRoot });
  const inventory = createInventory({
    routeFileCount: discovered.routeFileCount,
    operations: discovered.operations,
    plannedOperations,
  });
  const validation = validateInventoryShape(inventory);
  if (!validation.valid) throw new TypeError(validation.errors.join("\n"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, renderInventory(inventory), {
      encoding: "utf8",
      flag: "wx",
    });
    fs.renameSync(temporary, output);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  return inventory;
}
const main =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (main) {
  if (process.argv.length !== 3 || process.argv[2] !== "--write") {
    console.error("Usage: node scripts/generate-api-route-inventory.mjs --write");
    process.exitCode = 1;
  } else {
    try {
      const inventory = writeInventory({ projectRoot: process.cwd() });
      console.log(
        `Generated ${inventory.discoveredOperationCount} API operations from ${inventory.routeFileCount} route files.`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
