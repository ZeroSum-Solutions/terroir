# Local Supabase Stack

Fully local, Docker-backed Supabase stack for this worktree. Nothing here
ever talks to hosted Supabase — see "Safety model" below.

## Bring-up

```bash
scripts/local/dev-stack.sh
```

Idempotent — safe to re-run. It will:

1. Create `.env.local` from `.env.local.example` if missing.
2. Refuse to continue if the configured Supabase URL isn't local
   (`scripts/local/assert-local-db.sh`).
3. `supabase start` (no-op if already running).
4. `supabase db reset` — drops and recreates the local DB, applying every
   migration in `supabase/migrations/` from scratch.
5. Seed the dev-login bypass user (`scripts/local/seed-local.mjs`).
6. Print connection info and next steps.

Then boot the app against it:

```bash
pnpm dev -p 3000
curl -i http://localhost:3000/api/dev-login   # expect a 30x + session cookies
```

## Teardown

```bash
supabase stop
```

Data lives in a Docker volume and survives `supabase stop` / `supabase
start` cycles. To wipe it, run `supabase db reset` again (or `supabase stop
--no-backup` to drop the volume entirely).

## Ports

This repo's `supabase/config.toml` uses `project_id = "terroir-vw-local"`
and a `573xx` port block instead of the supabase-cli defaults (`543xx`),
because other local Supabase stacks for sibling worktrees/projects on this
machine already occupy `543xx`, `553xx`, and `563xx`. If you see a port
conflict, check `docker ps` for other `supabase_*` containers before
assuming this stack is broken.

| Service          | Port  |
|------------------|-------|
| API (Kong)       | 57321 |
| Postgres         | 57322 |
| Studio           | 57323 |
| Inbucket/Mailpit | 57324 |
| Analytics        | 57327 |
| DB pooler        | 57329 |
| DB shadow (diff) | 57320 |

## Seed data

`scripts/local/seed-local.mjs` is intentionally minimal: it ensures the
dev-login user (`DEV_BYPASS_EMAIL`, default `devlocal@terroir.test`) exists
and has a restaurant + owner membership, via the existing
`handle_new_user()` signup trigger
(`supabase/migrations/0001_auth_boundary.sql`). That's enough for
`/api/dev-login` to land in a working, empty venue. It's safe to re-run —
it no-ops if the user and membership already exist.

For a richer dataset (250 wines, invoice scans, inventory, wine lists, pour
history, etc.) for manual QA or demo purposes, see `docs/LOCAL-SUPABASE.md`
and run `pnpm run supabase:seed:local:apply` afterward — that script seeds
its own set of users (`owner+local@terroir.test` etc.) against the
deterministic restaurant id documented there. The two seeds are
independent and can both be applied to the same local DB.

## Safety model

- Nothing in `scripts/local/` can reach the hosted production Supabase
  project.
- `scripts/local/assert-local-db.sh` is a hard gate: it reads
  `NEXT_PUBLIC_SUPABASE_URL` (env, falling back to `.env.local`) and exits
  non-zero unless it matches exactly THIS repo's local API endpoint —
  `127.0.0.1`/`localhost` on the port `supabase/config.toml`'s `[api]`
  section declares (`57321`). It deliberately does not accept "any"
  localhost port, because other local Supabase stacks for sibling
  worktrees/projects on this machine occupy their own `543xx`/`553xx`/
  `563xx` port blocks. Every script that mutates the local DB sources it
  first — see `scripts/local/assert-local-db.test.sh` for the probe matrix.
- `scripts/seed-local-supabase.mjs` (the richer demo seed, run via `pnpm run
  supabase:seed:local:apply`) requires `NEXT_PUBLIC_SUPABASE_URL` to be set
  explicitly — no hardcoded fallback — and runs the same
  `assert-local-db.sh` gate before any write.
- `.env.local` is gitignored and is created fresh per-worktree — it is
  never copied from another checkout. `.env.local.example` commits the
  well-known local supabase-cli default keys (anon/publishable +
  service-role), which are public constants for local dev, not secrets.
- Local-only CLI operations: `supabase init | start | stop | status | db
  reset`. Never `supabase db push` or `supabase link` from these scripts —
  those talk to a hosted project and are out of scope for anything under
  `scripts/local/`.
- `scripts/backup/*` and `scripts/restore-drill.mjs` are NOT wired to this
  local stack — they hard-require the supabase-cli default DB port
  (`54322`) and fail closed against this repo's `57322` port, so backup/
  restore drills against this stack aren't currently possible. That's safe
  (they refuse rather than run against the wrong database) but means those
  drills need separate follow-up if this local stack is meant to exercise
  them.
