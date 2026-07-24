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

const SCHEMA_VERSION = 2;
const SOURCE_FILE = "app_spec.txt";
const BUDGET_DECISION = {
  previousMaximum: 200,
  decision: "all_enumerated_features_active",
  approvedBy: "product_owner",
  approvedOn: "2026-07-23",
};
const REQUIRED_FIELDS = [
  "id",
  "domain",
  "sourceText",
  "actor",
  "action",
  "observableOutcome",
  "negativeCase",
  "status",
  "completionSpec",
  "evidenceOwner",
  "sourceOrder",
];
const COMPLETION_RULES = [
  [1, 13, "TER-010", "identity"],
  [14, 15, "TER-013", "restaurant-admin"],
  [16, 19, "TER-015", "team-invitations"],
  [20, 21, "TER-043", "team-lifecycle"],
  [22, 23, "TER-015", "team-invitations"],
  [24, 26, "TER-014", "authorization"],
  [27, 27, "TER-012", "tenant-access"],
  [28, 28, "TER-015", "team-invitations"],
  [29, 29, "TER-014", "authorization"],
  [30, 56, "TER-040", "invoice-scanning"],
  [57, 63, "TER-028", "bottle-scanning"],
  [64, 90, "TER-025", "inventory"],
  [91, 101, "TER-026", "wine-intelligence"],
  [102, 128, "TER-042", "wine-lists"],
  [129, 129, "TER-034", "public-menu"],
  [130, 137, "TER-042", "wine-lists"],
  [138, 138, "TER-035", "public-reliability"],
  [139, 139, "TER-042", "wine-lists"],
  [140, 140, "TER-033", "public-menu"],
  [141, 164, "TER-041", "pour-reconciliation"],
  [165, 179, "TER-027", "insights-pricing"],
  [180, 180, "TER-023", "operations"],
  [181, 217, "TER-020", "api-platform"],
  [218, 223, "TER-044", "frontend-quality"],
  [224, 224, "TER-032", "interaction"],
  [225, 232, "TER-044", "frontend-quality"],
  [233, 233, "TER-035", "public-reliability"],
  [234, 234, "TER-044", "frontend-quality"],
  [235, 236, "TER-005", "release-engineering"],
  [237, 248, "TER-020", "data-platform"],
  [249, 254, "TER-023", "operations"],
  [255, 257, "TER-005", "release-engineering"],
  [258, 261, "TER-005", "quality-engineering"],
  [262, 262, "TER-040", "invoice-scanning"],
  [263, 263, "TER-041", "pour-reconciliation"],
  [264, 264, "TER-042", "wine-lists"],
  [265, 265, "TER-043", "team-lifecycle"],
  [266, 269, "TER-005", "quality-engineering"],
];
const ACTOR_PATTERNS = [
  /^(User|Owner|Manager|Staff|Guest|Invitee|System|API|UI|Claude|Sentry) (.+)$/,
  /^((?:GET|POST|PATCH|DELETE) \S+) (.+)$/,
  /^(All (?:write endpoints|endpoints|RLS policies)) (.+)$/,
  /^(Dev login route|Migrations|schema\.snapshot\.sql|set_updated_at trigger|handle_new_user trigger|find_or_create_wine and find_or_create_wines_batch|generate_slug|match_lwin and match_lwin_batch|lwin_search|cleanup_scan_idempotency|record_pour|reconcile_open_bottle and reconcile_open_bottles_batch|auto_eightysix_on_low_inventory|enrich_wines_batch|global-error\.tsx|Source maps|Railway deploy|pnpm build|pnpm start|Vitest|Playwright|ESLint 9 flat config|TypeScript strict mode|pnpm types:check|pnpm snapshot:check) (.+)$/,
];

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

export function deriveCriterion(sourceText) {
  const match = ACTOR_PATTERNS.map((pattern) => sourceText.match(pattern)).find(Boolean);
  if (!match) {
    throw new Error(
      `unsupported feature assertion grammar: ${JSON.stringify(sourceText)}`,
    );
  }

  return {
    actor: match[1],
    action: match[2],
    observableOutcome: sourceText,
    negativeCase: `Assertion is not observed: ${sourceText}`,
  };
}

export function metadataForRequirement(sourceOrder, rules = COMPLETION_RULES) {
  const rule = rules.find(
    ([start, end]) => sourceOrder >= start && sourceOrder <= end,
  );
  if (!rule) {
    throw new Error(`no completion metadata for source order ${sourceOrder}`);
  }

  return {
    completionSpec: rule[2],
    evidenceOwner: rule[3],
  };
}

