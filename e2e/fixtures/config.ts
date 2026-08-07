import {
  createHash,
  timingSafeEqual,
} from "node:crypto";

type Environment = Record<string, string | undefined>;

const STAGING_APPLICATION_ORIGIN =
  "https://terroir-web-staging.up.railway.app";
const STAGING_PROJECT_REF = "wwhxcgtcecsftcivosop";
const STAGING_SUPABASE_ORIGIN =
  `https://${STAGING_PROJECT_REF}.supabase.co`;
const VALIDATED_STAGING_CONFIG = Symbol("validated-staging-e2e-config");

export type IsolatedE2eConfig = {
  readonly [VALIDATED_STAGING_CONFIG]: true;
  baseUrl: string;
  publishableKey: string;
  runId: string;
  serviceRoleKey: string;
  stagingProjectRef: string;
  supabaseUrl: string;
};

export type FixtureIdentity = {
  email: string;
  foreignRestaurantId: string;
  inventoryId: string;
  listId: string;
  namespace: string;
  restaurantId: string;
  secondInventoryId: string;
  secondListId: string;
  secondRestaurantId: string;
  secondSectionId: string;
  secondWineId: string;
  secondWineListItemId: string;
  sectionId: string;
  storagePath: string;
  wineId: string;
  wineListItemId: string;
};

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for isolated E2E.`);
  return value;
}

function requireExactOrigin(value: string, expected: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (url.origin !== expected || url.href !== `${expected}/`) {
    throw new Error(`${name} must equal the named staging origin.`);
  }
  return url.origin;
}

function credentialFingerprint(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function requireStagingCredential(
  value: string,
  expectedFingerprint: string,
  expectedRole: "anon" | "service_role",
  name: string,
): void {
  if (!/^[a-f0-9]{64}$/i.test(expectedFingerprint)) {
    throw new Error(`${name}_SHA256 must be a 64-character SHA-256 fingerprint.`);
  }
  const expected = Buffer.from(expectedFingerprint, "hex");
  if (!timingSafeEqual(credentialFingerprint(value), expected)) {
    throw new Error(`${name} does not match the staging credential fingerprint.`);
  }

  const parts = value.split(".");
  if (parts.length === 3) {
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      throw new Error(`${name} is not a valid scoped Supabase credential.`);
    }
    if (
      !payload
      || typeof payload !== "object"
      || (payload as { ref?: unknown }).ref !== STAGING_PROJECT_REF
      || (payload as { role?: unknown }).role !== expectedRole
    ) {
      throw new Error(`${name} is not scoped to the named staging project and role.`);
    }
    return;
  }

  const expectedPrefix = expectedRole === "anon" ? "sb_publishable_" : "sb_secret_";
  if (!value.startsWith(expectedPrefix)) {
    throw new Error(`${name} is not a recognized staging Supabase credential.`);
  }
}

export function readIsolatedE2eConfig(
  env: Environment = process.env,
): IsolatedE2eConfig | null {
  if (env.TERROIR_E2E_ENABLED !== "1") return null;

  const baseUrl = requireExactOrigin(
    required(env, "TERROIR_E2E_BASE_URL"),
    STAGING_APPLICATION_ORIGIN,
    "TERROIR_E2E_BASE_URL",
  );
  const supabaseUrl = requireExactOrigin(
    required(env, "TERROIR_E2E_SUPABASE_URL"),
    STAGING_SUPABASE_ORIGIN,
    "TERROIR_E2E_SUPABASE_URL",
  );
  const runId = required(env, "TERROIR_E2E_RUN_ID");
  if (!/^[a-z0-9][a-z0-9-]{7,79}$/i.test(runId)) {
    throw new Error(
      "TERROIR_E2E_RUN_ID must be an opaque 8-80 character identifier.",
    );
  }

  const publishableKey = required(
    env,
    "TERROIR_E2E_SUPABASE_PUBLISHABLE_KEY",
  );
  const serviceRoleKey = required(env, "TERROIR_E2E_SERVICE_ROLE_KEY");
  requireStagingCredential(
    publishableKey,
    required(env, "TERROIR_E2E_SUPABASE_PUBLISHABLE_KEY_SHA256"),
    "anon",
    "TERROIR_E2E_SUPABASE_PUBLISHABLE_KEY",
  );
  requireStagingCredential(
    serviceRoleKey,
    required(env, "TERROIR_E2E_SERVICE_ROLE_KEY_SHA256"),
    "service_role",
    "TERROIR_E2E_SERVICE_ROLE_KEY",
  );

  return Object.freeze({
    [VALIDATED_STAGING_CONFIG]: true as const,
    baseUrl,
    publishableKey,
    runId,
    serviceRoleKey,
    stagingProjectRef: STAGING_PROJECT_REF,
    supabaseUrl,
  });
}

export function assertIsolatedE2eConfig(
  config: IsolatedE2eConfig,
): void {
  if (
    config[VALIDATED_STAGING_CONFIG] !== true
    || config.baseUrl !== STAGING_APPLICATION_ORIGIN
    || config.stagingProjectRef !== STAGING_PROJECT_REF
    || config.supabaseUrl !== STAGING_SUPABASE_ORIGIN
  ) {
    throw new Error("The fixture helper requires a validated staging configuration.");
  }
}

export function buildFixtureIdentity(
  runId: string,
  testSlot: string,
  workerIndex: number,
): FixtureIdentity {
  const seed = `${runId}:${workerIndex}:${testSlot}`;
  const namespace = createHash("sha256").update(seed).digest("hex").slice(0, 20);
  const restaurantId = uuidFromSeed(`${seed}:restaurant`);
  const wineId = uuidFromSeed(`${seed}:wine`);

  return {
    email: `terroir-e2e-${namespace}@terroir.test`,
    foreignRestaurantId: uuidFromSeed(`${seed}:foreign-restaurant`),
    inventoryId: uuidFromSeed(`${seed}:inventory`),
    listId: uuidFromSeed(`${seed}:list`),
    namespace,
    restaurantId,
    secondInventoryId: uuidFromSeed(`${seed}:second-inventory`),
    secondListId: uuidFromSeed(`${seed}:second-list`),
    secondRestaurantId: uuidFromSeed(`${seed}:second-restaurant`),
    secondSectionId: uuidFromSeed(`${seed}:second-section`),
    secondWineId: uuidFromSeed(`${seed}:second-wine`),
    secondWineListItemId: uuidFromSeed(`${seed}:second-list-item`),
    sectionId: uuidFromSeed(`${seed}:section`),
    storagePath: `${restaurantId}/${wineId}/fixture-${namespace}.webp`,
    wineId,
    wineListItemId: uuidFromSeed(`${seed}:list-item`),
  };
}

function uuidFromSeed(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
