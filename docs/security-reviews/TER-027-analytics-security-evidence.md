# TER-027 analytics security evidence

## Scope and commands

The reviewed source candidate was `cb969dd` against base `235a88d`. `git diff
--name-only 235a88d...HEAD` exited 0 and accounted for every path listed in the
structured review. Documentation and this security record are classified in the
same final path map.

`gitleaks detect --source . --no-banner --redact --log-opts 235a88d..HEAD`
exited 0 at the source candidate after scanning ten commits and about 82.61 KB;
it reported no leaks. The same exact range command is rerun after the security
record commit so the record itself is included in the final handoff scan.

The focused analytics security set passed: the insights route family passed 29
tests, including unauthenticated response identity, tenant predicates, invalid
custom-range rejection before database access, redacted query failures,
date-bound CSV spend, unique corrected-item accounting, CSV quoting, and
spreadsheet-formula neutralization. The date-range, page-query-error, and pour
route suites passed their UTC-boundary, fail-closed, and tenant tests.

Migration 0085 and its acceptance were applied together inside one outer
transaction in isolated PostgreSQL. The command exited 0 after `BEGIN`, schema
and trigger creation, all assertions, and `ROLLBACK`; no fixture or schema state
escaped the proof transaction.

On Node 24.16.0 and pnpm 10.33.2, the full suite passed 180 files and 1,664
tests. TypeScript no-emit, ESLint, the production build with 50 static pages,
the 83-migration snapshot check, 73 paired down migrations, API contract,
feature ledger, actionlint, Playwright collection, UI-control inventory, and
canonical-document verifier all passed.

## Surface review

No prompt, retrieval, model-message, or tool-control path changed. Environment
and workflow changes contain credential names only; staging values continue to
enter through GitHub variables and secrets, and the range gitleaks scan covers
source, tests, fixtures, generated schema, documentation, and workflow changes.

The three changed insights endpoints authenticate with `requireMembership`
before protected reads. Every scan, inventory, pour, and wine-list query binds
the server-derived restaurant identifier. Query failures throw into redacted
route-family handling rather than becoming empty analytics. The app pages stay
inside the authenticated shell, and migration 0085 adds no table policy, role,
grant, or security-definer privilege; its trigger executes only as part of an
already-authorized wine update with an empty search path.

Custom dates accept exact calendar-day strings, use deterministic UTC
boundaries, require both endpoints in ascending order, and return 400 before a
custom-range database query when invalid. The API query schema bounds `topN` to
1 through 50. CSV values quote delimiters and double quotes and prefix
spreadsheet-formula-leading tenant values with an apostrophe. The export and
page query tests cover malformed input, cross-surface range propagation,
redacted database failure, and tenant predicates.

## Export policy

The insights CSV download goes only to the authenticated requesting member. It
contains tenant-scoped scan dates, distributor names, aggregate item/correction
counts, spend, and varietal value for the selected range. It is returned as the
request response, is not persisted by the application, fails closed with a 400
or redacted 500, and follows the allowlisted request-lifetime CSV policy in
`docs/runbooks/data-lifecycle-privacy.md`.

The analytics pilot can add synthetic browser traces to the existing staging
evidence artifact. The workflow encrypts the archive with the configured age
recipient before upload, deletes plaintext evidence, exposes only the encrypted
archive and checksum, and retains the GitHub artifact for 14 days. The canonical
staging procedure requires this exact isolated evidence lane; no customer or
production data is used.

No blocking, high, medium, low, or informational security finding remains after
the spreadsheet-formula fix and successful recheck.
