import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { quoteIdentifier } from "./collect-database-evidence.mjs";

export function createRestorePreparationSql(evidence) {
  if (evidence?.format_version !== 1 || !Array.isArray(evidence.tables)) {
    throw new Error("Source evidence has an unsupported table inventory.");
  }

  const relations = evidence.tables.map(({ schema, table }) => {
    if (
      typeof schema !== "string" ||
      schema.length === 0 ||
      typeof table !== "string" ||
      table.length === 0 ||
      schema.includes("\0") ||
      table.includes("\0")
    ) {
      throw new Error("Source evidence contains an invalid table identifier.");
    }
    return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  });

  if (relations.length === 0 || new Set(relations).size !== relations.length) {
    throw new Error("Source evidence table inventory must be non-empty and unique.");
  }

  const hasMigrationMetadata = evidence.tables.some(
    ({ schema, table }) =>
      schema === "supabase_migrations" && table === "schema_migrations",
  );
  const compatibilitySql = hasMigrationMetadata
    ? `alter table "supabase_migrations"."schema_migrations"
  add column if not exists "created_by" text,
  add column if not exists "idempotency_key" text,
  add column if not exists "rollback" text[];
do $compatibility$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and (
        (column_name in ('created_by', 'idempotency_key') and data_type <> 'text')
        or (column_name = 'rollback' and udt_name <> '_text')
      )
  ) then
    raise exception 'Supabase migration metadata columns have incompatible types';
  end if;
end
$compatibility$;
`
    : "";

  return `begin;\n${compatibilitySql}truncate table ${relations.join(", ")} restart identity cascade;\ncommit;\n`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const evidenceFile = process.env.BACKUP_SOURCE_EVIDENCE_FILE;
  if (!evidenceFile) {
    throw new Error("BACKUP_SOURCE_EVIDENCE_FILE is required.");
  }
  process.stdout.write(
    createRestorePreparationSql(
      JSON.parse(await readFile(evidenceFile, "utf8")),
    ),
  );
}
