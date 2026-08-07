# Local Supabase Data

Use this for production-like, sanitized local testing. It does **not** use
the prod demo dataset from [DEMO-DATA.md](DEMO-DATA.md).

## Seed Contents

`pnpm run supabase:seed:local:apply` creates a deterministic restaurant:

- 3 auth users: owner, manager, staff
- 1 restaurant with cellar config
- 250 wines across colors, regions, vintages, formats, pricing, enrichment,
  86'd, manual override, and alert states
- 60 invoice scans with OCR-like extraction JSON
- 400 inventory rows across sections, bins, formats, low-stock, and zero-stock
  cases
- 4 wine lists: published BTG, published full list, draft list, archived list
- Wine-list sections and items with prices, blurbs, hidden items, pour
  tracking, and 86 availability states
- 200 pour events, 25 open bottles, and 30 availability and reconcile events
- 10 pending and accepted invite rows

The seed restaurant id is:

```text
de100000-0000-4000-8000-000000000001
```

## Environment

Set `.env.local` to a local Supabase target with migrations already applied:

```text
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local anon key>
SUPABASE_SERVICE_ROLE_KEY=<local service role key>
ACTIVE_RESTAURANT_COOKIE_SECRET=<at least 16 random chars>
DEV_BYPASS_EMAIL=owner+local@terroir.test

# Strongly recommended safety rail. Set this to the prod project ref or
# another unique substring from the prod Supabase URL.
PROD_SUPABASE_URL_PATTERN=qcfmwphlaekfkqwkfyth
```

Use `supabase status` to get the local anon and service-role keys when the
Supabase CLI is running.

## Commands

### Migration baseline

Before resetting a local database, verify the migration baseline:

```bash
pnpm run downs:check
```

Every forward migration must use the `NNNN_<name>.sql` filename pattern, have
a unique version, and have the paired down migration required by the check.

To recreate the local database from that baseline:

```bash
supabase db reset
```

Dry run:

```bash
pnpm run supabase:seed:local
```

Apply:

```bash
pnpm run supabase:seed:local:apply
```

Teardown:

```bash
pnpm run supabase:seed:local:teardown
```

The write commands refuse non-local Supabase URLs by default. For an approved
staging Supabase only, set:

```bash
ALLOW_NON_LOCAL_SUPABASE_SEED=yes
```

Production is still blocked when `PROD_SUPABASE_URL_PATTERN` matches the target
URL unless `ALLOW_PROD_SEED=yes` is set. Do not set that for this local seed.

## Login

After seeding, use dev login:

```bash
DEV_BYPASS_EMAIL=owner+local@terroir.test
```

Other seeded users:

```text
manager+local@terroir.test
staff+local@terroir.test
```

All are created with this local-only password:

```text
Terroir-local-123!
```

The password can be overridden with:

```text
LOCAL_SEED_USER_PASSWORD=<new local password>
```

## Smoke Targets

Once seeded, run authenticated checks against:

- [cellar](http://127.0.0.1:3000/cellar)
- [open cellar](http://127.0.0.1:3000/cellar/open)
- [reconcile cellar](http://127.0.0.1:3000/cellar/reconcile)
- [wine lists](http://127.0.0.1:3000/lists)
- [seeded wine list](http://127.0.0.1:3000/lists/de100005-0000-4000-8000-000000000001)
- [by-the-glass list](http://127.0.0.1:3000/list/local-seed-by-the-glass)
- [full list](http://127.0.0.1:3000/list/local-seed-full-list)
- [insights](http://127.0.0.1:3000/insights)
- [price comparison](http://127.0.0.1:3000/price-comparison)
- [team](http://127.0.0.1:3000/team)

For E2E, set `DEV_BYPASS_EMAIL` and run:

```bash
pnpm exec playwright test e2e/pour-flow.test.ts
```
