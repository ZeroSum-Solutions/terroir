import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STAGING_MIGRATION_CONFIRMATION,
  STAGING_PROJECT_REF,
  TARGET_VERSIONS,
  buildMutationSql,
  classifyState,
  loadManifestFiles,
  normalizeState,
  stateQuery,
} from "./staging-migration-plan.mjs";

export { STAGING_MIGRATION_CONFIRMATION, STAGING_PROJECT_REF };

const STAGING_SUPABASE_ORIGIN = `https://${STAGING_PROJECT_REF}.supabase.co`;
const STAGING_BRANCH_REF = "refs/heads/staging";
const MANAGEMENT_API =
  `https://api.supabase.com/v1/projects/${STAGING_PROJECT_REF}/database/query`;

function requireExactSha(value, name) {
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) {
    throw new Error(`${name} must be one exact lowercase 40-character commit SHA.`);
  }
  return value;
}

function requireExactStagingOrigin(value) {
  let url;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error("STAGING_SUPABASE_URL must be the exact isolated staging origin.");
  }
  if (url.href !== `${STAGING_SUPABASE_ORIGIN}/`) {
    throw new Error("STAGING_SUPABASE_URL must be the exact isolated staging origin.");
  }
}

async function requestJson(fetchImpl, token, url, body, purpose) {
  let response;
  try {
    response = await fetchImpl(url, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    if (purpose === "mutation") {
      throw new Error(
        "Supabase migration request failed before a confirmed response; mutation state is unknown. Reconcile before retrying.",
      );
    }
    throw new Error(`Supabase ${purpose} request failed without a response.`);
  }
  if (!response.ok) {
    if (purpose === "mutation" && response.status >= 500) {
      throw new Error(
        `Supabase mutation failed with HTTP ${response.status}; mutation state is unknown. Reconcile before retrying.`,
      );
    }
    throw new Error(`Supabase ${purpose} failed with HTTP ${response.status}.`);
  }
  if (purpose === "mutation") {
    return null;
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Supabase ${purpose} returned an invalid JSON response.`);
  }
}

async function readState(fetchImpl, token, purpose) {
  const payload = await requestJson(
    fetchImpl,
    token,
    `${MANAGEMENT_API}/read-only`,
    { query: stateQuery() },
    purpose,
  );
  return normalizeState(payload);
}

function validateRequestedEnvironment(env) {
  requireExactStagingOrigin(env.STAGING_SUPABASE_URL);
  if (env.GITHUB_REF !== STAGING_BRANCH_REF) {
    throw new Error("Staging migrations may run only from the staging branch ref.");
  }
  if (env.STAGING_MIGRATION_CONFIRMATION?.trim() !== STAGING_MIGRATION_CONFIRMATION) {
    throw new Error("STAGING_MIGRATION_CONFIRMATION does not match the isolated staging operation.");
  }
  if (env.RUN_WINE_ENRICHMENT_WORKER_PILOT === "true") {
    throw new Error(
      "The dependency-gated wine-enrichment worker pilot cannot run with staging migration apply.",
    );
  }
  const releaseOwner = env.STAGING_RELEASE_OWNER?.trim();
  const actor = env.GITHUB_ACTOR?.trim();
  if (!releaseOwner || !actor || actor !== releaseOwner) {
    throw new Error("Only the configured release owner may apply staging migrations.");
  }
  const expectedSha = requireExactSha(env.STAGING_EXPECTED_SHA, "STAGING_EXPECTED_SHA");
  const checkedOutSha = requireExactSha(env.GITHUB_SHA, "GITHUB_SHA");
  if (expectedSha !== checkedOutSha) {
    throw new Error("The checked-out commit does not equal the exact staging candidate SHA.");
  }
  const token = env.SUPABASE_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error("SUPABASE_ACCESS_TOKEN is required for staging migration apply.");
  }
  return token;
}

export async function runStagingMigrations({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const versions = [...TARGET_VERSIONS];
  if ((env.STAGING_MIGRATION_CONFIRMATION?.trim() ?? "") === "") {
    log("Staging migrations were not requested; no credential or network access occurred.");
    return {
      applied: false,
      projectRef: STAGING_PROJECT_REF,
      status: "not-requested",
      versions,
    };
  }

  const token = validateRequestedEnvironment(env);
  const files = await loadManifestFiles();
  const before = await readState(fetchImpl, token, "read-only preflight");
  if (classifyState(before) === "applied") {
    log("The exact isolated staging migration set is already applied and reconciled.");
    return {
      applied: false,
      projectRef: STAGING_PROJECT_REF,
      status: "already-applied",
      versions,
    };
  }

  await requestJson(
    fetchImpl,
    token,
    MANAGEMENT_API,
    { query: buildMutationSql(files), read_only: false },
    "mutation",
  );
  const after = await readState(fetchImpl, token, "read-only reconciliation");
  if (classifyState(after) !== "applied") {
    throw new Error("Staging migration reconciliation did not prove the exact applied state.");
  }
  log("Applied and reconciled the exact isolated staging migration set.");
  return {
    applied: true,
    projectRef: STAGING_PROJECT_REF,
    status: "applied",
    versions,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStagingMigrations()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Staging migration failed.");
      process.exitCode = 1;
    });
}
