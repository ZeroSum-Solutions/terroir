import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STAGING_PROJECT_REF = "wwhxcgtcecsftcivosop";
export const STAGING_MIGRATION_CONFIRMATION =
  `MIGRATE-${STAGING_PROJECT_REF}-0084-0086`;

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PREREQUISITES = Object.freeze([
  Object.freeze({
    name: "audited_cellar_quantity_adjustments",
    version: "20260808032000",
  }),
  Object.freeze({
    name: "atomic_wine_metadata_overrides",
    version: "20260808053800",
  }),
  Object.freeze({
    name: "bottle_scan_inventory_provenance",
    version: "20260808053900",
  }),
]);
const PREREQUISITE_NAMES = PREREQUISITES.map(({ name }) => name);
const PREREQUISITE_VERSIONS = PREREQUISITES.map(({ version }) => version);
const MIGRATIONS = Object.freeze([
  Object.freeze({
    acceptanceHash: "4d6637f717d13e4aaa4eb0791285ab79776a230e7994fbdcc9642059f0d6a8d7",
    acceptancePath: "supabase/tests/0084_wine_enrichment_worker_authority.sql",
    id: "0084",
    name: "wine_enrichment_worker_authority",
    sourceHash: "dfbede2ec9c67d64afdf5e0cb261c3c921f8d4e5d6df3572621bb656f5b4c26c",
    sourcePath: "supabase/migrations/0084_wine_enrichment_worker_authority.sql",
    version: "20260808224400",
  }),
  Object.freeze({
    acceptanceHash: "b77d76104ebdee32a23bedb2620559a2a1fd11f4c811c22855314316c58bf2e7",
    acceptancePath: "supabase/tests/0085_market_price_shift_observations.sql",
    id: "0085",
    name: "market_price_shift_observations",
    sourceHash: "9cd78a381a0628ddccd452a6bfe2d4a07e0bb4cb730822974f82584b36913ee9",
    sourcePath: "supabase/migrations/0085_market_price_shift_observations.sql",
    version: "20260808224500",
  }),
  Object.freeze({
    acceptanceHash: "ee4afc7de67fbb8d23d497aa7270250006bd557dec775979d1897eac48e25dba",
    acceptancePath: "supabase/tests/0086_background_job_enqueue_authorization.sql",
    id: "0086",
    name: "background_job_enqueue_authorization",
    sourceHash: "c41a909a61cc4b223ae9d8da4379d9e4c9a538a5ff8febcc2bda551cecde286f",
    sourcePath: "supabase/migrations/0086_background_job_enqueue_authorization.sql",
    version: "20260808224600",
  }),
]);
const TARGET_NAMES = MIGRATIONS.map(({ name }) => name);
export const TARGET_VERSIONS = MIGRATIONS.map(({ version }) => version);
const ENQUEUE_SIGNATURE =
  "public.enqueue_background_job(uuid,text,text,text,uuid,jsonb,integer,timestamp with time zone)";

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlList(values) {
  return values.map(sqlString).join(", ");
}

export function stateQuery() {
  const trackedNames = [...PREREQUISITE_NAMES, ...TARGET_NAMES];
  const trackedVersions = [...PREREQUISITE_VERSIONS, ...TARGET_VERSIONS];
  return `select jsonb_build_object(
  'migrations', coalesce((
    select jsonb_agg(jsonb_build_object(
      'version', version,
      'name', name,
      'source_hash_marker', case
        when array_length(statements, 1) is null then null
        else statements[array_length(statements, 1)]
      end
    ) order by version)
    from supabase_migrations.schema_migrations
    where name in (${sqlList(trackedNames)})
       or version in (${sqlList(trackedVersions)})
  ), '[]'::jsonb),
  'service_role_enrichment',
    has_function_privilege('service_role', 'public.match_lwin(text,text,double precision)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.match_lwin_batch(uuid,uuid[])', 'EXECUTE')
    and has_function_privilege('service_role', 'public.enrich_wines_batch(uuid,jsonb)', 'EXECUTE'),
  'has_market_columns',
    to_regclass('public.wines') is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'wines'
        and column_name = 'retail_previous_median'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'wines'
        and column_name = 'retail_previous_refreshed_at'
    ),
  'has_market_trigger', exists (
    select 1 from pg_trigger
    where tgrelid = 'public.wines'::regclass
      and tgname = 'wines_capture_previous_retail_median'
      and not tgisinternal
  ),
  'enqueue_contract', (
    select case
      when position('p_job_type = ''wine_enrichment''' in function_definition) > 0
       and position('is_member_with_role(p_restaurant_id, ''manager'')' in function_definition) > 0
        then 'manager_wine_enrichment'
      when position('p_job_type = ''wine_enrichment''' in function_definition) = 0
       and position('is_member_with_role(p_restaurant_id, ''staff'')' in function_definition) > 0
        then 'staff_all_jobs'
      else 'unknown'
    end
    from (
      select pg_get_functiondef(${sqlString(ENQUEUE_SIGNATURE)}::regprocedure)
        as function_definition
    ) enqueue_definition
  )
) as state;`;
}

