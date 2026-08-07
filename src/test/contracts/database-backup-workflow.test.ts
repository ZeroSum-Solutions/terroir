import { createHash, X509Certificate } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

async function loadScript(name: string) {
  return import(
    pathToFileURL(
      resolve(process.cwd(), `scripts/backup/${name}.mjs`),
    ).href
  );
}

describe("database backup workflow", () => {
  it("uploads only encrypted payloads and checksum metadata", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), ".github/workflows/db-backup.yml"),
      "utf8",
    );

    expect(workflow).toContain("BACKUP_AGE_RECIPIENT");
    expect(workflow).toContain("age --encrypt");
    expect(workflow).toContain("pg_read_all_data");
    expect(workflow).toContain("rolsuper");
    expect(workflow).toContain("pg_write_all_data");
    expect(workflow).toContain("e.extnamespace = n.oid");
    expect(workflow).toContain("d.deptype = 'e'");
    expect(workflow).toContain("BACKUP_PG_DUMP_VERSION");
    expect(workflow).toContain('pg_bin="/usr/lib/postgresql/17/bin"');
    expect(workflow).toContain('echo "$pg_bin" >> "$GITHUB_PATH"');
    expect(workflow).toContain("artifact-digest");
    expect(workflow).toContain("${api_digest#sha256:}");
    expect(workflow).toContain("assert-dump-coverage.mjs");
    expect(workflow).toContain("pg_export_snapshot");
    expect(workflow).toContain("--snapshot=\"$backup_snapshot\"");
    expect(workflow).toContain(
      "BACKUP_SNAPSHOT_ID=\"$backup_snapshot\"",
    );
    expect(workflow).toContain("Database backup integrity ledger");
    expect(workflow).toContain("retention-days: 90");
    expect(workflow).toContain("\"$dump_file\"");
    expect(workflow).toContain("\"$PGSERVICEFILE\"");
    expect(workflow).toContain("set -euo pipefail");
    expect(workflow).toContain(
      "[[ \"$BACKUP_DIR\" == \"$RUNNER_TEMP/\"* ]]",
    );
    const jobEnvironment = workflow.slice(
      workflow.indexOf("    env:"),
      workflow.indexOf("    steps:"),
    );
    expect(jobEnvironment).not.toContain("secrets.");

    const upload = workflow.slice(
      workflow.indexOf("- name: Upload encrypted backup and metadata"),
      workflow.indexOf(
        "- name: Remove transient credentials and plaintext",
      ),
    );
    expect(upload).toContain("encrypted_file");
    expect(upload).toContain("manifest_file");
    expect(upload).toContain("checksums_file");
    expect(upload).not.toContain("dump_file");
    expect(upload).not.toContain("payload_file");
    expect(upload).not.toContain("evidence_file");
    expect(upload).not.toContain("secrets.");
  });

  it("fails when a non-system schema is absent from the archive", async () => {
    const {
      assertSchemaCoverage,
      parseArchiveSchemas,
      parseDumpableSchemaRows,
    } =
      await loadScript("assert-dump-coverage");
    const archive = parseArchiveSchemas(`
123; 0 0 SCHEMA - auth supabase_auth_admin
124; 1259 123 TABLE public wines postgres
125; 0 0 SCHEMA - storage supabase_storage_admin
`);

    expect(() =>
      assertSchemaCoverage({
        source: ["auth", "public", "storage"],
        archive,
      }),
    ).not.toThrow();
    expect(() =>
      assertSchemaCoverage({
        source: ["auth", "custom_app", "public", "storage"],
        archive,
      }),
    ).toThrow(/custom_app/u);
    expect(parseDumpableSchemaRows("public\npublic\naudit\n")).toEqual([
      "audit",
      "public",
    ]);
    expect(() =>
      assertSchemaCoverage({
        source: parseDumpableSchemaRows("public\n"),
        archive,
      }),
    ).not.toThrow();
  });

  it("writes a libpq service with safe raw INI values and no URL query drift", async () => {
    const { createPgServiceConfig } =
      await loadScript("write-pg-service");
    const config = createPgServiceConfig(
      "postgresql://backup:p%40ss-word@db.example.test:5432/postgres",
    );

    expect(config).toContain("[terroir_backup]");
    expect(config).toContain("host=db.example.test");
    expect(config).toContain("user=backup");
    expect(config).toContain("password=p@ss-word");
    expect(config).toContain("sslmode=verify-full");
    expect(config).toContain("sslrootcert=");
    expect(config).toContain("supabase-root-2021-ca.crt");
    expect(() =>
      createPgServiceConfig(
        "postgresql://backup:p%27ssword@db.example.test/postgres",
      ),
    ).toThrow(/service-file-safe/u);
    expect(() =>
      createPgServiceConfig(
        "postgresql://backup:password@db.example.test/postgres?sslmode=disable",
      ),
    ).toThrow(/query parameters/u);
    expect(() =>
      createPgServiceConfig(
        "postgresql://terroir_backup.project-ref:password@aws-1-us-west-1.pooler.supabase.com:5432/postgres",
        "terroir_backup",
        "project-ref",
      ),
    ).not.toThrow();
    expect(() =>
      createPgServiceConfig(
        "postgresql://terroir_backup.project-ref:password@aws-1-us-west-1.pooler.supabase.com:6543/postgres",
        "terroir_backup",
        "project-ref",
      ),
    ).toThrow(/session pooler port 5432/u);
    const localRestore = createPgServiceConfig(
      "postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres",
      "terroir_restore",
    );
    expect(localRestore).toContain("sslmode=disable");
    expect(localRestore).not.toContain("sslrootcert");

    const certificate = new X509Certificate(
      readFileSync(
        resolve(process.cwd(), "config/supabase-root-2021-ca.crt"),
      ),
    );
    expect(certificate.ca).toBe(true);
    expect(certificate.fingerprint256).toBe(
      "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
    );
  });

  it("derives only the expected port-5432 session-pooler backup URL", async () => {
    const { createBackupDatabaseUrl } =
      await loadScript("create-backup-database-url");
    const backupPassword = "p@ssword-".repeat(5);
    const url = createBackupDatabaseUrl({
      adminUrl:
        "postgresql://postgres.qcfmwphlaekfkqwkfyth:admin@aws-0-us-west-1.pooler.supabase.com:5432/postgres",
      backupPassword,
    });
    const parsed = new URL(url);

    expect(decodeURIComponent(parsed.username)).toBe(
      "terroir_backup.qcfmwphlaekfkqwkfyth",
    );
    expect(decodeURIComponent(parsed.password)).toBe(backupPassword);
    expect(parsed.port).toBe("5432");
    expect(() =>
      createBackupDatabaseUrl({
        adminUrl:
          "postgresql://postgres.qcfmwphlaekfkqwkfyth:admin@aws-0-us-west-1.pooler.supabase.com:6543/postgres",
        backupPassword,
      }),
    ).toThrow(/session pooler/u);
    expect(() =>
      createBackupDatabaseUrl({
        adminUrl:
          "postgresql://postgres:admin@db.qcfmwphlaekfkqwkfyth.supabase.co:5432/postgres",
        backupPassword,
      }),
    ).toThrow(/session pooler/u);
  });

  it("provisions a non-privileged read-only role without interpolating identifiers", async () => {
    const { createBackupRoleSql } =
      await loadScript("provision-backup-role");
    const sql = createBackupRoleSql(
      "a-very-long-'quoted'-backup-role-password",
    );

    expect(sql).toContain("alter role terroir_backup");
    expect(sql).toContain("and rolsuper");
    expect(sql).toContain("must never be a superuser");
    expect(sql).toContain("nocreatedb");
    expect(sql).toContain("nocreaterole");
    expect(sql).toContain("bypassrls");
    expect(sql).toContain("inherit");
    expect(sql).toContain("revoke all privileges on %s %I.%I");
    expect(sql).toContain("granted_role.rolname <> 'pg_read_all_data'");
    expect(sql).toContain("grant pg_read_all_data");
    expect(sql).toContain("default_transaction_read_only = on");
    expect(sql).toContain("statement_timeout = 0");
    expect(sql).toContain("idle_in_transaction_session_timeout = 0");
    expect(sql).toContain(
      "password 'a-very-long-''quoted''-backup-role-password'",
    );
  });

  it("parses PostgreSQL sequence state without assuming display booleans", async () => {
    const { parseSequenceState, parseTableInventory, snapshotSql } =
      await loadScript("collect-database-evidence");

    expect(parseSequenceState("42\ttrue", "public", "wine_id_seq")).toEqual({
      schema: "public",
      sequence: "wine_id_seq",
      last_value: "42",
      is_called: true,
    });
    expect(parseSequenceState("1\tfalse", "auth", "token_id_seq")).toEqual({
      schema: "auth",
      sequence: "token_id_seq",
      last_value: "1",
      is_called: false,
    });
    expect(() =>
      parseSequenceState("1\tt", "public", "wine_id_seq"),
    ).toThrow(/Invalid sequence state/u);
    expect(
      parseTableInventory(
        "public\twines\tr\npublic\twine_partitions\tp",
      ),
    ).toEqual([
      { schema: "public", table: "wines", kind: "table" },
      {
        schema: "public",
        table: "wine_partitions",
        kind: "partitioned",
      },
    ]);
    expect(snapshotSql("select 1", "00000003-1")).toContain(
      "set transaction snapshot '00000003-1'",
    );
    expect(() => snapshotSql("select 1", "bad'; drop table wines"))
      .toThrow(/invalid format/u);
  });

  it("accepts only the exact privileged disposable target", async () => {
    const { assertDisposableRestoreUrl } =
      await loadScript("assert-disposable-target");
    expect(() =>
      assertDisposableRestoreUrl(
        "postgresql://supabase_admin:password@127.0.0.1:54322/postgres",
      ),
    ).not.toThrow();
    expect(() =>
      assertDisposableRestoreUrl(
        "postgresql://supabase_admin:password@localhost:54322/postgres",
      ),
    ).toThrow(/non-loopback/u);
  });

  it("mechanically refuses a non-loopback restore target", async () => {
    const { assertDisposableRestoreUrl } =
      await loadScript("assert-disposable-target");
    expect(() =>
      assertDisposableRestoreUrl(
        "postgresql://supabase_admin:password@127.0.0.1:54322/postgres",
      ),
    ).not.toThrow();
    expect(() =>
      assertDisposableRestoreUrl(
        "postgresql://postgres:password@db.production.test:5432/postgres",
      ),
    ).toThrow(/non-loopback/u);
    expect(() =>
      assertDisposableRestoreUrl(
        "postgresql://supabase_admin:password@127.0.0.1:54322/customer_data",
      ),
    ).toThrow(/disposable postgres DB/u);
    expect(() =>
      assertDisposableRestoreUrl(
        "postgresql://supabase_admin:password@127.0.0.1:5432/postgres",
      ),
    ).toThrow(/canonical local Supabase/u);
  });

  it("binds plaintext, evidence, encrypted artifact, and run provenance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terroir-backup-test-"));
    const dump = join(dir, "db.dump");
    const evidence = join(dir, "source-evidence.json");
    const payload = join(dir, "db.tar");
    const encrypted = join(dir, "db.tar.age");
    writeFileSync(dump, "dump bytes");
    writeFileSync(evidence, '{"tables":[]}');
    writeFileSync(payload, "payload bytes");
    writeFileSync(encrypted, "encrypted bytes");

    const { createBackupManifest } =
      await loadScript("create-manifest");
    const manifest = await createBackupManifest({
      BACKUP_DUMP_FILE: dump,
      BACKUP_EVIDENCE_FILE: evidence,
      BACKUP_PAYLOAD_FILE: payload,
      BACKUP_ENCRYPTED_FILE: encrypted,
      BACKUP_TABLE_DATA_ENTRIES: "7",
      BACKUP_PROJECT_REF: "project-ref",
      BACKUP_AGE_RECIPIENT: "age1recipient",
      BACKUP_PG_DUMP_VERSION: "pg_dump (PostgreSQL) 17.6",
      BACKUP_AGE_VERSION: "v1.2.1",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    });

    expect(manifest.source).toEqual(
      expect.objectContaining({
        project_ref: "project-ref",
        git_sha: "a".repeat(40),
        github_run_id: "123",
        github_run_attempt: "2",
      }),
    );
    expect(manifest.dump).toEqual(
      expect.objectContaining({
        table_data_entries: 7,
        pg_dump_version: "pg_dump (PostgreSQL) 17.6",
        sha256: createHash("sha256")
          .update("dump bytes")
          .digest("hex"),
      }),
    );
    expect(manifest.encrypted_artifact).toEqual(
      expect.objectContaining({ name: "db.tar.age" }),
    );
    expect(manifest.encryption).toEqual(
      expect.objectContaining({ age_version: "v1.2.1" }),
    );

    const manifestFile = join(dir, "db.manifest.json");
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const { verifyBackupArtifact } =
      await loadScript("verify-artifact");
    await expect(
      verifyBackupArtifact({
        manifestFile,
        encryptedFile: encrypted,
        payloadFile: payload,
        dumpFile: dump,
        evidenceFile: evidence,
      }),
    ).resolves.toEqual(manifest);
    writeFileSync(encrypted, "tampered encrypted bytes");
    await expect(
      verifyBackupArtifact({ manifestFile, encryptedFile: encrypted }),
    ).rejects.toThrow(/Encrypted artifact (byte length|SHA-256)/u);
  });

  it("streams evidence for a large artifact without a whole-file read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terroir-stream-test-"));
    const file = join(dir, "large.dump");
    const content = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    writeFileSync(file, content);
    const { streamFileEvidence } = await loadScript("file-evidence");

    await expect(streamFileEvidence(file)).resolves.toEqual({
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  });

  it("rejects checksum path traversal and duplicate entries", async () => {
    const { assertChecksumFile } =
      await loadScript("verify-checksum-file");
    const digest = "a".repeat(64);
    expect(() =>
      assertChecksumFile(
        `${digest}  backup.tar.age\n${digest}  backup.manifest.json\n`,
        ["/tmp/backup.tar.age", "/tmp/backup.manifest.json"],
      ),
    ).not.toThrow();
    expect(() =>
      assertChecksumFile(
        `${digest}  ../../outside\n${digest}  backup.manifest.json\n`,
        ["/tmp/backup.tar.age", "/tmp/backup.manifest.json"],
      ),
    ).toThrow(/unsafe or unexpected/u);
    expect(() =>
      assertChecksumFile(
        `${digest}  backup.tar.age\n${digest}  backup.tar.age\n`,
        ["/tmp/backup.tar.age", "/tmp/backup.manifest.json"],
      ),
    ).toThrow(/unsafe or unexpected/u);
  });

  it("builds a fail-closed data-only restore preparation", async () => {
    const { createRestorePreparationSql } =
      await loadScript("prepare-disposable-restore");
    const sql = createRestorePreparationSql({
      format_version: 1,
      tables: [
        { schema: "auth", table: "users", row_count: 1 },
        {
          schema: "supabase_migrations",
          table: "schema_migrations",
          row_count: 73,
        },
        {
          schema: "public",
          table: 'wine"partitions',
          kind: "partitioned",
          row_count: 2,
        },
      ],
    });
    expect(sql).toContain(
      'truncate table "auth"."users", "supabase_migrations"."schema_migrations", "public"."wine""partitions" restart identity cascade;',
    );
    expect(sql).toContain('add column if not exists "created_by" text');
    expect(sql).toContain(
      'add column if not exists "idempotency_key" text',
    );
    expect(sql).toContain('add column if not exists "rollback" text[]');
    expect(sql).toContain("data_type <> 'text'");
    expect(() =>
      createRestorePreparationSql({ format_version: 1, tables: [] }),
    ).toThrow(/non-empty/u);
    expect(() =>
      createRestorePreparationSql({
        format_version: 1,
        tables: [
          { schema: "public", table: "wines" },
          { schema: "public", table: "wines" },
        ],
      }),
    ).toThrow(/unique/u);
  });

  it("requires a compatible local Supabase runtime", async () => {
    const { assertSupabaseCliVersion } =
      await loadScript("assert-supabase-cli-version");
    expect(() => assertSupabaseCliVersion("2.112.0")).not.toThrow();
    expect(() => assertSupabaseCliVersion("2.113.1")).not.toThrow();
    expect(() => assertSupabaseCliVersion("2.107.0")).toThrow(/too old/u);
    expect(() => assertSupabaseCliVersion("latest")).toThrow(/invalid/u);
  });

  it("provides one guarded data-only restore drill entrypoint", () => {
    const script = readFileSync(
      resolve(process.cwd(), "scripts/backup/run-restore-drill.sh"),
      "utf8",
    );
    expect(script).toContain("assert-disposable-target.mjs");
    expect(script).toContain("assert-supabase-cli-version.mjs");
    expect(script).toContain("supabase db reset");
    expect(script).toContain("prepare-disposable-restore.mjs");
    expect(script).toContain("create-restore-use-list.mjs");
    expect(script).toContain("--data-only");
    expect(script).toContain("--disable-triggers");
    expect(script).toContain("supabase-start.log");
    expect(script).toContain("supabase-reset.log");
    expect(script).not.toContain("--clean");
  });

  it("selects only authenticated archive data and excludes platform rows", async () => {
    const { createRestoreUseList } =
      await loadScript("create-restore-use-list");
    const listing = `; Archive created at 2026-08-07
100; 0 0 TABLE DATA cron job postgres
101; 0 0 TABLE DATA public wines postgres
102; 0 0 TABLE DATA public wines_shadow postgres
103; 0 0 TABLE DATA public wine_partitions postgres
104; 0 0 SEQUENCE SET public wines_id_seq postgres
105; 0 0 SEQUENCE SET cron jobid_seq postgres
`;
    const evidence = {
      format_version: 1,
      tables: [
        { schema: "public", table: "wines", kind: "table" },
        {
          schema: "public",
          table: "wine_partitions",
          kind: "partitioned",
        },
      ],
      sequences: [
        { schema: "public", sequence: "wines_id_seq" },
      ],
    };
    const useList = createRestoreUseList(listing, evidence);
    expect(useList).toContain("TABLE DATA public wines postgres");
    expect(useList).toContain(
      "TABLE DATA public wine_partitions postgres",
    );
    expect(useList).toContain("SEQUENCE SET public wines_id_seq postgres");
    expect(useList).not.toContain("cron job");
    expect(useList).not.toContain("wines_shadow");
  });

  it("fails closed on ambiguous or uncovered archive data", async () => {
    const { createRestoreUseList } =
      await loadScript("create-restore-use-list");
    const evidence = {
      format_version: 1,
      tables: [{ schema: "public", table: "wines", kind: "table" }],
      sequences: [],
    };
    expect(() =>
      createRestoreUseList(
        "101; 0 0 TABLE DATA public wines postgres\n101; 0 0 TABLE DATA public wines postgres\n",
        evidence,
      ),
    ).toThrow(/duplicate TABLE DATA/u);
    expect(() =>
      createRestoreUseList(
        "101; 0 0 TABLE DATA public wines\n",
        evidence,
      ),
    ).toThrow(/unparseable/u);
    expect(() =>
      createRestoreUseList(
        "101; 0 0 TABLE DATA public wines postgres\n102; 0 0 BLOBS - - postgres\n",
        evidence,
      ),
    ).toThrow(/large-object data/u);
    expect(() =>
      createRestoreUseList(
        "101; 0 0 TABLE DATA public wines postgres\n",
        {
          ...evidence,
          tables: [{ schema: "public", table: "wines owner" }],
        },
      ),
    ).toThrow(/unsupported identifier/u);
  });

  it("validates the redacted role-state vector", async () => {
    const { assertBackupRoleState, EXPECTED_BACKUP_ROLE_STATE } =
      await loadScript("assert-backup-role-state");
    expect(() =>
      assertBackupRoleState(EXPECTED_BACKUP_ROLE_STATE),
    ).not.toThrow();
    expect(() =>
      assertBackupRoleState("f|f|f|t|f|t|f|1|0|0|0|t|t"),
    ).toThrow(/expected .* observed/u);
  });

  it("detects artifact tampering and compares exact restore evidence", async () => {
    const { compareDatabaseEvidence } =
      await loadScript("compare-database-evidence");
    const source = {
      format_version: 1,
      migration_version: "0065",
      tables: [
        {
          schema: "public",
          table: "wines",
          kind: "table",
          row_count: 2,
        },
      ],
      sequences: [
        {
          schema: "public",
          sequence: "wines_id_seq",
          last_value: "2",
          is_called: true,
        },
      ],
      largest_non_empty_tables: [
        {
          schema: "public",
          table: "wines",
          row_count: 2,
          sha256: "abc",
        },
      ],
    };
    expect(compareDatabaseEvidence(source, structuredClone(source))).toEqual(
      expect.objectContaining({
        ok: true,
        table_count: 1,
        checked_content_checksums: 1,
        target_only_tables: [],
        target_only_sequences: [],
      }),
    );
    const forwardTarget = structuredClone(source);
    forwardTarget.tables.push({
      schema: "supabase_functions",
      table: "migrations",
      kind: "table",
      row_count: 2,
    });
    forwardTarget.sequences.push({
      schema: "supabase_functions",
      sequence: "hooks_id_seq",
      last_value: "1",
      is_called: false,
    });
    expect(compareDatabaseEvidence(source, forwardTarget)).toEqual(
      expect.objectContaining({
        ok: true,
        target_only_tables: ["supabase_functions.migrations"],
        target_only_sequences: ["supabase_functions.hooks_id_seq"],
      }),
    );
    const missingSource = structuredClone(source);
    missingSource.tables = [];
    missingSource.sequences = [];
    missingSource.largest_non_empty_tables = [];
    expect(compareDatabaseEvidence(source, missingSource)).toEqual(
      expect.objectContaining({
        ok: false,
        failures: expect.arrayContaining([
          "source table missing after restore for public.wines",
          "source sequence missing after restore for public.wines_id_seq",
        ]),
      }),
    );
    const changed = structuredClone(source);
    changed.tables[0].row_count = 1;
    changed.largest_non_empty_tables[0].sha256 = "def";
    changed.sequences[0].last_value = "1";
    expect(compareDatabaseEvidence(source, changed)).toEqual(
      expect.objectContaining({
        ok: false,
        failures: expect.arrayContaining([
          expect.stringContaining("row count differs"),
          expect.stringContaining("content checksum differs"),
          expect.stringContaining("sequence state differs"),
        ]),
      }),
    );
    const partitioned = structuredClone(source);
    partitioned.tables[0].kind = "partitioned";
    const flattened = structuredClone(partitioned);
    flattened.tables[0].kind = "table";
    expect(compareDatabaseEvidence(partitioned, flattened).failures).toContain(
      "relation kind differs for public.wines",
    );
  });
});
