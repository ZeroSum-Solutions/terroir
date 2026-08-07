# Isolated E2E foundation

This is the canonical setup and operations contract for authenticated browser
tests that exercise staging data. Real authentication-provider coverage remains
a separate suite.

## Test boundary

The staging workflow runs the authenticated pour and reconcile test twice in
parallel after the read-only smoke job succeeds. Each matrix job receives its
own run namespace. The test-only helper creates a confirmed synthetic user, a
deterministic restaurant and wine-list fixture, and one object in the staging
wine-images bucket. It obtains a normal Supabase password session, adds the
resulting SSR cookies to that test's browser context, and removes the user,
tenant data, and storage object in teardown. A retry first removes any stale
fixture with the same deterministic identity.

The helper source is confined to the E2E fixture directory. It is not an
application route or runtime module, and the real-provider auth suite cannot
import it. The helper accepts only the fixed staging application origin and
Supabase project ref. It checks each supplied key against a configured SHA-256
fingerprint before creating a privileged client.

## GitHub Actions configuration

Configure the following values for the staging workflow. Store only the two
keys as secrets; the origin and one-way fingerprints are repository variables.

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `STAGING_SUPABASE_URL` | Exact isolated staging Supabase origin |
| Variable | `STAGING_SUPABASE_PUBLISHABLE_KEY_SHA256` | Fingerprint of the staging publishable key |
| Variable | `STAGING_SUPABASE_SERVICE_ROLE_KEY_SHA256` | Fingerprint of the staging service-role key |
| Secret | `STAGING_SUPABASE_PUBLISHABLE_KEY` | Staging publishable key |
| Secret | `STAGING_SUPABASE_SERVICE_ROLE_KEY` | Staging-only fixture administration key |

## Run and evidence

The package script named `test:e2e:isolated` must run only with the
`TERROIR_E2E_*` environment contract supplied by the workflow. Missing values,
an unexpected origin, a production project ref, a credential fingerprint
mismatch, console or page errors, failed network requests, and unexpected 5xx
responses all fail the job.

Playwright retains trace, screenshot, video, console, network, page-error, and
5xx evidence as workflow artifacts. The real magic-link, signup, password
reset, and callback paths remain owned by the separate real-provider auth job.
