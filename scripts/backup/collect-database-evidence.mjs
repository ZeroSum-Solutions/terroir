import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SERVICE_NAME = process.env.PGSERVICE ?? "terroir_backup";
const SNAPSHOT_ID = process.env.BACKUP_SNAPSHOT_ID;

export function snapshotSql(sql, snapshotId = SNAPSHOT_ID) {
  if (!snapshotId) return sql;
  if (!/^[0-9A-Fa-f-]+$/u.test(snapshotId)) {
    throw new Error("BACKUP_SNAPSHOT_ID has an invalid format.");
  }
  return `begin isolation level repeatable read read only;
set transaction snapshot '${snapshotId}';
${sql};
commit`;
}

export function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function parseSequenceState(state, schema, sequence) {
  const [lastValue, isCalled] = state.split("\t");
  if (
    !/^-?\d+$/u.test(lastValue) ||
    !["true", "false"].includes(isCalled)
  ) {
    throw new Error(`Invalid sequence state for ${schema}.${sequence}.`);
  }
  return {
    schema,
    sequence,
    last_value: lastValue,
    is_called: isCalled === "true",
  };
}

function psql(sql) {
  const result = spawnSync(
    "psql",
    [
      `service=${SERVICE_NAME}`,
      "-X",
      "-A",
      "-t",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      snapshotSql(sql),
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `Database evidence query failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

export function parseTableInventory(output) {
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [schema, table, relkind] = line.split("\t");
    if (!schema || !table || !["r", "p"].includes(relkind)) {
      throw new Error("Database table inventory returned a malformed row.");
    }
    return {
      schema,
      table,
      kind: relkind === "p" ? "partitioned" : "table",
    };
  });
}

function listTables() {
  const output = psql(
    `select n.nspname || E'\\t' || c.relname || E'\\t' || c.relkind::text
     from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and n.nspname <> 'information_schema'
       and n.nspname !~ '^pg_'
       and not exists (
         select 1
         from pg_catalog.pg_depend d
         where d.classid = 'pg_catalog.pg_class'::regclass
           and d.objid = c.oid
           and d.deptype = 'e'
       )
     order by n.nspname collate "C", c.relname collate "C"`,
  );
  return parseTableInventory(output);
}

function exactRowCount({ schema, table }) {
  const relation = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const output = psql(`select count(*)::text from ${relation}`);
  const count = Number(output);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid row count for ${schema}.${table}.`);
  }
  return count;
}

function deterministicChecksum({ schema, table }) {
  const relation = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const child = spawn(
    "psql",
    [
      `service=${SERVICE_NAME}`,
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      snapshotSql(`copy (
         select pg_catalog.to_jsonb(row_value)::text
         from ${relation} as row_value
         order by pg_catalog.to_jsonb(row_value)::text collate "C"
       ) to stdout`),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const hash = createHash("sha256");
  const stderr = [];
  child.stdout.on("data", (chunk) => hash.update(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Checksum query failed for ${schema}.${table}: ${Buffer.concat(
              stderr,
            )
              .toString("utf8")
              .trim()}`,
          ),
        );
        return;
      }
      resolve(hash.digest("hex"));
    });
  });
}

function migrationVersion() {
  const relation = "supabase_migrations.schema_migrations";
  const exists = psql(
    `select pg_catalog.to_regclass('${relation}') is not null`,
  );
  if (exists !== "t") return null;
  return (
    psql(
      `select version::text
       from ${relation}
       order by version::text desc
       limit 1`,
    ) || null
  );
}

function listSequences() {
  const output = psql(
    `select n.nspname || E'\\t' || c.relname
     from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'S'
       and n.nspname <> 'information_schema'
       and n.nspname !~ '^pg_'
       and not exists (
         select 1
         from pg_catalog.pg_depend d
         where d.classid = 'pg_catalog.pg_class'::regclass
           and d.objid = c.oid
           and d.deptype = 'e'
       )
     order by n.nspname collate "C", c.relname collate "C"`,
  );
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [schema, sequence] = line.split("\t");
    if (!schema || !sequence) {
      throw new Error("Database sequence inventory returned a malformed row.");
    }
    const relation = `${quoteIdentifier(schema)}.${quoteIdentifier(sequence)}`;
    const state = psql(
      `select last_value::text || E'\\t' || is_called::text from ${relation}`,
    );
    return parseSequenceState(state, schema, sequence);
  });
}

function tableKey({ schema, table }) {
  return `${schema}\0${table}`;
}

function largestNonEmptyTables(tables) {
  return tables
    .filter(({ row_count }) => row_count > 0)
    .sort(
      (left, right) =>
        right.row_count - left.row_count ||
        lexicalCompare(
          `${left.schema}.${left.table}`,
          `${right.schema}.${right.table}`,
        ),
    )
    .slice(0, 10);
}

export function selectChecksumTables(tables, checksumSource) {
  if (checksumSource === undefined) return largestNonEmptyTables(tables);
  if (
    checksumSource?.format_version !== 1 ||
    !Array.isArray(checksumSource.tables) ||
    !Array.isArray(checksumSource.largest_non_empty_tables)
  ) {
    throw new Error("Checksum source evidence has an unsupported format.");
  }

  const required = Math.min(
    10,
    checksumSource.tables.filter(({ row_count }) => row_count > 0).length,
  );
  if (checksumSource.largest_non_empty_tables.length !== required) {
    throw new Error(
      `Checksum source evidence contains ${checksumSource.largest_non_empty_tables.length} of ${required} required tables.`,
    );
  }

  const restoredTables = new Map(tables.map((entry) => [tableKey(entry), entry]));
  const selected = [];
  const observed = new Set();
  for (const sourceEntry of checksumSource.largest_non_empty_tables) {
    if (
      typeof sourceEntry.schema !== "string" ||
      typeof sourceEntry.table !== "string"
    ) {
      throw new Error("Checksum source evidence contains an invalid table.");
    }
    const key = tableKey(sourceEntry);
    if (observed.has(key)) {
      throw new Error("Checksum source evidence contains a duplicate table.");
    }
    observed.add(key);
    const restored = restoredTables.get(key);
    if (!restored) {
      throw new Error(
        `Checksum source table is missing after restore: ${sourceEntry.schema}.${sourceEntry.table}.`,
      );
    }
    selected.push(restored);
  }
  return selected;
}

export async function collectDatabaseEvidence({ checksumSource } = {}) {
  const tables = listTables().map((entry) => ({
    ...entry,
    row_count: exactRowCount(entry),
  }));
  const largest = selectChecksumTables(tables, checksumSource);
  const checksummed = [];
  for (const entry of largest) {
    checksummed.push({
      ...entry,
      sha256: await deterministicChecksum(entry),
    });
  }

  return {
    format_version: 1,
    migration_version: migrationVersion(),
    included_schemas: [
      ...new Set(tables.map(({ schema }) => schema)),
    ],
    tables,
    sequences: listSequences(),
    largest_non_empty_tables: checksummed,
  };
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function writeDatabaseEvidence({
  file = process.env.BACKUP_EVIDENCE_FILE,
  checksumSourceFile = process.env.BACKUP_CHECKSUM_SOURCE_FILE,
} = {}) {
  if (!file) throw new Error("BACKUP_EVIDENCE_FILE is required.");
  const checksumSource = checksumSourceFile
    ? JSON.parse(readFileSync(checksumSourceFile, "utf8"))
    : undefined;
  writeFileSync(
    file,
    `${JSON.stringify(await collectDatabaseEvidence({ checksumSource }), null, 2)}\n`,
    "utf8",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await writeDatabaseEvidence();
}
