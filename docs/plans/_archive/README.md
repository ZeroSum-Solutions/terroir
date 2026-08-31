# Archived plans — shipped or superseded

These plans are history, **not backlog**. Each one either landed or was explicitly
superseded. Nothing here is waiting to be picked up.

Active plans live one directory up in `docs/plans/`.

> **Before archiving any plan, check whether a script reads it.** Some documents in
> `docs/plans/` are machine-read contracts, not prose. Two are read by a gate and moving
> either reds the merge check — this happened during the 2026-08-29 documentation pass:
> `2026-07-20-terroir-completion-spec.md` (`verify-feature-ledger.mjs`,
> `verify-api-contract.mjs`) and `2026-08-24-visual-wine-platform-spec-list.md`
> (`check-migration-manifest.mjs`, plus its contract test). Others are cited by path from
> source or test comments — `2026-08-23-p2-identity-spine.md`,
> `2026-08-25-spike-04-corpus-join-rates.md`, `2026-08-28-camera-first-decisions-recorded.md`,
> `2026-08-29-modular-architecture-refactor.md`, `2026-08-29-terroir-refactor-field-notes.md`
> — which no gate catches, so moving one breaks the reference silently. Leave all of them
> where they are. (Corrected 2026-08-30: this note previously said the P2 spine plan feeds
> `verify:feature-ledger`. It does not.) Run this first:
>
> ```bash
> grep -rn "docs/plans/<file>" scripts .github src e2e
> ```

## Why each is here

| Plan | Verdict |
|---|---|
| `2026-04-18-lwin-matching.md` | SHIPPED (`0007_lwin_matching.sql`), then heavily evolved by `0078`, `0079`, `0097`, `0127`. Foundational spec only. |
| `2026-08-20-high-leverage-ux-plan-audits.md` | SHIPPED. Pre-implementation audit table, all 10 moves APPROVE. |
| `2026-08-20-high-leverage-ux-portfolio-spec.md` | SHIPPED. Portfolio overview for the same cluster. |
| `2026-08-20-ux-01..10-*.md` (10 files) | SHIPPED, all ten. Each has a matching post-implementation audit — archived at `docs/evals/_archive/ux-high-leverage/` — recording APPROVE with zero critical findings and landing evidence. |
| `2026-08-21-camera-first-personal-cellar-*.md` (4 files) | Superseded input. All landed as discovery in `d46c813`; the decision chain ends at `docs/plans/2026-08-28-camera-first-decisions-recorded.md`, which is still active. Note `tenant_kind` from D-001 appears nowhere in the tree — decisions recorded, not built. |
| `2026-08-21-mobile-demo-production-readiness-spec.md` | Event passed. Scoped to a 2026-08-22 demonstration. Its durable rule — 44px touch targets, 390×844 / 430×932 viewports — now lives in `docs/CONVENTIONS.md`. |
| `2026-08-23-p3-chunked-import.md` | SHIPPED through migration `0111`. |
| `2026-08-25-production-audit-loop.md` | SHIPPED. All 10 findings remediated; one (LWIN fixture licensing) is an explicit owner gate, not a silent pass. |
| `2026-08-25-spike-01-stt-vendor-eval.md` | CLOSED 2026-08-25, audited (GPT-5.6 Sol) + remediated. Verdict recorded: VWP-D-02 = AssemblyAI. Consequences folded into `docs/evals/vwp-evals.yaml` (SPEC-19/21/22). |
| `2026-08-25-spike-05-ddgs-soak.md` | CLOSED 2026-08-25. Verdict recorded: DDGS viable as a cascade tier (94.0 % ok / 0 empty over 500); mandatory per-query retry folded into SPEC-04. |
| `2026-08-25-spike-06-scan-latency.md` | CLOSED 2026-08-25. Verdict recorded: RTX 4090-class box sufficient (warm e2e p50 0.18 s); cold start makes SPEC-23 prewarm a quantified hard requirement. |
| `2026-08-25-spike-07a-lightglue-survival.md` | CLOSED 2026-08-25 (the 7a synthetic half). Verdict recorded: LightGlue rerank viable; the failure mode is candidate nomination. **7b — real phone captures — is still open and lives in the spec-list §3 register, not here.** |
| `2026-08-25-spike-09-voice-retrieval-eval.md` | CLOSED 2026-08-25. Eval constructed and baselined; forces the producer-corroboration/margin rule into the resolver. |
| `2026-08-25-spike-resources-status.md` | Point-in-time status. A 2026-08-25 snapshot of which spike resources were provisioned; its durable outcomes (AssemblyAI selected, GWS dropped) are recorded in the spec-list §3 register and in `docs/evals/vwp-evals.yaml`. |
| `2026-08-27-camera-first-owner-decisions-brief.md` | Self-labeled superseded 2026-08-28 by its own header. |
| `2026-08-28-import-platform-decisions-recorded.md` | SHIPPED. D-A1/D-A2 both landed — `0127_match_lwin_deterministic_tiebreak.sql`, commit `528712a`. |
