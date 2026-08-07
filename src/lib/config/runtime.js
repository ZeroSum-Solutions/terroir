const REQUIRED_CORE_VARIABLES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ACTIVE_RESTAURANT_COOKIE_SECRET",
];

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function configured(...values) {
  return values.every(present);
}

function missingNames(env, names) {
  return names.filter((name) => !present(env[name]));
}

/**
 * Classifies runtime dependencies without returning their values. This is safe
 * to use in health responses, logs, and deployment validation errors.
 */
export function inspectRuntimeConfiguration(env = process.env) {
  const missingCore = missingNames(env, REQUIRED_CORE_VARIABLES);
  if (present(env.NEXT_PUBLIC_SUPABASE_URL)) {
    try {
      new URL(env.NEXT_PUBLIC_SUPABASE_URL);
    } catch {
      missingCore.push("NEXT_PUBLIC_SUPABASE_URL (valid URL)");
    }
  }
  const cookieSecret = env.ACTIVE_RESTAURANT_COOKIE_SECRET?.trim() ?? "";
  if (present(env.ACTIVE_RESTAURANT_COOKIE_SECRET) && cookieSecret.length < 16) {
    missingCore.push("ACTIVE_RESTAURANT_COOKIE_SECRET (minimum 16 characters)");
  }

  const invoiceScanning = configured(
    env.ANTHROPIC_API_KEY,
    env.AZURE_DOC_INTELLIGENCE_ENDPOINT,
    env.AZURE_DOC_INTELLIGENCE_KEY,
  );
  const wineSearch = configured(env.WINE_SEARCHER_API_KEY);
  const sentry = configured(env.SENTRY_DSN, env.NEXT_PUBLIC_SENTRY_DSN);
  const temporaryAuthBypass = [
    "TEMP_AUTH_BYPASS_EMAIL",
    "TEMP_AUTH_BYPASS_TOKEN_SHA256",
    "TEMP_AUTH_BYPASS_EXPIRES_AT",
  ];
  const configuredBypass = temporaryAuthBypass.filter((name) => present(env[name]));

  return {
    core: missingCore.length === 0 ? "configured" : "missing",
    missingCore,
    integrations: {
      invoice_scanning: invoiceScanning ? "configured" : "degraded",
      wine_search: wineSearch ? "configured" : "degraded",
      sentry: sentry ? "configured" : "degraded",
      email: "not_configured",
      worker: "not_configured",
    },
    configurationErrors: configuredBypass.length > 0 && configuredBypass.length < temporaryAuthBypass.length
      ? ["TEMP_AUTH_BYPASS_* must be configured together or left unset"]
      : [],
  };
}

/** Throws a names-only error suitable for Railway's pre-traffic build gate. */
export function assertDeploymentConfiguration(env = process.env) {
  const config = inspectRuntimeConfiguration(env);
  const failures = [...config.missingCore, ...config.configurationErrors];
  if (failures.length > 0) {
    throw new Error(`Invalid deployment configuration: ${failures.join(", ")}`);
  }
  return config;
}
