# Evals — gauntlet protocol

**`vwp-evals.yaml` is the CI-gated eval contract for the Bevrly-response build.**
`package.json`'s `eval:vwp` script runs `scripts/run-vwp-evals.mjs` against it, CI
runs that as the step "VWP eval traceability", and
`src/test/contracts/vwp-evals-contract.test.ts` schema-validates it. Break either and
the merge is blocked.

**`top10-evals.yaml` is not a gate.** It is the original top-10 wave protocol, kept
because `vwp-evals.yaml` and a dozen migrations cite it as precedent for the
one-opportunity-one-branch / eval-becomes-a-failing-test pattern. Nothing executes it.
Its `global_gates` list is historical and is *not* the current gate set — see
`AGENTS.md` for the commands that actually have to pass.

> The originating product spec lives **outside this repository** on the author's
> machine and is unreachable to anyone else. Do not treat it as a dependency. The
> in-repo authorities are `vwp-evals.yaml` for the enforced eval contract and
> `docs/feature-ledger.json` for completion status. Post-implementation audits for
> the shipped UX-01..10 cluster are archived at `_archive/ux-high-leverage/`.

Rules for any agent (human or autonomous) working an opportunity:

1. One opportunity = one branch (named in the YAML) = one squashed landing.
2. TDD: each `EV-*` becomes at least one failing test BEFORE implementation
   (vitest for unit/property, Playwright tagged with the opportunity's `e2e_tag`).
3. Land only when the opportunity's evals AND every `global_gates` command are green.
4. Respect `depends_on` — do not start a dependent opportunity until its
   prerequisite has landed on main.
5. Schema changes ship a down migration (`pnpm run downs:check` enforces).
6. Never hand-edit `docs/feature-ledger.json`; ledger deltas flow through its
   source process.
