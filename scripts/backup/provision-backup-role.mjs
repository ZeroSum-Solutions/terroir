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

do $cleanup$
declare
  membership record;
  target_relation record;
  target_schema record;
begin
  for membership in
    select granted_role.rolname
    from pg_catalog.pg_auth_members member
    join pg_catalog.pg_roles granted_role
      on granted_role.oid = member.roleid
    join pg_catalog.pg_roles member_role
      on member_role.oid = member.member
    where member_role.rolname = 'terroir_backup'
      and granted_role.rolname <> 'pg_read_all_data'
  loop
    execute format(
      'revoke %I from terroir_backup',
      membership.rolname
    );
  end loop;

  for target_schema in
    select distinct n.nspname
    from pg_catalog.pg_namespace n
    cross join lateral pg_catalog.aclexplode(n.nspacl) acl
    where acl.grantee = (
      select oid from pg_catalog.pg_roles where rolname = 'terroir_backup'
    )
  loop
    execute format(
      'revoke all privileges on schema %I from terroir_backup',
      target_schema.nspname
    );
  end loop;

  for target_relation in
    select distinct n.nspname, c.relname, c.relkind
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(c.relacl) acl
    where acl.grantee = (
      select oid from pg_catalog.pg_roles where rolname = 'terroir_backup'
    )
      and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  loop
    execute format(
      'revoke all privileges on %s %I.%I from terroir_backup',
      case when target_relation.relkind = 'S' then 'sequence' else 'table' end,
      target_relation.nspname,
      target_relation.relname
    );
  end loop;
end
$cleanup$;

revoke all privileges on database postgres from terroir_backup;
grant connect on database postgres to terroir_backup;
grant pg_read_all_data to terroir_backup;
alter role terroir_backup set default_transaction_read_only = on;
alter role terroir_backup set statement_timeout = '15min';

do $verify_cleanup$
begin
  if exists (
    select 1
    from pg_catalog.pg_auth_members member
    join pg_catalog.pg_roles granted_role
      on granted_role.oid = member.roleid
    join pg_catalog.pg_roles member_role
      on member_role.oid = member.member
    where member_role.rolname = 'terroir_backup'
      and granted_role.rolname <> 'pg_read_all_data'
  ) then
    raise exception 'terroir_backup retains an unexpected role membership';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_class c
    cross join lateral pg_catalog.aclexplode(c.relacl) acl
    where acl.grantee = (
      select oid from pg_catalog.pg_roles where rolname = 'terroir_backup'
    )
  ) then
    raise exception 'terroir_backup retains direct relation privileges';
  end if;
end
$verify_cleanup$;
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