export function validateCompletionRules(rules, approvedFeatureCount) {
  const coverage = Array(approvedFeatureCount).fill(0);
  const errors = [];

  for (const [start, end] of rules) {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start ||
      end > approvedFeatureCount
    ) {
      errors.push(`invalid completion-rule range ${start}-${end}`);
      continue;
    }
    for (let order = start; order <= end; order += 1) coverage[order - 1] += 1;
  }

  coverage.forEach((count, index) => {
    if (count === 0) errors.push(`completion-rule gap at source order ${index + 1}`);
    if (count > 1) errors.push(`completion-rule overlap at source order ${index + 1}`);
  });
  return errors;
}

export function createInitialLedger(source, approvedFeatureCount = 269) {
  const features = parseCoreFeatures(source);
  if (features.length !== approvedFeatureCount) {
    throw new Error(
      `source feature count must remain ${approvedFeatureCount}; received ${features.length}`,
    );
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    sourceFile: SOURCE_FILE,
    featureCount: features.length,
    budgetResolution: {
      ...BUDGET_DECISION,
      approvedActiveCount: approvedFeatureCount,
    },
    items: features.map((feature) => ({
      id: `TER-CF-${String(feature.sourceOrder).padStart(3, "0")}`,
      ...feature,
      ...deriveCriterion(feature.sourceText),
      status: "active",
      ...metadataForRequirement(feature.sourceOrder),
    })),
  };
}

export function verifyFeatureLedger(
  source,
  ledger,
  completionPlan = "",
  options = {},
) {
  const errors = [];
  const expected = parseCoreFeatures(source);
  const {
    approvedFeatureCount = 269,
    requireAllActive = true,
    completionRules = COMPLETION_RULES,
  } = options;

  if (expected.length !== approvedFeatureCount) {
    errors.push(
      `source feature count must remain ${approvedFeatureCount}; received ${expected.length}`,
    );
  }
  errors.push(
    ...validateCompletionRules(completionRules, approvedFeatureCount),
  );

  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    return ["ledger must be a JSON object"];
  }

  const candidate = /** @type {Record<string, unknown>} */ (ledger);
  const items = Array.isArray(candidate.items) ? candidate.items : [];
  const budget =
    candidate.budgetResolution &&
    typeof candidate.budgetResolution === "object" &&
    !Array.isArray(candidate.budgetResolution)
      ? /** @type {Record<string, unknown>} */ (candidate.budgetResolution)
      : {};
  const planSpecs = new Set(
    [...completionPlan.matchAll(/^### (TER-\d{3}):/gm)].map(
      (match) => match[1],
    ),
  );

  if (candidate.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (candidate.sourceFile !== SOURCE_FILE) {
    errors.push(`sourceFile must be ${SOURCE_FILE}`);
  }
  if (!Array.isArray(candidate.items)) {
    errors.push("ledger items must be an array");
  }
  for (const [field, value] of Object.entries(BUDGET_DECISION)) {
    if (budget[field] !== value) {
      errors.push(`budgetResolution.${field} must be ${String(value)}`);
    }
  }
  if (budget.approvedActiveCount !== approvedFeatureCount) {
    errors.push(
      `budgetResolution.approvedActiveCount must be ${approvedFeatureCount}`,
    );
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
    if (requireAllActive && item.status !== "active") {
      errors.push(`${label}.status must remain active under the approved resolution`);
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

    const criterion = deriveCriterion(sourceFeature.sourceText);
    for (const field of Object.keys(criterion)) {
      if (item[field] !== criterion[field]) {
        errors.push(`${label}.${field} does not match its source assertion`);
      }
    }

    const metadata = metadataForRequirement(
      sourceFeature.sourceOrder,
      completionRules,
    );
    for (const field of Object.keys(metadata)) {
      if (item[field] !== metadata[field]) {
        errors.push(`${label}.${field} does not match reviewed metadata`);
      }
    }
    if (
      typeof item.completionSpec === "string" &&
      !planSpecs.has(item.completionSpec)
    ) {
      errors.push(
        `${label}.completionSpec ${item.completionSpec} is absent from the completion plan`,
      );
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
  const planPath = path.resolve(
    process.argv[4] ?? "docs/plans/2026-07-20-terroir-completion-spec.md",
  );

  try {
    const source = fs.readFileSync(specPath, "utf8");
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    const completionPlan = fs.readFileSync(planPath, "utf8");
    const errors = verifyFeatureLedger(source, ledger, completionPlan);

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
