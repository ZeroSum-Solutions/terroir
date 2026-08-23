# P0 Local Stack — Round 2 Verification

Unsandboxed re-verification of the P0 local-Supabase-stack fixes, run directly
in the worktree (`/Users/zero/projects/terroir-vw`, branch
`feat/visual-wine-prototype`) against Docker/OrbStack and the real local
Supabase CLI (`supabase 2.109.1`). All commands below were actually executed;
outputs are trimmed for length where noted but not altered otherwise. No
value below is a real secret — the anon/service-role keys and JWT secret
shown are the well-known `supabase-cli` local-dev defaults (see
`.env.local.example`'s own header comment), and are redacted anyway per the
verification instructions.

Three OTHER local Supabase stacks were confirmed running on this machine
throughout this session (`docker ps`), on their own port blocks:
`mobile-demo-production-readiness` (543xx), `g1-8` (553xx), `g1-4` (563xx).
This repo's stack (`terroir-vw-local`) runs on 573xx. This is exactly the
scenario the fix list's BLOCKER (item 1) is about.

---

## 1. `scripts/local/assert-local-db.sh` — tightened to this repo's exact port

Changed to derive the expected port from `supabase/config.toml`'s `[api]`
section (`57321`) and refuse anything that isn't
`http(s)://127.0.0.1:57321` or `http(s)://localhost:57321` — no longer
accepts "any" localhost/127.0.0.1 port.

New probe matrix: `scripts/local/assert-local-db.test.sh` (not wired into
`pnpm test` — no scripts/ test-runner precedent in this repo; run directly).

```
$ bash scripts/local/assert-local-db.test.sh
PASS: 54321 (another project's local stack) refused (exit 1)
PASS: 55321 (another project's local stack) refused (exit 1)
PASS: 56321 (another project's local stack) refused (exit 1)
PASS: hosted production URL refused (string comparison only — no request sent) (exit 1)
PASS: 57321 (this repo's configured port) passes (exit 0)
PASS: unset env + no .env.local refused (exit 1)

assert-local-db.test.sh: 6 passed, 0 failed
$ echo $?
0
```

The "hosted production URL" probe passes the literal string
`https://qcfmwphlaekfkqwkfyth.supabase.co` as an env var value that the
guard compares against a `case` pattern — no network request is ever made
to it (the guard has never made HTTP requests; it's a pure string check).

---

## 2. `scripts/seed-local-supabase.mjs` — hardcoded fallback removed + hard gate added

- Removed `?? "http://127.0.0.1:54321"` — `NEXT_PUBLIC_SUPABASE_URL` is now
  required explicitly (loading `.env.local` via the existing `dotenv`
  call is unaffected). Refuses immediately with a clear message if unset.
- `assertWriteAllowed()` (called before `createClient`/any write, in both
  `seed()` and `teardown()`) now also spawns
  `scripts/local/assert-local-db.sh` as a subprocess and requires exit 0 —
  the same pattern the pre-existing `scripts/local/seed-local.mjs` already
  used for the same reason (Node can't `source` a bash script).

Transcript:

```
$ NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321" node scripts/seed-local-supabase.mjs --confirm
!! REFUSING TO RUN: NEXT_PUBLIC_SUPABASE_URL is not THIS repo's local stack.
!!   url = http://127.0.0.1:54321
!!   expected host:port = 127.0.0.1:57321 or localhost:57321
Command failed: bash scripts/local/assert-local-db.sh
$ echo $?
1
```

(Refused BEFORE `createClient`/any write — confirmed by reading the call
order in `seed()`: `assertWriteAllowed()` runs first, `createClient` only
after it returns.)

```
$ mv .env.local /tmp/.env.local.bak   # simulate "no .env.local"
$ env -u NEXT_PUBLIC_SUPABASE_URL node scripts/seed-local-supabase.mjs
Refusing to run: NEXT_PUBLIC_SUPABASE_URL is not set (checked env + .env.local).
$ echo $?
1
$ mv /tmp/.env.local.bak .env.local   # restored immediately after
```

```
$ node scripts/seed-local-supabase.mjs   # normal dry run, .env.local present, correct port
  Target:     http://127.0.0.1:57321
  Mode:       DRY RUN
  Local URL:  yes
$ echo $?
0
```

`.env.local` was restored byte-for-byte after the "no .env.local" probe
(verified via `ls -la` and `git status --porcelain .env.local`, which shows
nothing since the file is gitignored/untracked either way).

`scripts/backup/*` and `scripts/restore-drill.mjs` were left untouched, per
the fix list — confirmed they hard-require DB port `54322`
(`scripts/backup/assert-disposable-target.mjs:13`) and so already fail
closed against this repo's `57322`. One line added to
`docs/runbooks/local-stack.md`'s Safety model section noting this.

---

## 3. Production hostname scrubbed from the runbook

`docs/runbooks/local-stack.md` no longer names
`qcfmwphlaekfkqwkfyth.supabase.co` — replaced with "the hosted production
Supabase project."

Grepped the full round-1 diff (`git diff 225fbfb..33a3fae`) for every
occurrence of the hostname and of port `3100`; both greps are reproduced
here for the record:

```
$ git diff 225fbfb..33a3fae | grep -n "qcfmwphlaekfkqwkfyth"
173:  +- Production Supabase is `qcfmwphlaekfkqwkfyth.supabase.co`. Nothing in
```

Only one occurrence — now fixed. (The hostname also appears elsewhere in
the repo — `.github/workflows/db-backup.yml`, `docs/LOCAL-SUPABASE.md`,
`scripts/backup/*`, old migration comments, `schema.snapshot.sql` — all of
which PRE-DATE round 1 and are legitimately about the real backup/restore
tooling, not this local-stack work. Left untouched, out of scope.)

The only remaining occurrence of the hostname string ANYWHERE touched by
this round is inside the new
`scripts/local/assert-local-db.test.sh`'s probe matrix (`probe_url
"https://qcfmwphlaekfkqwkfyth.supabase.co"`) — required by this fix list's
own item 1 test matrix, used only as a string-comparison value, never sent
as a request.

---

## 4. Port standardized on 3000

Changed: `.env.local`, `.env.local.example`
(`NEXT_PUBLIC_APP_URL=http://localhost:3000`), `supabase/config.toml`
(`[auth] site_url = "http://127.0.0.1:3000"`,
`additional_redirect_urls` now includes `3000` variants only),
`docs/runbooks/local-stack.md` (both `pnpm dev -p 3000` examples), and
`scripts/local/dev-stack.sh`'s printed "next steps" (was hardcoded to
3100, now 3000 — not explicitly listed in the fix list but left
inconsistent it would have directly contradicted this fix, so corrected
for coherence). `playwright.config.ts` and `e2e/*.ts` were NOT touched —
they already assumed 3000.

```
$ git grep -n "3100" -- . ':!node_modules' ':!.next'
(no output)
```

---

## 5. Runtime re-verification (unsandboxed)

### 5a. `dev-stack.sh` bring-up + idempotency

```
$ supabase stop
Stopping containers...
Stopped supabase local development setup.
$ echo $?
0
```

Confirmed only `terroir-vw-local`'s 12 containers stopped —
`mobile-demo-production-readiness`, `g1-4`, `g1-8` (36 containers total)
were unaffected (`docker ps` before/after).

**Run 1** (cold start):

```
$ bash scripts/local/dev-stack.sh
assert-local-db: OK — target is this repo's local stack (http://127.0.0.1:57321)
=== dev-stack: supabase start ===
...
Started supabase local development setup.
=== dev-stack: supabase db reset (fresh schema from supabase/migrations/) ===
Applying migration 0001_auth_boundary.sql...
...
Applying migration 0076_csv_import_batches.sql...
Finished supabase db reset on branch main.
=== dev-stack: seed dev-login user + restaurant ===
seed-local: created user devlocal@terroir.test (id=...)
seed-local: membership present (restaurant_id=..., role=owner)
seed-local: done.
=== dev-stack: status ===
...
 Terroir local stack is up.
$ echo $?
0
```

71/71 migration files on disk (`ls supabase/migrations/*.sql | wc -l`)
matched 71 `Applying migration ...` lines in the log.

**Run 2** (immediately after, same running stack — the literal idempotency
check):

```
$ bash scripts/local/dev-stack.sh
assert-local-db: OK — target is this repo's local stack (http://127.0.0.1:57321)
=== dev-stack: supabase start ===
...
=== dev-stack: supabase db reset ===
Applying migration 0001_auth_boundary.sql...
...
Applying migration 0076_csv_import_batches.sql...
Finished supabase db reset on branch main.
=== dev-stack: seed dev-login user + restaurant ===
seed-local: created user devlocal@terroir.test (id=4a27825d-6a95-4f05-909a-575d03707e20)
seed-local: membership present (restaurant_id=e4a0cdfd-fa7e-4e5e-a466-deb59ceea9fd, role=owner)
seed-local: done.
...
 Terroir local stack is up.
$ echo $?
0
```

Both runs: 71/71 migrations, exit 0, working seed. **This satisfies the
literal ask** (stop → run → run again, both exit 0).

**Flakiness discovered and root-caused (not on the fix list; NOT patched — see
"Could not fully prove" below):** during earlier exploratory runs of this
same stop→run→run sequence, the *second* run's seed step intermittently
failed with `seed-local: FAILED — listUsers failed: {}` (reproduced twice
in a row before the clean pair above succeeded). Root cause, confirmed via
`docker logs supabase_kong_terroir-vw-local`:

```
2026/08/23 20:33:18 [error] ... connect() failed (111: Connection refused) while connecting to upstream,
  ... request: "GET /auth/v1/admin/users?per_page=200 HTTP/1.1",
  upstream: "http://192.168.147.6:9999/admin/users?per_page=200"
```

`supabase db reset` restarts the `auth` (GoTrue) container, which gets a
new internal Docker IP; Kong (the local gateway) caches the old IP and
returns `502` for every `/auth/v1/*` route until Kong itself is restarted
or its DNS cache expires. Confirmed the fix: `docker restart
supabase_kong_terroir-vw-local` immediately restored `200` responses from
`/auth/v1/settings`. This is a pre-existing Docker-networking
characteristic of the supabase-cli local stack (not something introduced
by this round's script changes — none of items 1–4 touch Kong, Docker
networking, or container lifecycle), and is **not in this round's fix
list**, so it was intentionally NOT patched. Flagged here for follow-up
(e.g. `dev-stack.sh` could restart Kong or add a short retry/backoff around
the seed step after `db reset`).

### 5b. Guard probe matrix

See §1 above — reproduced in full there (6/6 pass, exit 0 overall).

### 5c. `tsc --noEmit` and `pnpm test`

```
$ pnpm exec tsc --noEmit
$ echo $?
0
```

Clean, no output, exit 0.

```
$ pnpm test
 Test Files  6 failed | 228 passed | 2 skipped (236)
      Tests  6 failed | 1666 passed | 7 skipped (1679)
$ echo $?
1
```

All 6 failures were `Error: Test timed out in 5000ms` (Vitest's default
per-test timeout), across unrelated files (`verify-api-contract.test.ts`,
`generator.test.ts`, `preview-health-workflow.test.ts`,
`price-comparison/page.test.tsx`, `cellar-shell-open-bottles.test.tsx`,
`api/scan/route.test.ts`) — none of them touch anything this round changed
(all 6 changed files in this round are shell/mjs/toml/md under
`scripts/local/`, `scripts/seed-local-supabase.mjs`,
`docs/runbooks/`, `supabase/config.toml`, `.env.local*`). Re-ran just those
6 files in isolation:

```
$ pnpm exec vitest run src/lib/api-route-inventory/verify-api-contract.test.ts \
    src/lib/product-contract-conformance/generator.test.ts \
    src/test/contracts/preview-health-workflow.test.ts \
    "src/app/(app)/price-comparison/page.test.tsx" \
    "src/app/(app)/cellar/cellar-shell-open-bottles.test.tsx" \
    src/app/api/scan/route.test.ts
 Test Files  6 passed (6)
      Tests  61 passed (61)
$ echo $?
0
```

And re-ran the FULL suite a second time, clean:

```
$ pnpm test
 Test Files  234 passed | 2 skipped (236)
      Tests  1672 passed | 7 skipped (1679)
   Duration  27.52s   (vs. 63.80s on the flaky run)
$ echo $?
0
```

Conclusion: the first `pnpm test` run's 6 timeouts were system-load
artifacts (this session was concurrently running Docker/Supabase + `tsc`),
not a regression from this round's changes — confirmed both by isolation
re-run and by a clean full-suite re-run.

### 5d. Dev server + curl chain + service-role REST check

**Port 3000 was occupied throughout this session by an unrelated,
pre-existing process** — `next-server (v16.3.0)`, PID 62402, cwd
`/Users/zero/Documents/Codex/2026-08-22/lets/work/one-box-page-ir-safe-pipeline`,
started at 11:54:53 (well before this task began). This is a different
project's dev server in a concurrent session on the same machine. Per the
hard rule to kill only servers this task itself started, and by their
port, this process was **not** touched. Verified it was still there,
untouched, at the end of the session.

Ran the required curl chain against `pnpm dev -p 3050` instead (the
smallest free port checked). This does not weaken the port-3000
standardization proof from item 4 (a static-config fix, verified by grep
above) — and `src/app/api/dev-login/route.ts` derives its redirect
`Host`/port from the incoming request's own `Host` header (falling back to
the literal string `"localhost:3000"` only if no `Host` header is present
at all, which curl always sends), so its behavior is identical on any
port.

```
$ pnpm dev -p 3050 &                    # backgrounded
▲ Next.js 16.2.4 (Turbopack)
- Local:  http://localhost:3050
✓ Ready in 2.7s

$ curl -s -o /dev/null -w "%{http_code}" http://localhost:3050/login
200

$ curl -s -i -c cookies.jar http://localhost:3050/api/dev-login
HTTP/1.1 303 See Other
location: http://localhost:3050/
set-cookie: sb-<REDACTED>=<redacted>; Path=/; Expires=Mon, 27 Sep 2027 ...; SameSite=lax

$ curl -s -b cookies.jar -D - -o /dev/null http://localhost:3050/
location: /insights          # 307, same-origin redirect

$ curl -s -L -b cookies.jar -o /dev/null -w "%{http_code} %{url_effective}" http://localhost:3050/
200 http://localhost:3050/insights
```

Service-role REST check (service-role key never printed):

```
$ curl -s "http://127.0.0.1:57321/rest/v1/restaurants?select=id,name,created_at" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
[{"id":"e4a0cdfd-fa7e-4e5e-a466-deb59ceea9fd","name":"Devlocal Test Restaurant","created_at":"2026-08-23T20:36:46.184869+00:00"}]
```

Matches the restaurant id `seed-local` reported in run 2 (§5a) — the
seeded row is really there, reachable via the service-role REST API on the
tightened, project-specific port.

```
$ lsof -ti :3050 | xargs kill
$ lsof -ti :3050 -sTCP:LISTEN
(no output — port clear)
```

Port 3000's unrelated process was confirmed still running afterward
(untouched).

### 5e. Playwright e2e coherence proof

`e2e/smoke.test.ts` (smallest spec: 3 tests, no `AUTH_E2E_*` real-provider
requirements, no writes beyond what's already seeded) run against the
already-running dev server via `PLAYWRIGHT_BASE_URL` —
`playwright.config.ts` (unmodified) already supports this exact mechanism
by design (its own comment: "lets a suite target an already-running dev
server on a fixed, non-default port ... instead of spawning another one on
:3000"), so no config/e2e file edits were needed.

```
$ PLAYWRIGHT_BASE_URL=http://localhost:3050 pnpm exec playwright test e2e/smoke.test.ts
PASS (2) FAIL (1)
1. public wine list 404 for invalid slug
   Test timeout of 30000ms exceeded.
```

The dev-server log showed the actual cause: `/list/[slug]` needed
first-time Turbopack compilation (`○ Compiling /list/[slug] ...`), and the
request that triggered it took 26.4s total (`GET
/list/nonexistent-slug-12345 404 in 26.4s`) — the SERVER did return the
correct `404`, just past Playwright's 30s test timeout once client-side
overhead is added. Not a real defect; re-ran once the route was
warm-compiled:

```
$ PLAYWRIGHT_BASE_URL=http://localhost:3050 pnpm exec playwright test e2e/smoke.test.ts
PASS (3) FAIL (0)
Time: 17451ms
$ echo $?
0
```

Other e2e specs were not attempted: several require `AUTH_E2E_ENABLED=1`
against a real auth provider (out of scope for this local stack, and
explicitly gated off in `.env.local`), and running the rest of the suite
wasn't requested ("one spec ... as a coherence proof").

---

## Could not fully prove / flagged for follow-up

1. **`dev-stack.sh` idempotency has a real, reproducible-but-intermittent
   flake** (Kong upstream-DNS-cache 502 after `db reset` restarts `auth`;
   see §5a). The literal ask (stop → run → run again, both exit 0) is
   proven above with a clean pair of runs, but during investigation the
   second run failed twice in separate earlier attempts with the same root
   cause. This is a pre-existing local-stack characteristic, not touched by
   any of items 1–4, and was deliberately NOT patched (outside this fix
   list's scope) — flagging for a follow-up fix (e.g., restart Kong or add
   a retry/backoff after `db reset`, before the seed step).
2. **Literal `pnpm dev -p 3000`** could not be run — port 3000 was held for
   the whole session by an unrelated external process (PID 62402, a
   different project's dev server in a separate concurrent session). Ran
   the identical proof on port 3050 instead; verified the app's dev-login
   logic is host-header-driven, not port-hardcoded, so this substitution
   doesn't change what was proven. The static port-3000 config
   (`.env.local`, `.env.local.example`, `supabase/config.toml`) is
   confirmed correct by grep (§4).
3. Only one Playwright spec (`e2e/smoke.test.ts`) was run, as instructed.
