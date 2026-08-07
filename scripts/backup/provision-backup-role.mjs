import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function sqlLiteral(value) {
  if (/[\0\r\n]/u.test(value)) {
    throw new Error("Backup role password must be single-line.");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export function createBackupRoleSql(password) {
  if (typeof password !== "string" || password.length < 32) {
    throw new Error("BACKUP_ROLE_PASSWORD must be at least 32 characters.");
  }
  return `
do $provision$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'terroir_backup'
  ) then
    create role terroir_backup;
  end if;

  if exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'terroir_backup'
      and rolsuper
  ) then
    raise exception 'terroir_backup must never be a superuser';
  end if;
end
$provision$;

alter role terroir_backup
  with login
       password ${sqlLiteral(password)}
       nocreatedb
       nocreaterole
       inherit
       noreplication
       bypassrls;
grant connect on database postgres to terroir_backup;
grant pg_read_all_data to terroir_backup;
alter role terroir_backup set default_transaction_read_only = on;
alter role terroir_backup set statement_timeout = '10min';
`.trimStart();
}

export function provisionBackupRole({
  password = process.env.BACKUP_ROLE_PASSWORD,
  serviceName = process.env.PGSERVICE ?? "terroir_admin",
} = {}) {
  if (!password) throw new Error("BACKUP_ROLE_PASSWORD is required.");
  const result = spawnSync(
    "psql",
    [
      `service=${serviceName}`,
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      input: createBackupRoleSql(password),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`Backup role provisioning failed: ${result.stderr.trim()}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  provisionBackupRole();
}
