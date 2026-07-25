import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SERVICE_NAME = process.env.PGSERVICE ?? "terroir_backup";
const SNAPSHOT_ID = process.env.BACKUP_SNAPSHOT_ID;

function snapshotSql(sql) {
  if (!SNAPSHOT_ID) return sql;
  if (!/^[0-9A-Fa-f-]+$/u.test(SNAPSHOT_ID)) {
    throw new Error("BACKUP_SNAPSHOT_ID has an invalid format.");
  }
  return `begin isolation level repeatable read read only;
set transaction snapshot '${SNAPSHOT_ID}';
${sql};
commit`;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed while checking dump coverage: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

export function parseArchiveSchemas(listing) {
  // PostgreSQL creates public with the database and pg_dump intentionally
  // omits a standalone SCHEMA entry for it.
  const schemas = new Set(["public"]);
  for (const line of listing.split("\n")) {
    const match = line.match(
      /^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+(\S+)\s+\S+\s*$/u,
    );
    if (match) schemas.add(match[1]);
  }
  return schemas;
}

function sourceSchemas() {
  const output = run("psql", [
    `service=${SERVICE_NAME}`,
    "-X",
    "-A",
    "-t",
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    snapshotSql(`select n.nspname
     from pg_catalog.pg_namespace n
     where n.nspname <> 'information_schema'
       and n.nspname !~ '^pg_'
       and not exists (
         select 1
         from pg_catalog.pg_extension e
         where e.extnamespace = n.oid
       )
       and not exists (
         select 1
         from pg_catalog.pg_depend d
         where d.classid = 'pg_catalog.pg_namespace'::regclass
           and d.objid = n.oid
           and d.deptype = 'e'
       )
     order by n.nspname collate "C"`),
  ]);
  return output
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function assertSchemaCoverage({ source, archive }) {
  const missing = source.filter((schema) => !archive.has(schema));
  if (missing.length > 0) {
    throw new Error(
      `Database dump omitted non-system schemas: ${missing.join(", ")}`,
    );
  }
}

export function assertDumpCoverage({
  dumpFile = process.env.BACKUP_DUMP_FILE,
} = {}) {
  if (!dumpFile) throw new Error("BACKUP_DUMP_FILE is required.");
  const listing = run("pg_restore", ["--list", dumpFile]);
  assertSchemaCoverage({
    source: sourceSchemas(),
    archive: parseArchiveSchemas(listing),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assertDumpCoverage();
}
