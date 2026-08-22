#!/usr/bin/env node
/**
 * Disposable restore drill for encrypted Terroir database backups.
 *
 * Proves that a downloaded DB Backup artifact actually restores: verifies
 * the artifact against its manifest and checksum file, decrypts it with an
 * offline age identity, restores the dump into a throwaway PostgreSQL 17
 * Docker container, and diffs exact per-table row counts (plus migration
 * version and content checksums) against the evidence captured at dump
 * time. See docs/RESTORE-DRILL.md for the full runbook.
 *
 * This script never receives or accepts a production or backup-role
 * connection string; the restore target is always a Docker container this
 * script starts and tears down on loopback only.
 *
 * Required env:
 *   RESTORE_ARTIFACT_DIR      Directory containing one *.tar.age,
 *                             *.manifest.json, and *.sha256 (as produced by
 *                             `gh run download`, nested subdirectories ok).
 *   RESTORE_AGE_IDENTITY_FILE Path to a file holding the offline age
 *                             identity. Never pass identity material inline
 *                             on the command line or in an env var value.
 *
 * Optional env:
 *   RESTORE_DOCKER_IMAGE  Postgres image for the scratch DB and its
 *                         pg_restore binary. Must be a Supabase-flavored
 *                         Postgres image (the dump's schema extensions —
 *                         pg_cron, vault, pgsodium, etc. — are not present
 *                         in the vanilla postgres image) matching the
 *                         dump's PostgreSQL major version. Defaults to the
 *                         image documented in docs/RESTORE-DRILL.md.
 *   RESTORE_REPORT_FILE   Where to write the JSON comparison report.
 *                         Defaults to a file inside the work directory.
 *   RESTORE_KEEP_WORKDIR  Set to "1" to keep decrypted material and the
 *                         scratch container running for debugging (default:
 *                         both are destroyed before exit).
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { verifyBackupArtifact } from "./backup/verify-artifact.mjs";
import { compareDatabaseEvidence } from "./backup/compare-database-evidence.mjs";

const PRODUCTION_HOST_FRAGMENTS = [
  "supabase.co",
  "pooler.supabase.com",
  "qcfmwphlaekfkqwkfyth", // Terroir's production Supabase project ref.
];

export function assertScratchRestoreTarget(host) {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Restore drill refuses every non-loopback database target.");
  }
  const lowered = host.toLowerCase();
  for (const fragment of PRODUCTION_HOST_FRAGMENTS) {
    if (lowered.includes(fragment.toLowerCase())) {
      throw new Error(
        `Restore drill target must not reference the production/backup host (${fragment}).`,
      );
    }
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed: ${(result.stderr || result.error?.message || "").trim()}`,
    );
  }
  return result.stdout;
}

function findFilesRecursive(dir, suffix) {
  const matches = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findFilesRecursive(path, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      matches.push(path);
    }
  }
  return matches;
}

function findOne(dir, suffix) {
  const matches = findFilesRecursive(dir, suffix);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${suffix} file under ${dir}, found ${matches.length}.`,
    );
  }
  return matches[0];
}

function verifyChecksumFile(checksumsFile) {
  const baseDir = dirname(checksumsFile);
  const lines = readFileSync(checksumsFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error("Checksums file is empty.");
  }
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/u);
    if (!match) throw new Error(`Malformed checksum line: ${line}`);
    const [, expected, name] = match;
    const actual = createHash("sha256")
      .update(readFileSync(join(baseDir, name)))
      .digest("hex");
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${name}.`);
    }
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

// The Supabase Postgres image runs its init scripts against a temporary,
// single-user instance and then restarts into the real long-running one.
// A single successful pg_isready can land inside that transient instance,
// moments before it shuts down for the restart, so this requires several
// consecutive successes before declaring the container actually ready.
function waitForPostgres(
  container,
  { retries = 60, delayMs = 1000, consecutiveRequired = 4 } = {},
) {
  return new Promise((resolve, reject) => {
    let consecutive = 0;
    const attempt = (remaining) => {
      const result = spawnSync("docker", [
        "exec",
        container,
        "pg_isready",
        "-U",
        "postgres",
      ]);
      consecutive = result.status === 0 ? consecutive + 1 : 0;
      if (consecutive >= consecutiveRequired) {
        resolve();
        return;
      }
      if (remaining <= 0) {
        reject(new Error("Scratch PostgreSQL container did not become ready in time."));
        return;
      }
      setTimeout(() => attempt(remaining - 1), delayMs);
    };
    attempt(retries);
  });
}

// The Supabase Postgres image bootstraps a handful of its own event
// triggers (PostgREST schema-cache reload, pg_graphql/pg_cron/pg_net access
// hooks) that are not part of the dump's own object graph. `pg_restore
// --clean` computes its DROP order from the archive alone, so it can try to
// drop a function these image-bootstrapped triggers still depend on before
// dropping the trigger itself. Clearing them first — while leaving any
// triggers that truly belong to an installed extension alone, since those
// must be dropped (or left) as a unit with the extension — gives the dump's
// own CREATE statements a clean slate to restore the production definitions
// into.
function dropNonExtensionEventTriggers(container, password) {
  run("docker", [
    "exec",
    "-e",
    `PGPASSWORD=${password}`,
    container,
    "psql",
    "-U",
    "supabase_admin",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `do $$
     declare t record;
     begin
       for t in
         select evt.evtname
         from pg_event_trigger evt
         where not exists (
           select 1
           from pg_depend d
           where d.classid = 'pg_event_trigger'::regclass
             and d.objid = evt.oid
             and d.deptype = 'e'
         )
       loop
         execute format('drop event trigger if exists %I', t.evtname);
       end loop;
     end $$;`,
  ]);
}

function printComparisonTable(sourceEvidence, restoredEvidence) {
  const restoredCounts = new Map(
    restoredEvidence.tables.map((entry) => [
      `${entry.schema}.${entry.table}`,
      entry.row_count,
    ]),
  );
  const rows = [...sourceEvidence.tables].sort((a, b) =>
    `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`),
  );
  const header = "schema.table".padEnd(40) + "source".padStart(10) + "restored".padStart(10) + "  match";
  console.log(`\n${header}`);
  console.log("-".repeat(header.length));
  for (const entry of rows) {
    const key = `${entry.schema}.${entry.table}`;
    const restoredCount = restoredCounts.get(key);
    const match = restoredCount === entry.row_count ? "OK" : "MISMATCH";
    console.log(
      key.padEnd(40) +
        String(entry.row_count).padStart(10) +
        String(restoredCount ?? "MISSING").padStart(10) +
        `  ${match}`,
    );
  }
}

async function main() {
  const artifactDir = requireEnv("RESTORE_ARTIFACT_DIR");
  const identityFile = requireEnv("RESTORE_AGE_IDENTITY_FILE");
  statSync(identityFile); // fail fast with a clear error if missing
  const dockerImage =
    process.env.RESTORE_DOCKER_IMAGE ?? "public.ecr.aws/supabase/postgres:17.6.1.143";
  const keepWorkDir = process.env.RESTORE_KEEP_WORKDIR === "1";

  const encryptedFile = findOne(artifactDir, ".tar.age");
  const manifestFile = findOne(artifactDir, ".manifest.json");
  const checksumsFile = findOne(artifactDir, ".sha256");

  console.log("Verifying artifact checksums...");
  verifyChecksumFile(checksumsFile);

  console.log("Verifying encrypted artifact against the manifest...");
  verifyBackupArtifact({ manifestFile, encryptedFile });

  const workDir = mkdtempSync(join(tmpdir(), "terroir-restore-drill-"));
  chmodSync(workDir, 0o700);
  let containerName = null;

  const cleanup = () => {
    if (containerName && !keepWorkDir) {
      spawnSync("docker", ["stop", "-t", "5", containerName], { stdio: "ignore" });
    }
    if (!keepWorkDir) {
      rmSync(workDir, { recursive: true, force: true });
    } else {
      console.log(`Keeping work directory and container for debugging: ${workDir} (${containerName})`);
    }
  };
  const onSignal = () => {
    cleanup();
    process.exit(1);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const payloadFile = join(workDir, "payload.tar");
    console.log("Decrypting artifact with the offline age identity...");
    run("age", [
      "--decrypt",
      "--identity",
      identityFile,
      "--output",
      payloadFile,
      encryptedFile,
    ]);

    run("tar", ["-C", workDir, "-xf", payloadFile]);
    const dumpFile = findOne(workDir, ".dump");
    const sourceEvidenceFile = join(workDir, "source-evidence.json");
    statSync(sourceEvidenceFile);

    console.log("Verifying decrypted payload, dump, and evidence against the manifest...");
    verifyBackupArtifact({
      manifestFile,
      encryptedFile,
      payloadFile,
      dumpFile,
      evidenceFile: sourceEvidenceFile,
    });

    console.log(`Starting disposable ${dockerImage} scratch database...`);
    assertScratchRestoreTarget("127.0.0.1");
    const port = await getFreePort();
    containerName = `terroir-restore-drill-${process.pid}`;
    const password = randomBytes(24).toString("hex");
    run("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-p",
      `127.0.0.1:${port}:5432`,
      dockerImage,
    ]);
    await waitForPostgres(containerName);
    dropNonExtensionEventTriggers(containerName, password);

    console.log("Restoring dump into the scratch database...");
    run("docker", ["cp", dumpFile, `${containerName}:/tmp/restore.dump`]);
    run(
      "docker",
      [
        "exec",
        "-e",
        `PGPASSWORD=${password}`,
        containerName,
        "pg_restore",
        "--username",
        "supabase_admin",
        "--dbname",
        "postgres",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "/tmp/restore.dump",
      ],
    );

    const serviceFile = join(workDir, "restore.pg_service.conf");
    writeFileSync(
      serviceFile,
      [
        "[terroir_restore_drill]",
        "host=127.0.0.1",
        `port=${port}`,
        "dbname=postgres",
        "user=supabase_admin",
        `password=${password}`,
        "sslmode=disable",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );

    process.env.PGSERVICEFILE = serviceFile;
    process.env.PGSERVICE = "terroir_restore_drill";

    console.log("Collecting restored evidence (exact per-table counts)...");
    const { writeDatabaseEvidence } = await import("./backup/collect-database-evidence.mjs");
    const restoredEvidenceFile = join(workDir, "restored-evidence.json");
    await writeDatabaseEvidence({ file: restoredEvidenceFile });

    const sourceEvidence = JSON.parse(readFileSync(sourceEvidenceFile, "utf8"));
    const restoredEvidence = JSON.parse(readFileSync(restoredEvidenceFile, "utf8"));
    const comparison = compareDatabaseEvidence(sourceEvidence, restoredEvidence);

    const reportFile = process.env.RESTORE_REPORT_FILE ?? join(workDir, "restore-report.json");
    const report = {
      format_version: 1,
      verified_at: new Date().toISOString(),
      artifact_dir: artifactDir,
      ...comparison,
    };
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    printComparisonTable(sourceEvidence, restoredEvidence);
    console.log(`\nReport written to ${reportFile}`);
    console.log(`Result: ${comparison.ok ? "PASS" : "FAIL"}`);
    if (!comparison.ok) {
      for (const failure of comparison.failures) console.error(` - ${failure}`);
      process.exitCode = 1;
    }
  } finally {
    cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
