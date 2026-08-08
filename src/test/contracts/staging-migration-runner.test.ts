import { describe, expect, test, vi } from "vitest";
import {
  STAGING_MIGRATION_CONFIRMATION,
  STAGING_PROJECT_REF,
  runStagingMigrations,
} from "../../../scripts/apply-staging-migrations.mjs";

const EXPECTED_SHA = "f78ef0a114fa86f7329ae2e8b8b95313bcd7571b";
const TOKEN = "sbp_test-token-that-must-never-be-logged";

type MigrationState = {
  enqueue_contract: "manager_wine_enrichment" | "staff_all_jobs";
  has_market_columns: boolean;
  has_market_trigger: boolean;
  migrations: Array<{
    name: string;
    source_hash_marker: string | null;
    version: string;
  }>;
  service_role_enrichment: boolean;
};

function environment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    GITHUB_REF: "refs/heads/staging",
    GITHUB_SHA: EXPECTED_SHA,
    GITHUB_ACTOR: "wiggdevin",
    RUN_WINE_ENRICHMENT_WORKER_PILOT: "false",
    STAGING_EXPECTED_SHA: EXPECTED_SHA,
    STAGING_MIGRATION_CONFIRMATION,
    STAGING_SUPABASE_URL: `https://${STAGING_PROJECT_REF}.supabase.co`,
    SUPABASE_ACCESS_TOKEN: TOKEN,
    STAGING_RELEASE_OWNER: "wiggdevin",
    ...overrides,
  };
}

function baselineState(): MigrationState {
  return {
    enqueue_contract: "staff_all_jobs",
    has_market_columns: false,
    has_market_trigger: false,
    migrations: [
      {
        name: "audited_cellar_quantity_adjustments",
        source_hash_marker: null,
        version: "20260808032000",
      },
      {
        name: "atomic_wine_metadata_overrides",
        source_hash_marker: null,
        version: "20260808053800",
      },
      {
        name: "bottle_scan_inventory_provenance",
        source_hash_marker: null,
        version: "20260808053900",
      },
    ],
    service_role_enrichment: false,
  };
}

function migratedState(): MigrationState {
  return {
    enqueue_contract: "manager_wine_enrichment",
    has_market_columns: true,
    has_market_trigger: true,
    migrations: [
      ...baselineState().migrations,
      {
        name: "wine_enrichment_worker_authority",
        source_hash_marker:
          "sha256:dfbede2ec9c67d64afdf5e0cb261c3c921f8d4e5d6df3572621bb656f5b4c26c",
        version: "20260808224400",
      },
      {
        name: "market_price_shift_observations",
        source_hash_marker:
          "sha256:9cd78a381a0628ddccd452a6bfe2d4a07e0bb4cb730822974f82584b36913ee9",
        version: "20260808224500",
      },
      {
        name: "background_job_enqueue_authorization",
        source_hash_marker:
          "sha256:c41a909a61cc4b223ae9d8da4379d9e4c9a538a5ff8febcc2bda551cecde286f",
        version: "20260808224600",
      },
    ],
    service_role_enrichment: true,
  };
}

function queryResponse(state: MigrationState): Response {
  return new Response(JSON.stringify([{ state }]), {
    headers: { "content-type": "application/json" },
    status: 201,
  });
}

function mutationResponse(): Response {
  return new Response(null, { status: 201 });
}

