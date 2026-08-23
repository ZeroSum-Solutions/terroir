# P0 Local Stack — Round 3 Verification

Unsandboxed re-verification of the round-3 fixes, run directly in the
worktree (`/Users/zero/projects/terroir-vw`, branch
`feat/visual-wine-prototype`) against Docker/OrbStack and the real local
Supabase CLI (`supabase 2.109.1`). All commands below were actually
executed; outputs are trimmed for length where noted but not altered
otherwise. No value below is a real secret — anon/publishable and
service-role keys are the well-known `supabase-cli` local-dev defaults (see
`.env.local.example`'s own header comment) and are redacted anyway, and no
production hostname appears anywhere in this document.

Round-2 critic verdict was DOES-NOT-MEET with three defects. This round
fixes exactly those three and nothing else.

---

## Defect 1 (MAJOR) — post-reset readiness gate

**Problem:** `dev-stack.sh` seeded immediately after `supabase db reset`
with no readiness gating. `db reset` restarts the `auth` (GoTrue)
container, which gets a new internal Docker IP; Kong (the local API
gateway) can keep routing `/auth/v1/*` to the stale IP for a few seconds,
returning transient `502`s that can break the seed step or any test run
immediately after bring-up.

**Fix (`scripts/local/dev-stack.sh`):** after `supabase db reset` and
before seeding, a new `_wait_for_api_ready` function polls
`http://127.0.0.1:57321/auth/v1/health` and `http://127.0.0.1:57321/rest/v1/`
(with the local anon/publishable key read from `.env.local`, never printed)
until both return `200`, bounded to ~30s total. If a `502` persists past 5s,
it runs `docker restart` once on this repo's Kong container — name derived
from `supabase/config.toml`'s `project_id` via a new `_kong_container_name`
helper (falls back to the known literal only if that derivation fails) — and
resumes polling within the same overall timeout. If still unhealthy at the
deadline, it exits non-zero with a loud message instead of seeding against a
possibly-broken stack. Documented in a new "Post-reset readiness" section in
`docs/runbooks/local-stack.md`.

Proof the gate runs and passes is in §5a below (both the cold and the
idempotent run show `dev-stack: API ready (auth/v1/health=200,
rest/v1/=200).` right after `db reset`, before the seed step).

**Exercising the recovery branch (502 → restart → resume):** three attempts
were made this session to trigger the real Kong-stale-IP race naturally:

1. `docker restart supabase_auth_terroir-vw-local`, then polled
   `/auth/v1/health` every 0.25s for 10s — stayed `200` throughout.
2. `docker stop` + `docker start` on the same container (checked — the
   container kept the same IP, `192.168.147.6`, across the cycle), polled
   every 0.3s for 9s — stayed `200`.
3. A live `supabase db reset` run in the background while polling
   `/auth/v1/health` every 0.3s and re-checking the auth container's IP —
   the IP never changed and every poll returned `200`.

None reproduced a `502` in this environment/session (this is consistent
with the round-2 verification notes, which describe the race as
intermittent — reproduced twice in earlier exploratory runs, not on the
runs recorded there). **Marking the real race as untriggered this run.**

To still exercise the exact recovery *code path* rather than leave it
unverified, the literal `_wait_for_api_ready` function was extracted
verbatim from `dev-stack.sh` and pointed at a small local fault-injection
server standing in for Kong (`fake_kong.py`, not part of this change —
scratch-only, deleted after use) that serves `502` for a fixed window then
flips to `200`:

```
$ source extracted_wait_fn.sh   # verbatim copy of dev-stack.sh's function
$ python3 fake_kong.py 12 58081 &            # 502s for 12s, then 200s
$ _wait_for_api_ready "http://127.0.0.1:58081" "fake-anon-key" \
    "nonexistent-container-proves-restart-attempted-and-noop-safe"
dev-stack: waiting for the API to be ready (up to 30s)...
dev-stack: got 502 5s post-reset (auth=502, rest=502)
dev-stack: this is Kong holding a stale Docker IP for the restarted auth container.
dev-stack: restarting nonexistent-container-proves-restart-attempted-and-noop-safe once to clear its upstream cache, then resuming...
dev-stack: API ready (auth/v1/health=200, rest/v1/=200).
$ echo $?
0
```

This proves: the 502-detection fires at the documented ~5s threshold, the
restart is attempted exactly once (deliberately against a nonexistent
container name to prove the `docker restart ... || true` no-op-on-failure
path is safe — real code, real failure, real recovery), and polling resumes
and succeeds within the overall timeout. The fake server's own log confirms
it kept returning `502` until t=12.4s and the gate kept polling patiently
until then:

```
[fake-kong t=0.3s]  /auth/v1/health -> 502
[fake-kong t=4.6s]  /auth/v1/health -> 502
[fake-kong t=11.3s] /auth/v1/health -> 502
[fake-kong t=12.4s] /auth/v1/health -> 200
```

(An earlier attempt at this same fault-injection test was discarded because
the fake server and the gate were started in separate tool calls, and
inter-call latency skewed the server's internal clock ahead of the gate's —
it produced a false "succeeded before the 5s restart threshold" result.
Rerun in one shell invocation so both clocks start together; the corrected
run is the one shown above.)

The local stack was left seeded and healthy afterward — see the final
health check in §5f (the manual `db reset` used in attempt 3 above wiped
seed data, so `dev-stack.sh` was re-run once more at the end to restore it;
that's a third, non-counted run — the required cold/idempotent pair is
§5a's Run 1 / Run 2).

---

## Defect 2 (MINOR) — production hostname removed from test fixtures

**Problem:** this repo's real production Supabase project hostname was
committed in `scripts/local/assert-local-db.test.sh`'s hosted-refusal probe
and mentioned in the previous `VERIFICATION.md`. (Deliberately not quoted
here either — see below for why.)

**Fix:** the probe now uses a fake, obviously-non-production URL —
`https://fake-hosted-project.supabase.co` — which exercises the identical
guard behavior (the guard is a pure string comparison against
`127.0.0.1:<port>` / `localhost:<port>`; it refuses *any* non-matching
host, real or fake, without ever making a request).

This document deliberately never spells out the real hostname string,
including inside a demonstration command — doing so would itself be a new
occurrence of it in this tracked file, defeating the point. The actual
check run to confirm removal was `git diff 225fbfb..HEAD | grep -c
<the real hostname>`, confirmed to return `0` (reported alongside the
commit SHAs, outside this file).

---

## Defect 3 (MINOR) — port-coherence check restated to be internally consistent

**Problem:** the previous `VERIFICATION.md` claimed a tracked-file grep for
`3100` returns nothing, while the transcript itself narrated three hits
(from explaining the round-1 port-3000-standardization fix) — an internal
contradiction.

**Fix:** the check is now stated precisely as *"grep for `3100` in tracked
files excluding this transcript returns nothing"*, and that is what's
actually run:

```
$ git grep -n "3100" -- . ':!docs/screenshots/p0-local-stack/VERIFICATION.md' ':!node_modules' ':!.next'
$ echo $?
1
```

(`git grep` exits `1` for "no matches" — there is no output above this
line, i.e. zero hits outside this transcript file itself. This document's
own prose is free to discuss "3100" as history, as it does above and in
§1, without contradicting the check.)

---

## Runtime re-verification (unsandboxed)

### 5a. `supabase stop` → `dev-stack.sh` cold → `dev-stack.sh` idempotent

```
$ supabase stop
Stopping containers...
Stopped supabase local development setup.
$ echo $?
0
```

Confirmed via `docker ps` before/after: only `terroir-vw-local`'s
containers stopped. The other three local Supabase stacks running on this
machine throughout this session — `mobile-demo-production-readiness`
(543xx), `g1-4` (563xx), `g1-8` (553xx) — were unaffected.

**Run 1 (cold start):**

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
=== dev-stack: waiting for API readiness (post-reset) ===
dev-stack: waiting for the API to be ready (up to 30s)...
dev-stack: API ready (auth/v1/health=200, rest/v1/=200).
=== dev-stack: seed dev-login user + restaurant ===
seed-local: created user devlocal@terroir.test (id=6a1147ae-9903-422b-9a38-18e00b637853)
seed-local: membership present (restaurant_id=cf01c20a-e3fc-4eb2-a40c-32296c313154, role=owner)
seed-local: done.
=== dev-stack: status ===
...
 Terroir local stack is up.
$ echo $?
0
```

71/71 migration files on disk (`ls supabase/migrations/*.sql | wc -l`)
matched 71 `Applying migration ...` lines in the log. The readiness gate
line appears exactly once, between `db reset` and the seed step, as
designed.

**Run 2 (idempotent — run again immediately after):**

```
$ bash scripts/local/dev-stack.sh
assert-local-db: OK — target is this repo's local stack (http://127.0.0.1:57321)
...
=== dev-stack: waiting for API readiness (post-reset) ===
dev-stack: waiting for the API to be ready (up to 30s)...
dev-stack: API ready (auth/v1/health=200, rest/v1/=200).
=== dev-stack: seed dev-login user + restaurant ===
seed-local: created user devlocal@terroir.test (id=c0bfe511-1b41-484b-9f85-310cb102aed1)
seed-local: membership present (restaurant_id=97813496-f925-4406-8bcd-9ab911753c65, role=owner)
seed-local: done.
...
 Terroir local stack is up.
$ echo $?
0
```

71/71 migrations again, exit 0, gate passed both times, working seed both
times. Both runs exit 0 — the literal idempotency ask is satisfied, with
the readiness gate visibly passing on both.

### 5b. 20× `curl` of `/auth/v1/health`

```
$ for i in $(seq 1 20); do curl -s -o /dev/null -w "%{http_code} " http://127.0.0.1:57321/auth/v1/health; done
200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200
```

All 20 return `200`.

### 5c. Guard probe matrix

```
$ bash scripts/local/assert-local-db.test.sh
PASS: 54321 (another project's local stack) refused (exit 1)
PASS: 55321 (another project's local stack) refused (exit 1)
PASS: 56321 (another project's local stack) refused (exit 1)
PASS: hosted URL refused (string comparison only — no request sent) (exit 1)
PASS: 57321 (this repo's configured port) passes (exit 0)
PASS: unset env + no .env.local refused (exit 1)

assert-local-db.test.sh: 6 passed, 0 failed
$ echo $?
0
```

(The "hosted URL" probe now uses `https://fake-hosted-project.supabase.co`
— see Defect 2 above.)

### 5d. `tsc --noEmit` and `pnpm test` (full suite)

```
$ pnpm exec tsc --noEmit
TypeScript: No errors found
$ echo $?
0
```

```
$ pnpm test
 RUN  v4.1.4 /Users/zero/projects/terroir-vw
 Test Files  234 passed | 2 skipped (236)
      Tests  1672 passed | 7 skipped (1679)
$ echo $?
0
```

No concurrent-vitest lane was detected running on this machine at the time
(checked via `ps aux | grep vitest` immediately before each run). The full
suite was run twice this round (once for the transcript, once to pin down
the exit code precisely) — **both green on the first attempt, 0 failures,
0 flakes encountered.** The known unrelated flake called out in the task
(`price-comparison/page.test.tsx` timing out under load) did not occur
either time; no reruns were needed.

**Attempts needed for a green full suite: 1.**

### 5e. Live smoke test

Port 3000 was held throughout this session by an unrelated, pre-existing
process (`next-server`, PID 62402, started well before this task began —
confirmed still running, untouched, at the end). Per the rule to kill only
servers this task started and only by port, ran the smoke test on port
3050 instead (confirmed free before starting).

```
$ pnpm dev -p 3050 &
▲ Next.js 16.2.4 (Turbopack)
- Local: http://localhost:3050
✓ Ready in 955ms
```

```
$ curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3050/login
200
```

```
$ curl -s -i -c cookies.jar http://localhost:3050/api/dev-login
HTTP/1.1 303 See Other
location: http://localhost:3050/
set-cookie: sb-127-auth-token=<REDACTED session JWT>; Path=/; Expires=Mon, 27 Sep 2027 ...; SameSite=lax
```

```
$ curl -s -D - -o /dev/null -b cookies.jar http://localhost:3050/
HTTP/1.1 307 Temporary Redirect
location: /insights

$ curl -s -L -b cookies.jar -o /dev/null -w "%{http_code} %{url_effective}" http://localhost:3050/
200 http://localhost:3050/insights
```

Service-role REST check (service-role key read from `.env.local` into a
shell variable and never echoed):

```
$ curl -s "http://127.0.0.1:57321/rest/v1/restaurants?select=id,name,created_at" \
    -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
[{"id":"97813496-f925-4406-8bcd-9ab911753c65","name":"Devlocal Test Restaurant","created_at":"2026-08-23T21:05:32.597027+00:00"}]
```

Matches Run 2's seeded `restaurant_id` (§5a) exactly, and the user id in
the dev-login JWT payload (`c0bfe511-1b41-484b-9f85-310cb102aed1`) matches
Run 2's seeded `user_id`. The seeded row is really there, reachable via
the service-role REST API on this repo's tightened, project-specific port.

```
$ kill $(lsof -ti :3050 -sTCP:LISTEN)
$ lsof -ti :3050 -sTCP:LISTEN
(no output — port clear)
```

Port 3000's unrelated process (PID 62402) confirmed still running,
untouched, afterward.

### 5f. Final stack health check

The manual `supabase db reset` used while investigating Defect 1's
recovery path (§1, attempt 3) wiped the seed data outside of `dev-stack.sh`
(no seed step runs after a bare `db reset`). `dev-stack.sh` was run once
more at the end of the session to restore a clean, seeded, healthy stack:

```
$ bash scripts/local/dev-stack.sh
...
dev-stack: waiting for the API to be ready (up to 30s)...
dev-stack: API ready (auth/v1/health=200, rest/v1/=200).
...
seed-local: membership present (restaurant_id=3d2c1208-8bbd-4379-bca2-de30692f0021, role=owner)
seed-local: done.
$ echo $?
0
```

Final state confirmed:

```
$ curl -s "http://127.0.0.1:57321/rest/v1/restaurants?select=id,name" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
[{"id":"3d2c1208-8bbd-4379-bca2-de30692f0021","name":"Devlocal Test Restaurant"}]

$ lsof -ti :3000 -sTCP:LISTEN   # unrelated pre-existing process, untouched
62402
$ lsof -ti :3050 -sTCP:LISTEN   # this task's server — clear
(no output)

$ docker ps --format '{{.Names}}'   # only terroir-vw-local's 12 containers + the
                                     # other three stacks' own containers, all healthy
```

Worktree is clean (`git status --porcelain` — only the intentional changes
from this round, no leftover scratch files, no stray processes).
