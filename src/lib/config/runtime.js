import { z } from "zod";

const CORE_VARIABLES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ACTIVE_RESTAURANT_COOKIE_SECRET",
  "NEXT_PUBLIC_APP_URL",
];

/** App-owned variables that must stay documented in `.env.example`. */
export const RUNTIME_VARIABLES = Object.freeze([
  ...CORE_VARIABLES,
  "ANTHROPIC_API_KEY",
  "AZURE_DOC_INTELLIGENCE_ENDPOINT",
  "AZURE_DOC_INTELLIGENCE_KEY",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ENVIRONMENT",
  "NEXT_PUBLIC_SENTRY_ENVIRONMENT",
  "SENTRY_TRACES_SAMPLE",
  "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE",
  "PRICE_VARIANCE_HIGHLIGHT_THRESHOLD",
  "WINE_SEARCHER_API_KEY",
  "OBSERVABILITY_DRILL_ENABLED",
  "OBSERVABILITY_DRILL_TOKEN_SHA256",
]);

const emptyToUndefined = (value) =>
  typeof value === "string" && value.trim().length === 0 ? undefined : value;
const optionalText = z.preprocess(
  emptyToUndefined,
  z.string().trim().min(1).optional(),
);
const optionalUrl = z.preprocess(
  emptyToUndefined,
  z.string().trim().url().optional(),
);
const optionalRate = z.preprocess(
  (value) => {
    const normalized = emptyToUndefined(value);
    return normalized === undefined ? undefined : Number(normalized);
  },
  z.number().finite().min(0).max(1).optional(),
);
const optionalSha256 = z.preprocess(
  emptyToUndefined,
  z.string().trim().regex(/^[a-f0-9]{64}$/i).optional(),
);

/**
 * Single schema for deployment validation and safe health classification.
 * It parses names and shapes only; callers never serialize parsed values.
 */
export const runtimeEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().trim().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().trim().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1),
  ACTIVE_RESTAURANT_COOKIE_SECRET: z.string().trim().min(16),
  NEXT_PUBLIC_APP_URL: z.string().trim().url(),
  ANTHROPIC_API_KEY: optionalText,
  AZURE_DOC_INTELLIGENCE_ENDPOINT: optionalUrl,
  AZURE_DOC_INTELLIGENCE_KEY: optionalText,
  SENTRY_DSN: optionalUrl,
  NEXT_PUBLIC_SENTRY_DSN: optionalUrl,
  SENTRY_AUTH_TOKEN: optionalText,
  SENTRY_ENVIRONMENT: optionalText,
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: optionalText,
  SENTRY_TRACES_SAMPLE: optionalRate,
  NEXT_PUBLIC_SENTRY_TRACES_SAMPLE: optionalRate,
  PRICE_VARIANCE_HIGHLIGHT_THRESHOLD: optionalRate,
  WINE_SEARCHER_API_KEY: optionalText,
  OBSERVABILITY_DRILL_ENABLED: z.preprocess(
    emptyToUndefined,
    z.literal("1").optional(),
  ),
  OBSERVABILITY_DRILL_TOKEN_SHA256: optionalSha256,
  RAILWAY_ENVIRONMENT_NAME: optionalText,
  RAILWAY_GIT_COMMIT_SHA: optionalText,
}).passthrough();

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function missingNames(env, names) {
  return names.filter((name) => !present(env[name]));
}

function invalidNames(result) {
  if (result.success) return new Set();
  return new Set(
    result.error.issues
      .map((issue) => issue.path[0])
      .filter((name) => typeof name === "string"),
  );
}

function integrationState(env, invalid, names) {
  return names.every((name) => present(env[name]) && !invalid.has(name))
    ? "configured"
    : "degraded";
}

/**
 * Classifies runtime dependencies without returning their values. This is safe
 * to use in health responses, logs, and deployment validation errors.
 */
export function inspectRuntimeConfiguration(env = process.env) {
  const result = runtimeEnvironmentSchema.safeParse(env);
  const invalid = invalidNames(result);
  const missingCore = CORE_VARIABLES.flatMap((name) => {
    if (!present(env[name])) return [name];
    return invalid.has(name) ? [`${name} (invalid)`] : [];
  });

  if (
    env.NODE_ENV === "production" &&
    present(env.NEXT_PUBLIC_APP_URL) &&
    !env.NEXT_PUBLIC_APP_URL.trim().startsWith("https://")
  ) {
    missingCore.push("NEXT_PUBLIC_APP_URL (HTTPS required in production)");
  }

  const configurationErrors = [...invalid]
    .filter((name) => !CORE_VARIABLES.includes(name))
    .map((name) => `${name} (invalid)`);

  const invoiceVariables = [
    "ANTHROPIC_API_KEY",
    "AZURE_DOC_INTELLIGENCE_ENDPOINT",
    "AZURE_DOC_INTELLIGENCE_KEY",
  ];
  const sentryVariables = ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"];

  return {
    core: missingCore.length === 0 ? "configured" : "missing",
    missingCore: [...new Set(missingCore)],
    integrations: {
      invoice_scanning: integrationState(env, invalid, invoiceVariables),
      wine_search: integrationState(env, invalid, ["WINE_SEARCHER_API_KEY"]),
      sentry: integrationState(env, invalid, sentryVariables),
      email: "not_configured",
      worker: "not_configured",
    },
    missingIntegrations: {
      invoice_scanning: missingNames(env, invoiceVariables),
      wine_search: missingNames(env, ["WINE_SEARCHER_API_KEY"]),
      sentry: missingNames(env, sentryVariables),
    },
    configurationErrors: [...new Set(configurationErrors)],
  };
}

/** Throws a names-only error suitable for deployment and process-start gates. */
export function assertDeploymentConfiguration(env = process.env) {
  const config = inspectRuntimeConfiguration(env);
  const failures = [...config.missingCore, ...config.configurationErrors];
  if (failures.length > 0) {
    throw new Error(`Invalid deployment configuration: ${failures.join(", ")}`);
  }
  return config;
}