describe("guarded staging migration runner", () => {
  test("applies the fixed migration set atomically to only isolated staging", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(queryResponse(baselineState()))
      .mockResolvedValueOnce(mutationResponse())
      .mockResolvedValueOnce(queryResponse(migratedState()));

    const result = await runStagingMigrations({
      env: environment(),
      fetchImpl,
      log: vi.fn(),
    });

    expect(result).toEqual({
      applied: true,
      projectRef: STAGING_PROJECT_REF,
      status: "applied",
      versions: ["20260808224400", "20260808224500", "20260808224600"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const [preflightUrl, preflightInit] = fetchImpl.mock.calls[0];
    expect(String(preflightUrl)).toBe(
      `https://api.supabase.com/v1/projects/${STAGING_PROJECT_REF}/database/query/read-only`,
    );
    expect(JSON.parse(String(preflightInit?.body))).toMatchObject({
      query: expect.stringContaining("supabase_migrations.schema_migrations"),
    });
    expect(String(preflightInit?.body)).toContain("pg_get_functiondef");
    expect(String(preflightInit?.body)).not.toContain("obj_description");

    const [mutationUrl, mutationInit] = fetchImpl.mock.calls[1];
    const mutation = JSON.parse(String(mutationInit?.body)).query as string;
    expect(String(mutationUrl)).toBe(
      `https://api.supabase.com/v1/projects/${STAGING_PROJECT_REF}/database/query`,
    );
    expect(mutation).toMatch(/^begin;/);
    expect(mutation).toContain("pg_advisory_xact_lock");
    expect(mutation.indexOf("TER-021G: allow only")).toBeLessThan(
      mutation.indexOf("TER-CF-169: retain the prior market observation"),
    );
    expect(
      mutation.indexOf("TER-CF-169: retain the prior market observation"),
    ).toBeLessThan(
      mutation.indexOf("Integrated security review: manager-only jobs"),
    );
    expect(mutation).toContain("savepoint ter_0084_acceptance");
    expect(mutation).toContain("rollback to savepoint ter_0084_acceptance");
    expect(mutation).toContain("savepoint ter_0085_acceptance");
    expect(mutation).toContain("savepoint ter_0086_acceptance");
    expect(mutation).toContain("supabase_migrations.schema_migrations");
    expect(mutation).toContain(
      "sha256:c41a909a61cc4b223ae9d8da4379d9e4c9a538a5ff8febcc2bda551cecde286f",
    );
    expect(mutation).toMatch(/commit;\s*$/);
    expect(String(mutationUrl)).not.toContain(TOKEN);
    expect(String(mutationInit?.body)).not.toContain(TOKEN);
    expect(mutationInit?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
  });

  test("treats the exact already-applied state as a reconciled no-op", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(queryResponse(migratedState()));

    await expect(
      runStagingMigrations({ env: environment(), fetchImpl, log: vi.fn() }),
    ).resolves.toEqual({
      applied: false,
      projectRef: STAGING_PROJECT_REF,
      status: "already-applied",
      versions: ["20260808224400", "20260808224500", "20260808224600"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      "production Supabase URL",
      { STAGING_SUPABASE_URL: "https://qcfmwphlaekfkqwkfyth.supabase.co" },
    ],
    ["wrong confirmation", { STAGING_MIGRATION_CONFIRMATION: "MIGRATE-production" }],
    ["non-exact SHA", { STAGING_EXPECTED_SHA: "f78ef0a" }],
    ["different checked-out SHA", { GITHUB_SHA: "0".repeat(40) }],
    ["missing token", { SUPABASE_ACCESS_TOKEN: undefined }],
    ["worker pilot", { RUN_WINE_ENRICHMENT_WORKER_PILOT: "true" }],
    ["different actor", { GITHUB_ACTOR: "untrusted-user" }],
    ["different Git ref", { GITHUB_REF: "refs/heads/main" }],
  ])("rejects %s before reaching Supabase", async (_label, overrides) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      runStagingMigrations({
        env: environment(overrides),
        fetchImpl,
        log: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("permits an unconfirmed staging push as a credential-free no-op", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      runStagingMigrations({
        env: environment({
          STAGING_MIGRATION_CONFIRMATION: "",
          SUPABASE_ACCESS_TOKEN: undefined,
        }),
        fetchImpl,
        log: vi.fn(),
      }),
    ).resolves.toEqual({
      applied: false,
      projectRef: STAGING_PROJECT_REF,
      status: "not-requested",
      versions: ["20260808224400", "20260808224500", "20260808224600"],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("fails closed on prerequisite drift, partial targets, and hash drift", async () => {
    const states = [
      { ...baselineState(), migrations: baselineState().migrations.slice(1) },
      {
        ...baselineState(),
        migrations: baselineState().migrations.map((migration) =>
          migration.name === "atomic_wine_metadata_overrides"
            ? { ...migration, version: "20260808000000" }
            : migration,
        ),
      },
      {
        ...baselineState(),
        migrations: baselineState().migrations.map((migration) =>
          migration.version === "20260808053900"
            ? { ...migration, name: "unexpected_migration" }
            : migration,
        ),
      },
      {
        ...baselineState(),
        migrations: [
          ...baselineState().migrations,
          migratedState().migrations[3],
        ],
      },
      {
        ...migratedState(),
        migrations: migratedState().migrations.map((migration) =>
          migration.name === "market_price_shift_observations"
            ? { ...migration, source_hash_marker: "sha256:wrong" }
            : migration,
        ),
      },
    ];

    for (const state of states) {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(queryResponse(state));
      await expect(
        runStagingMigrations({ env: environment(), fetchImpl, log: vi.fn() }),
      ).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  test("does not retry or expose the token after an ambiguous mutation failure", async () => {
    const log = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(queryResponse(baselineState()))
      .mockRejectedValueOnce(new Error(`socket closed ${TOKEN}`));

    let message = "";
    try {
      await runStagingMigrations({ env: environment(), fetchImpl, log });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(message).toMatch(/state is unknown/i);
    expect(message).not.toContain(TOKEN);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });

  test("treats a mutation HTTP 5xx as ambiguous and does not retry", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(queryResponse(baselineState()))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: TOKEN }), { status: 503 }),
      );

    let message = "";
    try {
      await runStagingMigrations({ env: environment(), fetchImpl, log: vi.fn() });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(message).toContain("HTTP 503");
    expect(message).toMatch(/state is unknown/i);
    expect(message).toMatch(/reconcile before retrying/i);
    expect(message).not.toContain(TOKEN);
  });

  test.each([401, 403, 429, 500, 503])(
    "reports HTTP %i without returning provider response content",
    async (status) => {
      const log = vi.fn();
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: TOKEN }), { status }),
      );

      let message = "";
      try {
        await runStagingMigrations({ env: environment(), fetchImpl, log });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain(`HTTP ${status}`);
      expect(message).not.toContain(TOKEN);
      expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  test("fails closed when a read-only response is not valid JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("not-json", { status: 201 }),
    );

    await expect(
      runStagingMigrations({ env: environment(), fetchImpl, log: vi.fn() }),
    ).rejects.toThrow("invalid JSON");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
