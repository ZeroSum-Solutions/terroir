#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ALLOWED_STATUSES = [
  "active",
  "amended",
  "duplicate",
  "retired",
];

const SCHEMA_VERSION = 1;
const SOURCE_FILE = "app_spec.txt";
const REQUIRED_FIELDS = [
  "id",
  "domain",
  "sourceText",
  "status",
  "evidenceOwner",
  "sourceOrder",
];

/**
 * Extract the one-feature-per-bullet assertions from app_spec.txt.
 *
 * @param {string} source
 */
export function parseCoreFeatures(source) {
  const coreMatch = source.match(/<core_features>([\s\S]*?)<\/core_features>/);
  if (!coreMatch) {
    throw new Error("app_spec.txt is missing <core_features>");
  }

  const features = [];
  const domainPattern = /<([a-z][a-z0-9_]*)>([\s\S]*?)<\/\1>/g;

  for (const domainMatch of coreMatch[1].matchAll(domainPattern)) {
    const [, domain, body] = domainMatch;
    const bullets = body.matchAll(/^\s*-\s+(.+?)\s*$/gm);

    for (const bullet of bullets) {
      features.push({
        domain,
        sourceOrder: features.length + 1,
        sourceText: bullet[1],
      });
    }
  }

  if (features.length === 0) {
    throw new Error("<core_features> does not contain any feature bullets");
  }

  return features;
}

/**
 * Build the initial ledger. IDs remain permanent after this initial extraction.
 *
 * @param {string} source
 */
export function createInitialLedger(source) {
  const features = parseCoreFeatures(source);

  return {
    schemaVersion: SCHEMA_VERSION,
    sourceFile: SOURCE_FILE,
    featureCount: features.length,
    items: features.map((feature) => ({
      id: `TER-CF-${String(feature.sourceOrder).padStart(3, "0")}`,
      ...feature,
      status: "active",
      evidenceOwner: "unassigned",
    })),
  };
}

/**
 * Return every ledger violation so one run can repair the complete file.
 *
 * @param {string} source
 * @param {unknown} ledger
 */
export function verifyFeatureLedger(source, ledger) {
  const errors = [];
  const expected = parseCoreFeatures(source);

  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    return ["ledger must be a JSON object"];
  }

  const candidate = /** @type {Record<string, unknown>} */ (ledger);
  const items = Array.isArray(candidate.items) ? candidate.items : [];

  if (candidate.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (candidate.sourceFile !== SOURCE_FILE) {
    errors.push(`sourceFile must be ${SOURCE_FILE}`);
  }
  if (!Array.isArray(candidate.items)) {
    errors.push("ledger items must be an array");
  }
  if (candidate.featureCount !== expected.length) {
    errors.push(
      `featureCount must be ${expected.length}; received ${String(candidate.featureCount)}`,
    );
  }
  if (candidate.featureCount !== items.length) {
    errors.push(
      `featureCount ${String(candidate.featureCount)} does not match items length ${items.length}`,
    );
  }

  const seenIds = new Set();

  items.forEach((rawItem, index) => {
    const label = `items[${index}]`;
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      errors.push(`${label} must be an object`);
      return;
    }

    const item = /** @type {Record<string, unknown>} */ (rawItem);
    for (const field of REQUIRED_FIELDS) {
      if (
        item[field] === undefined ||
        item[field] === null ||
        (typeof item[field] === "string" && item[field].length === 0)
      ) {
        errors.push(`${label}.${field} is required`);
      }
    }

    if (typeof item.id === "string") {
      if (!/^TER-CF-\d{3,}$/.test(item.id)) {
        errors.push(`${label}.id must match TER-CF-NNN`);
      }
      const expectedId = `TER-CF-${String(index + 1).padStart(3, "0")}`;
      if (item.id !== expectedId) {
        errors.push(`${label}.id must remain ${expectedId}`);
      }
      if (seenIds.has(item.id)) {
        errors.push(`duplicate ID ${item.id}`);
      }
      seenIds.add(item.id);
    }

    if (
      typeof item.status === "string" &&
      !ALLOWED_STATUSES.includes(item.status)
    ) {
      errors.push(
        `${label}.status must be one of ${ALLOWED_STATUSES.join(", ")}`,
      );
    }

    const sourceFeature = expected[index];
    if (!sourceFeature) {
      errors.push(`${label} has no matching source feature`);
      return;
    }

    for (const field of ["domain", "sourceOrder", "sourceText"]) {
      if (item[field] !== sourceFeature[field]) {
        errors.push(
          `${label}.${field} does not match source order ${sourceFeature.sourceOrder}`,
        );
      }
    }
  });

  if (items.length < expected.length) {
    errors.push(
      `ledger is missing ${expected.length - items.length} source feature(s)`,
    );
  }

  return errors;
}

function runCli() {
  const specPath = path.resolve(process.argv[2] ?? "app_spec.txt");
  const ledgerPath = path.resolve(
    process.argv[3] ?? "docs/feature-ledger.json",
  );

  try {
    const source = fs.readFileSync(specPath, "utf8");
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    const errors = verifyFeatureLedger(source, ledger);

    if (errors.length > 0) {
      console.error(`Feature ledger verification failed (${errors.length}):`);
      errors.forEach((error) => console.error(`- ${error}`));
      process.exitCode = 1;
      return;
    }

    console.log(
      `Feature ledger verified: ${ledger.featureCount} features match ${path.basename(specPath)}.`,
    );
  } catch (error) {
    console.error(
      `Feature ledger verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  runCli();
}
