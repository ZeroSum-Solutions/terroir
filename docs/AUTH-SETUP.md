# Authentication deployment contract

TER-010 code derives every Supabase email callback from `NEXT_PUBLIC_APP_URL`.
It does not trust `Host`, `X-Forwarded-Host`, or a `next` value supplied by a
browser. Applying this configuration in Supabase or Railway is an approval-gated
operator task; this document is the required before/after record and rehearsal.

## Per-environment settings

Set `NEXT_PUBLIC_APP_URL` to the exact public origin for that deployment:

| Environment | `NEXT_PUBLIC_APP_URL` | Supabase Site URL |
| --- | --- | --- |
| Production | `https://<production-host>` | `https://<production-host>` |
| Staging | `https://<staging-host>` | `https://<staging-host>` |
| Local | `http://localhost:3000` | `http://localhost:3000` |

For each environment, configure Supabase Auth Redirect URLs only for its own
origin and these path prefixes:

```text
<origin>/auth/callback**
<origin>/auth/complete**
<origin>/auth/confirm**
```

The callback suffix is limited to query data that carries a same-origin `next`
path; production must not add a wildcard host or an unrelated path. The exact
production Site URL must never be localhost. Turn on email sign-up and email
confirmation, leave anonymous sign-ins off, and keep refresh-token rotation on.

Use the default `{{ .ConfirmationURL }}` in the confirm-signup and magic-link
email templates. For the password-recovery template, use the server-side token
hash flow so a recovery link cannot carry an arbitrary destination:

```html
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=recovery">
  Reset password
</a>
```

Configure Supabase's email-sent rate limit as the distributed primary control.
The application adds a secondary five-attempt-per-minute, per-instance burst
limit for magic links, password login, sign-up, and reset requests. Both layers
return generic responses and must not reveal whether an email is registered.

## Redacted mutable-settings record

Before changing a dashboard setting, capture the current Authentication → URL
Configuration and Email provider pages in the approved evidence location. Do
not copy users, tokens, SMTP passwords, service-role keys, or full email links.
Record only this redacted matrix, then repeat it after the change:

| Field | Before | After |
| --- | --- | --- |
| Project/environment label | `<redacted>` | `<redacted>` |
| Site URL origin | `<redacted origin>` | `<redacted origin>` |
| Redirect URL origins and path prefixes | `<redacted list>` | `<redacted list>` |
| Email provider enabled | `yes/no` | `yes/no` |
| Confirm email enabled | `yes/no` | `yes/no` |
| Sign-ups enabled | `yes/no` | `yes/no` |
| Anonymous sign-ins disabled | `yes/no` | `yes/no` |
| Refresh-token rotation enabled | `yes/no` | `yes/no` |
| Email-sent rate limit | `<redacted numeric setting>` | `<redacted numeric setting>` |
| Recovery template uses `/auth/confirm` | `yes/no` | `yes/no` |

## Real-provider staging E2E

The `e2e/auth-real-provider.test.ts` suite is off by default. It never imports
the development login route and creates an opaque, unique test user each run.
The suite accepts a real target only when all of these are supplied through
isolated CI/staging secrets or variables:

```text
AUTH_E2E_ENABLED=1
AUTH_E2E_BASE_URL=https://<staging-host-containing-staging>
AUTH_E2E_MAILBOX_URL=https://<staging-mailpit-host>
AUTH_E2E_EMAIL_DOMAIN=<mailpit-only-domain>
AUTH_E2E_RUN_ID=<ci-run-id>-<attempt>
AUTH_E2E_SUPABASE_URL=https://<staging-project>.supabase.co
AUTH_E2E_PRODUCTION_SUPABASE_URL_PATTERN=<production-project-ref-or-unique-pattern>
AUTH_E2E_SERVICE_ROLE_KEY=<staging-only-secret>
```

Optional `AUTH_E2E_MAILBOX_USERNAME` and `AUTH_E2E_MAILBOX_PASSWORD` are used
only as a Basic Authorization header against the isolated Mailpit API; set both
or neither. The suite rejects a base URL without `staging` in its host, rejects
a Supabase URL matching the production pattern, uses no pre-existing password
fixture, and deletes its generated user through the staging-only service role in
`finally`.

Run it only after the operator record above is complete:

```bash
AUTH_E2E_ENABLED=1 pnpm exec playwright test e2e/auth-real-provider.test.ts
```

The required browser proof covers sign-up confirmation, password sign-in,
password reset and subsequent password sign-in, magic link sign-in, session
cookies, provider redirect origin, console/page errors, Mailpit delivery, and
fixture cleanup. A skip means the external contract is unverified, not passed.
