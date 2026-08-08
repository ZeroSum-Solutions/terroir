# TER-028 bottle-scan security evidence

Review environment: local isolated worktree with Supabase PostgreSQL, Node
24.16.0, and pnpm 10.33.2. Base: `5638b63`. Reviewed source ref: `89e151e`.

CMD-001 is the final `git diff --name-only 5638b63...HEAD` capture. It exits 0
and accounts for every path listed in the structured security report.

CMD-002 is `gitleaks detect --source . --no-banner --redact --log-opts
5638b63..HEAD`. It exits 0 across the final committed range with no leak.

CMD-003 is the focused control suite: bottle-scan lookup, confirmation,
ingestion-boundary, component, provenance-contract, and save-route tests. It
exits 0 with six files and 61 tests passing. The corrective follow-up exits 0
with four files and 32 tests passing.

CMD-004 applies migrations through 0080 and 0082 to an isolated Supabase
PostgreSQL database, then executes
`supabase/tests/0082_bottle_scan_provenance.sql`. It exits 0. Before 0082, the
same acceptance fails with `added_via` equal to `manual`. After 0082, a keyed
fresh confirmation and exact replay create exactly one tenant-bound row with
quantity 1, unit cost 0, section `Reserve`, bin `R-82`, and `added_via` equal to
`bottle_scan`.

CMD-005 applies the 0082 down migration, verifies its function body is
byte-identical to migration 0066, reapplies 0082, and reruns acceptance. It
exits 0.

CMD-006 runs TypeScript no-emit, focused ESLint, snapshot generation, the
down-migration pair gate, and Playwright collection. It exits 0. Playwright
collects one isolated mobile test; the browser test is not executed here and
is not runtime evidence.

Manual review found no open security defect. The changed RPC keeps the 0066
authentication, current-tenant staff role, tenant-owned wine, canonical hash,
advisory lock, claim, exact replay, and hardened search-path controls unchanged.
The only forward semantic delta is `manual` to `bottle_scan`; the down function
is exactly the 0066 baseline. Execute remains revoked from `public` and `anon`
and granted only to `authenticated`.

Malformed QR payloads fail request validation, foreign lookup and confirmation
return opaque not-found responses, and neither path reaches a bottle-scan
inventory write. Confirmation validates normalized, bounded section and bin
values and reconstructs the request hash inside PostgreSQL. The isolated
fixture cleanup deletes inventory and wine rows by fixture restaurant ID.

No prompt, retrieval, model call, credential source, download, telemetry, or
other external export was added or changed. The E2E service-role client is
confined to the existing isolated fixture harness and its staging-only config
guard; it is not application runtime code.

Fable 5 medium advisory through the approved Nous Portal returned HTTP 200 and
final verdict PASS with no P0, P1, or P2 finding. Its first review's apparent
duplicate SQL block was retracted after contiguous source proved the blocks
were the existing-claim and insert-return phases. Its valid test-evidence
recommendations were incorporated: keyed replay acceptance, malformed and
foreign-confirm cases, distinct rapid QR values, correction and cancel paths,
corrected-wine persistence, exact 0066 forward/down equality, and cleanup
evidence. Browser runtime remains explicitly pending staging.
