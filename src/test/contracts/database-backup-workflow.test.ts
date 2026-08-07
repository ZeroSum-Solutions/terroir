import { createHash } from "node:crypto";
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
    expect(workflow).toContain(
      "n.nspname in ('auth', 'public', 'storage')",
    );
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
    const { assertSchemaCoverage, parseArchiveSchemas } =
      await loadScript("assert-dump-coverage");
    const archive = parseArchiveSchemas(`
123; 0 0 SCHEMA - auth supabase_auth_admin
124; 0 0 SCHEMA - public postgres
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
    expect(config).toContain("sslmode=require");
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
    expect(sql).toContain("grant pg_read_all_data");
    expect(sql).toContain("default_transaction_read_only = on");
    expect(sql).toContain(
      "password 'a-very-long-''quoted''-backup-role-password'",
    );
  });

  it("mechanically refuses a non-loopback restore target", async () => {
    const { assertDisposableRestoreUrl } =
      await loadScript("assert-disposable-target");
    expect(() =>
      assertDisposableRestoreUrl(
        "postgresql://postgres:password@127.0.0.1:54322/postgres",
      ),
    ).not.toThrow();
    expect(() =>
      assertDisposableRestoreUrl(
        "postgresql://postgres:password@db.production.test:5432/postgres",
      ),
    ).toThrow(/non-loopback/u);
    expect(() =>
      assertDisposableRestoreUrl(
        "postgresql://postgres:password@localhost:54322/customer_data",
      ),
    ).toThrow(/disposable postgres DB/u);
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
    const manifest = createBackupManifest({
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
  });

  it("detects artifact tampering and compares exact restore evidence", async () => {
    const { compareDatabaseEvidence } =
      await loadScript("compare-database-evidence");
    const source = {
      format_version: 1,
      migration_version: "0065",
      tables: [
        { schema: "public", table: "wines", row_count: 2 },
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
      }),
    );
    const changed = structuredClone(source);
    changed.tables[0].row_count = 1;
    changed.largest_non_empty_tables[0].sha256 = "def";
    expect(compareDatabaseEvidence(source, changed)).toEqual(
      expect.objectContaining({
        ok: false,
        failures: expect.arrayContaining([
          expect.stringContaining("row count differs"),
          expect.stringContaining("content checksum differs"),
        ]),
      }),
    );
  });
});