export async function loadManifestFiles() {
  return Promise.all(MIGRATIONS.map(async (migration) => {
    const [source, acceptance] = await Promise.all([
      readFile(path.join(REPOSITORY_ROOT, migration.sourcePath), "utf8"),
      readFile(path.join(REPOSITORY_ROOT, migration.acceptancePath), "utf8"),
    ]);
    if (createHash("sha256").update(source).digest("hex") !== migration.sourceHash) {
      throw new Error(`${migration.sourcePath} does not match the fixed migration manifest.`);
    }
    if (createHash("sha256").update(acceptance).digest("hex") !== migration.acceptanceHash) {
      throw new Error(`${migration.acceptancePath} does not match the fixed migration manifest.`);
    }
    return {
      ...migration,
      acceptance: stripAcceptanceTransaction(acceptance, migration.acceptancePath),
      source,
    };
  }));
}

function stripAcceptanceTransaction(sql, sourcePath) {
  const begin = /(?:^|\n)\s*begin;\s*(?:\n|$)/i.exec(sql);
  const rollback = /(?:^|\n)\s*rollback;\s*$/i.exec(sql);
  const header = begin ? sql.slice(0, begin.index).trim() : "";
  const hasOnlyCommentHeader = header === ""
    || header.split("\n").every((line) => line.trim().startsWith("--"));
  if (!begin || !rollback || rollback.index <= begin.index || !hasOnlyCommentHeader) {
    throw new Error(`${sourcePath} must have one exact outer begin/rollback transaction.`);
  }
  return sql.slice(begin.index + begin[0].length, rollback.index);
}

function dollarQuote(value, tag) {
  const delimiter = `$${tag}$`;
  if (value.includes(delimiter)) {
    throw new Error("A fixed SQL source conflicts with its migration delimiter.");
  }
  return `${delimiter}${value}${delimiter}`;
}

function guardSql() {
  return `do $migration_guard$
declare
  v_prerequisites integer;
  v_prerequisite_names integer;
  v_prerequisite_versions integer;
  v_targets integer;
  v_versions integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('terroir:staging:0084-0086', 0));
  select count(*) into v_prerequisites
  from supabase_migrations.schema_migrations
  where (name, version) in (${PREREQUISITES.map(({ name, version }) =>
    `(${sqlString(name)}, ${sqlString(version)})`).join(", ")});
  select count(*) into v_prerequisite_names
  from supabase_migrations.schema_migrations
  where name in (${sqlList(PREREQUISITE_NAMES)});
  select count(*) into v_prerequisite_versions
  from supabase_migrations.schema_migrations
  where version in (${sqlList(PREREQUISITE_VERSIONS)});
  select count(*) into v_targets
  from supabase_migrations.schema_migrations
  where name in (${sqlList(TARGET_NAMES)});
  select count(*) into v_versions
  from supabase_migrations.schema_migrations
  where version in (${sqlList(TARGET_VERSIONS)});
  if v_prerequisites <> ${PREREQUISITES.length}
     or v_prerequisite_names <> ${PREREQUISITES.length}
     or v_prerequisite_versions <> ${PREREQUISITES.length}
     or v_targets <> 0
     or v_versions <> 0 then
    raise exception 'staging migration history changed after preflight';
  end if;
  if has_function_privilege('service_role', 'public.enrich_wines_batch(uuid,jsonb)', 'EXECUTE')
     or exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'wines'
         and column_name in ('retail_previous_median', 'retail_previous_refreshed_at')
     )
     or position(
       'p_job_type = ''wine_enrichment'''
       in pg_get_functiondef(${sqlString(ENQUEUE_SIGNATURE)}::regprocedure)
     ) > 0
     or position(
       'is_member_with_role(p_restaurant_id, ''staff'')'
       in pg_get_functiondef(${sqlString(ENQUEUE_SIGNATURE)}::regprocedure)
     ) = 0 then
    raise exception 'staging schema changed after preflight';
  end if;
end
$migration_guard$;`;
}

