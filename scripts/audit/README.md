# Audit-verification stack

An ISOLATED local Postgres/Supabase stack for audit-verification agents to
share, built in this scratch worktree (`terroir-vw-audit`). It is entirely
separate from the other local Supabase stacks on this machine and from any
hosted/production Supabase project.

**This stack is disposable.** Recreate it any time with:

```bash
supabase db reset            # re-applies all 71 migrations, from this worktree
node scripts/audit/seed-two-tenants.mjs   # idempotent — safe to re-run
```

## Ports (project_id `terroir-audit-local`, block 583xx)

| Service              | Port  |
|----------------------|-------|
| API (Kong)           | 58321 |
| DB (Postgres)        | 58322 |
| DB shadow            | 58320 |
| DB pooler            | 58329 |
| Studio               | 58323 |
| Inbucket / Mailpit   | 58324 |
| Analytics            | 58327 |
| Edge runtime inspect | 58330 |

Other local stacks on this machine use 543xx, 553xx, 563xx, and 573xx —
none of those ports are touched by this stack, and `supabase start` /
`supabase stop` / `supabase db reset` run from *this* worktree only ever
affect containers named `*_terroir-audit-local`.

Config lives at `supabase/config.toml`. Local dev keys/URLs are in
`.env.local` (gitignored, well-known supabase-cli local defaults — not
production secrets).

## scripts/audit/psql.sh

Runs `psql` against this stack's Postgres (127.0.0.1:58322, superuser
`postgres`/`postgres`), passing all arguments through:

```bash
scripts/audit/psql.sh -c "select count(*) from public.wines;"
scripts/audit/psql.sh <<'SQL'
select id, name, restaurant_id from public.wines;
SQL
```

## scripts/audit/as-tenant.sh

Performs a PostgREST request against `http://127.0.0.1:58321` **as** a
given seeded tenant user. It mints a real session for that user via the
GoTrue admin `generate_link` (magiclink) + `verify` flow — the same
technique `src/app/api/dev-login/route.ts` uses — then sends the resulting
access token as `Authorization: Bearer <jwt>` plus the local anon `apikey`
header. Requires `jq`.

```bash
scripts/audit/as-tenant.sh ownerA@audit.test \
  "http://127.0.0.1:58321/rest/v1/restaurants?select=*"

scripts/audit/as-tenant.sh ownerB@audit.test \
  "http://127.0.0.1:58321/rest/v1/wines?select=id,name,restaurant_id"
```

Trailing arguments pass straight through to `curl` (e.g. `-i`, `-w`, extra
headers).

## scripts/audit/seed-two-tenants.mjs

Idempotent two-tenant seed (creates via the real signup path —
`handle_new_user()` in `supabase/migrations/0001_auth_boundary.sql` — so
each owner gets their own restaurant + owner membership automatically).
Re-running it is safe; every write is check-then-create.

- **Tenant A** — `ownerA@audit.test` / restaurant "Alpha Cellars":
  - 4 wines: one with `lwin_id` NULL, one published on a wine list (list +
    section + item — exercises the anon public-read path), one with an
    `inventory_items` row, one with a **closed** `open_bottles` row
    (`closed_at` set) for bottle-lifecycle material.
- **Tenant B** — `ownerB@audit.test` / restaurant "Beta Bar":
  - 1 wine, 1 wine list with 1 section (a target for cross-tenant linkage
    attempts).

Run it with `node scripts/audit/seed-two-tenants.mjs`. It prints the full
ID map to stdout and writes it to `scripts/audit/tenant-ids.json`:

```json
{
  "userA": "...",                 // ownerA@audit.test auth.users.id
  "userB": "...",                 // ownerB@audit.test auth.users.id
  "restaurantA": "...",           // Alpha Cellars restaurants.id
  "restaurantB": "...",           // Beta Bar restaurants.id
  "wineA_ids": ["...", "...", "...", "..."],  // all 4 tenant-A wines
  "wineA_published_id": "...",    // the wine on the published list/section/item
  "wineA_noLwin_id": "...",       // the wine with lwin_id NULL
  "wineA_inventory_id": "...",    // the wine with an inventory_items row
  "listA_id": "...",
  "sectionA_id": "...",
  "itemA_id": "...",
  "inventoryA_id": "...",         // the inventory_items.id
  "openBottleA_id": "...",        // the closed open_bottles.id
  "openBottleA_wine_id": "...",   // its wine_id
  "wineB_id": "...",
  "listB_id": "...",
  "sectionB_id": "..."            // tenant B's section — target for cross-tenant attempts
}
```

## RLS baseline (verified)

Tenant B cannot read tenant A's data through PostgREST:
`as-tenant.sh ownerB@audit.test ".../rest/v1/wines?select=*"` returns only
Beta Bar's own wine; a direct lookup of Alpha Cellars' restaurant by id
returns an empty array (RLS-filtered, not an error). If a future seed or
schema change makes tenant B's queries return tenant A rows, that is a
critical finding — the whole tenancy model would be broken.
