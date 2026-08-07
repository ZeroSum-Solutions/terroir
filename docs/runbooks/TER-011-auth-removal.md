# TER-011 authentication removal operator checklist

Run this checklist only after the TER-011 code commit is integrated into the
release candidate. Record variable names and provider outcomes, never values.

1. Inventory production and staging deployment variables with values redacted.
2. Delete `DEV_BYPASS_EMAIL`, `TEMP_AUTH_BYPASS_EMAIL`,
   `TEMP_AUTH_BYPASS_TOKEN`, `TEMP_AUTH_BYPASS_TOKEN_SHA256`, and
   `TEMP_AUTH_BYPASS_EXPIRES_AT` wherever they exist.
3. Treat the previously issued raw token as revoked. If it was ever reused as
   another credential, rotate that separate credential at its owning provider.
   Do not rewrite shared Git history as a substitute for revocation.
4. Redeploy or restart every affected service from the integrated commit.
5. With the prior token read from a secure input channel—not placed in shell
   arguments or logs—request `/api/dev-login?token=...`. Require HTTP 404, no
   redirect, no `Set-Cookie` header, and no authenticated session afterward.
6. Confirm `/login` has no alternate or development sign-in affordance, then
   run the normal magic-link, password, reset, and sign-out smoke tests.
7. Search the deployed artifact and redacted platform logs for the retired
   variable names, endpoint, token digest, and unexpected session creation.

The code-only TER-011 branch does not mutate Railway, Supabase, or GitHub. The
release owner must attach the redacted variable inventory, deployment ID, and
smoke-test result before marking external revocation complete.
