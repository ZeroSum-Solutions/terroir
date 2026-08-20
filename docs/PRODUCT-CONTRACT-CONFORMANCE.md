# Product contract conformance

`docs/product-contract-conformance.json` is the deterministic classification
snapshot for `TER-CF-180` through `TER-CF-217`. The generator reads only the
269 active feature-ledger requirements and a fresh discovery of route files
beneath `src/app/api`.

- A ledger route whose canonical method and route identity exist is `weak`,
  with its route source recorded as implementation evidence. Dynamic parameter
  names normalize to `{param}`. Executable behavioral proof is not yet trusted
  by this generator.
- A ledger route absent from current source is `unimplemented`. Recorded plans,
  tests, tags, and prior artifacts cannot promote it.
- The six quantified cross-cutting claims are `weak`; no trusted executable
  proof currently covers every endpoint in their stated scope.
- This generator has no `proved` transition. Its output must contain zero
  `proved` requirements.

Run `pnpm run generate:product-conformance` after an intentional route or ledger
change. CI runs `pnpm run verify:product-conformance` and fails when the checked-in
artifact drifts from fresh source discovery.

This is a drift and classification gate. It does not execute endpoint behavior,
validate authorization at runtime, or approve a release. A green result means
only that the checked-in classifications match the generator's current inputs.

The generator and its focused behavioral tests live in
`scripts/generate-product-contract-conformance.mjs` and
`src/lib/product-contract-conformance/generator.test.ts`.

`pnpm run verify:api-contract` is a separate inventory/reconciliation parity
gate. Passing parity does not establish product-contract proof.
