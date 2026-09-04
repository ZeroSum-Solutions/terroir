# Local Supabase Data

Use this for production-like, sanitized local testing. It does **not** use
the prod demo dataset from `docs/DEMO-DATA.md`.

For bringing up the local stack itself — ports, safety model, the canonical
`scripts/local/dev-stack.sh` bring-up command — see
`docs/runbooks/local-stack.md`; that doc is canonical for the stack. This
doc is canonical for the richer seed script's contents and usage only.

## Seed Contents

`pnpm run supabase:seed:local:apply` creates a deterministic restaurant:

- 3 auth users: owner, manager, staff
- 1 restaurant with cellar config
- 250 wines across colors, regions, vintages, formats, pricing, enrichment,
  86'd, manual override, and alert states. The reproducible seed writes no
  direct `hero_image_url` values; surfaces without a resolved corpus image show
  the explicit initials fallback.
- 60 invoice scans with OCR/extraction-like JSON
- 400 inventory rows across sections, formats, low-stock, and zero-stock cases.
  They retain legacy `bin_location` text but are unplaced in the canonical bins
  model, and the seed creates no `bins` rows. Use the production-shaped tenant
  when testing `/bins`.
- 4 wine lists: published BTG, published full list, draft list, archived list
- Wine-list sections/items with prices, blurbs, hidden items, pour tracking,
  and 86 availability states
- 200 pour events, 25 open bottles, and 30 availability/reconcile events
- 10 pending/accepted invite rows

The seed restaurant id is:

```text
de100000-0000-4000-8000-000000000001
```

## Environment

The seed process must receive a local Supabase target with migrations already
applied. A fresh local-only checkout may store these values in `.env.local`.
On a configured machine where `.env.local` holds production credentials, leave
that file untouched and export the values from `supabase status` in the current
shell instead.

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:57321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='replace-with-local-anon-key'
SUPABASE_SERVICE_ROLE_KEY='replace-with-local-service-role-key'
ACTIVE_RESTAURANT_COOKIE_SECRET=redacted
DEV_BYPASS_EMAIL=owner+local@terroir.test

# Strongly recommended safety rail. Set this to the prod project ref or
# another unique substring from the prod Supabase URL.
PROD_SUPABASE_URL_PATTERN=your-prod-project-ref
```

`57321` is this repo's configured local API port (see
`docs/runbooks/local-stack.md` for the full port table and why it isn't the
supabase-cli default `54321`) — `scripts/local/assert-local-db.sh` refuses
any other port.

Use `supabase status` to get the local anon and service-role keys when the
Supabase CLI is running.

## Commands

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

```bash
LOCAL_SEED_USER_PASSWORD=redacted
```

## Smoke Targets

Once seeded, run authenticated checks against:

- `/cellar`
- `/cellar/open`
- `/cellar/reconcile`
- `/lists`
- `/lists/de100005-0000-4000-8000-000000000001`
- `/list/local-seed-by-the-glass`
- `/list/local-seed-full-list`
- `/insights`
- `/price-comparison`
- `/team`

For E2E, set `DEV_BYPASS_EMAIL` and run:

```bash
pnpm test:e2e
```

The Playwright config starts `scripts/local/dev-local.sh` itself and refuses to
reuse an unknown server on port 3000. The complete suite also needs the
production-shaped tenant from `docs/runbooks/prodshape-tenant.md`.