function postconditionSql() {
  return `do $migration_postconditions$
begin
  if not has_function_privilege('service_role', 'public.match_lwin(text,text,double precision)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.match_lwin_batch(uuid,uuid[])', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.enrich_wines_batch(uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.enrich_wines_batch(uuid,jsonb)', 'EXECUTE') then
    raise exception 'wine enrichment privilege postcondition failed';
  end if;
  if not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'wines'
         and column_name = 'retail_previous_median'
     )
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'wines'
         and column_name = 'retail_previous_refreshed_at'
     )
     or not exists (
       select 1 from pg_trigger
       where tgrelid = 'public.wines'::regclass
         and tgname = 'wines_capture_previous_retail_median'
         and not tgisinternal
     ) then
    raise exception 'market observation postcondition failed';
  end if;
  if position(
       'p_job_type = ''wine_enrichment'''
       in pg_get_functiondef(${sqlString(ENQUEUE_SIGNATURE)}::regprocedure)
     ) = 0
     or position(
       'is_member_with_role(p_restaurant_id, ''manager'')'
       in pg_get_functiondef(${sqlString(ENQUEUE_SIGNATURE)}::regprocedure)
     ) = 0 then
    raise exception 'background job authorization postcondition failed';
  end if;
end
$migration_postconditions$;`;
}

export function buildMutationSql(files) {
  const parts = ["begin;", guardSql()];
  for (const migration of files) {
    const savepoint = `ter_${migration.id}_acceptance`;
    parts.push(migration.source.trim());
    parts.push(`savepoint ${savepoint};`);
    parts.push(migration.acceptance.trim());
    parts.push(`rollback to savepoint ${savepoint};`);
    parts.push(`release savepoint ${savepoint};`);
  }
  parts.push(postconditionSql());
  for (const migration of files) {
    parts.push(`insert into supabase_migrations.schema_migrations (
  version, statements, name
) values (
  ${sqlString(migration.version)},
  array[
    ${dollarQuote(migration.source, `terroir_${migration.id}`)}::text,
    ${sqlString(`sha256:${migration.sourceHash}`)}
  ],
  ${sqlString(migration.name)}
);`);
  }
  parts.push("commit;");
  return `${parts.join("\n\n")}\n`;
}

export function normalizeState(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.result;
  const value = rows?.[0]?.state;
  const state = typeof value === "string" ? JSON.parse(value) : value;
  if (!state || !Array.isArray(state.migrations)) {
    throw new Error("Supabase returned an invalid migration-state response.");
  }
  return state;
}

export function classifyState(state) {
  for (const prerequisite of PREREQUISITES) {
    const nameMatches = state.migrations.filter(
      (migration) => migration.name === prerequisite.name,
    );
    const versionMatches = state.migrations.filter(
      (migration) => migration.version === prerequisite.version,
    );
    if (nameMatches.length !== 1
      || versionMatches.length !== 1
      || nameMatches[0].version !== prerequisite.version
      || versionMatches[0].name !== prerequisite.name) {
      throw new Error(
        `Required staging prerequisite ${prerequisite.name} is missing, duplicated, or version-drifted.`,
      );
    }
  }
  if (state.migrations.some((migration) =>
    TARGET_VERSIONS.includes(migration.version) && !TARGET_NAMES.includes(migration.name))) {
    throw new Error("A fixed staging migration version is already in use.");
  }
  const targets = state.migrations.filter(({ name }) => TARGET_NAMES.includes(name));
  if (targets.length === 0) {
    if (state.service_role_enrichment !== false
      || state.has_market_columns !== false
      || state.has_market_trigger !== false
      || state.enqueue_contract !== "staff_all_jobs") {
      throw new Error("Staging schema and migration history disagree before apply.");
    }
    return "pending";
  }
  if (targets.length !== MIGRATIONS.length) {
    throw new Error("The fixed staging migration set is only partially recorded.");
  }
  for (const migration of MIGRATIONS) {
    const matches = targets.filter(({ name }) => name === migration.name);
    if (matches.length !== 1
      || matches[0].version !== migration.version
      || matches[0].source_hash_marker !== `sha256:${migration.sourceHash}`) {
      throw new Error(`Recorded staging migration ${migration.name} does not match its manifest.`);
    }
  }
  if (state.service_role_enrichment !== true
    || state.has_market_columns !== true
    || state.has_market_trigger !== true
    || state.enqueue_contract !== "manager_wine_enrichment") {
    throw new Error("Applied staging migration history does not match schema postconditions.");
  }
  return "applied";
}
