# Auth bypass: break-glass policy

`GET /api/dev-login` (`src/app/api/dev-login/route.ts`) mints a session
without a real sign-in round-trip. It exists only to make local development
and CI/E2E fast. This document is the policy for the one flag that controls
it, and the record of what an emergency ("break-glass") use must look like.

## Current behavior (verified by test)

In production (`NODE_ENV=production`), the route returns an opaque `404`
unconditionally, before reading `DEV_BYPASS_EMAIL` or any other bypass-related
variable. It does no Supabase work in that branch — there is nothing for an
attacker to time or distinguish. This is asserted directly in
`src/app/api/dev-login/route.test.ts`: the no-token, invalid-token, and
valid-legacy-capability-token cases all return the identical 404 body and
headers, and make zero calls to `fetch` or the Supabase admin client.

Outside production, `DEV_BYPASS_EMAIL` enables the route for that one email
address only. Every time it fires, it reports a Sentry event
(`"dev-login bypass invoked"`, level `warning`, tag `route: dev-login`) with
the actor email, an ISO timestamp, and a reason string — so bypass usage is
never silent, in dev, CI, or staging.

There is currently **no way to enable this route in production** short of a
code change to `route.ts` itself. That is deliberate (see commits `110e465`
and `f0e542a`, which removed an earlier production capability path). Break
glass for this route therefore means a reviewed, time-boxed **code change**,
not an environment-variable flip.

## When the bypass may be enabled

- **Never in production**, except as a last-resort, explicitly approved
  incident response — e.g., restoring owner access when the real auth
  provider is down and no other path exists.
- In non-production (local, CI, staging), `DEV_BYPASS_EMAIL` may stay set
  indefinitely — that's its normal, intended use (see `docs/LOCAL-SUPABASE.md`
  and the `e2e/*` suites that depend on it).

## Break-glass procedure (production only)

1. Get sign-off from a second engineer/owner before touching production auth.
2. Open a PR that temporarily re-enables the bypass path for production,
   scoped as narrowly as possible (e.g., a single allow-listed email, not a
   blanket `NODE_ENV` check removal). Tag it `SECURITY REVIEW` and link the
   incident.
3. Deploy it, use it, and **revert it within 24 hours** — a second PR that
   restores the unconditional production 404. The 24-hour clock starts at
   deploy, not at first use.
4. Every login through the route while it's live is already captured in
   Sentry with actor/time/reason (see above) — pull that list into the
   incident record before reverting.
5. Record in the incident ticket: who approved it, the PR that enabled it,
   the PR that reverted it, and the Sentry event list of every use.

Do not extend the 24-hour window by redeploying the same capability again
without a fresh approval.

## Environment variables

| Variable | Where it may be set | Effect in production |
| --- | --- | --- |
| `DEV_BYPASS_EMAIL` | Local `.env.local`, CI, staging | None — read only outside the production `NODE_ENV` check |
| `TEMP_AUTH_BYPASS_EMAIL` | Nowhere (legacy, retired) | None — no longer read anywhere in `route.ts` |
| `TEMP_AUTH_BYPASS_TOKEN` / `TEMP_AUTH_BYPASS_TOKEN_SHA256` | Nowhere (legacy, retired) | None |
| `TEMP_AUTH_BYPASS_EXPIRES_AT` | Nowhere (legacy, retired) | None |

Confirmed via `railway variable list` against the production `terroir-web`
and `terroir-worker` services (project `industrious-courtesy`,
environment `production`) on 2026-08-22: neither service has
`DEV_BYPASS_EMAIL` or any `TEMP_AUTH_BYPASS_*` variable set. No cleanup was
required. If any of these ever reappear in the production environment,
remove them immediately — the code no longer reads them, but their presence
is confusing to an auditor and should not be tolerated.

To manage `DEV_BYPASS_EMAIL` in staging:

```bash
railway variable set DEV_BYPASS_EMAIL=<address> -s terroir-web -e staging
railway variable delete DEV_BYPASS_EMAIL -s terroir-web -e staging
```

**Operator TODO (not part of this change):** the ZS Vault entry
`terroir_temp_auth_bypass_token` should be relabeled to make clear it backs a
break-glass-only, ≤24h capability rather than a standing one.

## Audit trail

Every enabled invocation of `GET /api/dev-login` — dev, CI, staging, or a
future production break-glass window — calls
`Sentry.captureMessage("dev-login bypass invoked", ...)` with:

- `extra.actor`: the bypass email that was logged in as
- `extra.time`: ISO-8601 timestamp of the invocation
- `extra.reason`: why the route was enabled (currently: `DEV_BYPASS_EMAIL`
  outside production)
- `tags.route`: `"dev-login"`, for filtering in Sentry

Query Sentry for `tags.route:dev-login` to get the full list of bypass logins
for any time window, including a break-glass incident.
