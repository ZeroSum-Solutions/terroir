# Applying migrations to production

**Why this file exists.** On 2026-08-29 production was found sitting at `0111` while
the repo was at `0136` — ten unapplied migrations, including a HIGH-severity RLS fix.
Nothing was broken: there was simply no documented procedure, no gate, and nothing that
would ever have said so out loud. This is that procedure.

## The thing to understand first

**Railway deploys `main`. Nothing deploys migrations.** `railway.toml` sets
`startCommand = "pnpm start"` and that is the whole deploy. A merge to `main` ships
application code to *both* the `production` and `staging` Railway environments at the
same SHA — see `.github/workflows/staging-smoke.yml` — and touches the database not at
all.

**There is one Supabase project.** `terroir` / `qcfmwphlaekfkqwkfyth`, in the
`Zerosumsolutions-Projects` org. Railway production and staging both point at it, so
there is no database-level staging and no rehearsal environment. The local stack
(`docs/runbooks/local-stack.md`) is the only rehearsal you get.

That combination is why migrations must be applied **before** the code that depends on
them lands, and why every migration has to be safe to run against a database the old
code is still talking to.

## Procedure

### 1. Find the gap

```bash
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
DB_URL=$(zsvault get terroir_supabase_admin_db_url)
psql "$DB_URL" -Atc "select max(version) from supabase_migrations.schema_migrations;"
ls supabase/migrations/*.sql | tail -1
```

Do not trust the max version alone — confirm with an object probe, because a migration
can be recorded without its effects surviving, and effects can exist without a record
(see *Drift* below):

```bash
psql "$DB_URL" -Atc "select proname from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and proname in ('<a function your top migration adds>');"
```

### 2. Check there is a restore point

```bash
curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/qcfmwphlaekfkqwkfyth/database/backups" \
  | jq -c '{pitr: .pitr_enabled, walg: .walg_enabled, latest: .backups[0].inserted_at}'
```

PITR is **off**; WAL-G daily physical backups are on. Your worst case is losing a day.
If the latest backup is stale relative to the risk you are about to take, stop and take
one first.

### 3. Dry-run against production, in a transaction you roll back

This is the step that matters, and it is not optional. Local data does not look like
production data — that is exactly how `0135` passed review, passed CI, and then failed
on the real table.

```bash
psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
begin;
\i supabase/migrations/0135_identity_resolution_on_write.sql
rollback;
SQL
```

A migration that cannot survive this cannot be applied, and — because a restore drill
replays `0001..N` in order over restored data — it also cannot be *replayed*. Fix the
migration, not the invocation.

### 4. Apply, one transaction per migration, recording as you go

Each migration and its `schema_migrations` row go in **one** transaction, so a failure
leaves no half-state and no false record. Stop at the first failure.

```bash
for n in 0127 0128 0129; do
  f=$(ls supabase/migrations/${n}_*.sql)
  name=$(basename "$f" .sql); name=${name#${n}_}
  [ "$(psql "$DB_URL" -Atc "select 1 from supabase_migrations.schema_migrations where version='${n}';")" = "1" ] \
    && { echo "SKIP $n"; continue; }
  psql "$DB_URL" -v ON_ERROR_STOP=1 --single-transaction -q \
    -f "$f" \
    -c "insert into supabase_migrations.schema_migrations(version,name) values ('${n}','${name}');" \
    || { echo "FAIL $n — rolled back"; break; }
done
```

Note `--single-transaction` will not protect a migration containing
`CREATE INDEX CONCURRENTLY`. Check for it first; none exist as of `0136`.

### 5. Verify the effect, not the record

Assert the thing the migration was for. A `schema_migrations` row proves only that an
insert ran.

```bash
psql "$DB_URL" -Atc "select polname,
    pg_get_expr(polwithcheck, polrelid) ilike '%exists%' as has_ownership_check
  from pg_policy
  where polrelid in ('public.stock_adjustments'::regclass,'public.bottle_closeouts'::regclass)
    and polcmd = 'a';"
curl -s https://terroir-web-staging.up.railway.app/api/health
```

## Drift

Production can contain objects no migration created — made by hand in the dashboard,
usually to unblock something. `0130` hit exactly this: its bucket and all three storage
policies already existed, so the migration failed on `policy ... already exists`.

Do not force it and do not skip it. Compare the live object against what the migration
declares:

```bash
psql "$DB_URL" -Atc "select polname, polcmd,
    pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)
  from pg_policy where polrelid = 'storage.objects'::regclass order by polname;"
```

Then apply only the genuine difference and record the version. Anything you leave
different is drift you now owe a follow-up migration for — record it in the plan rather
than in your memory.

**Known open drift as of 2026-08-29:** production's `wine-images` bucket allows
`image/heic` and `image/heif`; `0130` declares only jpeg/png/webp. A fresh environment
built from migrations will therefore reject HEIC uploads that production accepts.

## What would have caught this earlier

Nothing did, and nothing yet does. CI verifies migrations against a *local* Postgres;
no gate compares the repo's ceiling to production's. Until one exists, run step 1 as
part of any release that includes a migration.
