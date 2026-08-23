# Camera-First Personal Cellar Audit and Final Verification Record

Status: `PASS` after two revision audits and a clean Grok 4.6 re-audit

Hard gate: no implementation or deployment is authorized by this record

## Package under review

- `docs/plans/2026-08-21-camera-first-personal-cellar-discovery-reconstruction.md`
- `docs/plans/2026-08-21-camera-first-personal-cellar-prd.md`
- `docs/plans/2026-08-21-camera-first-personal-cellar-implementation-spec.md`

Repository baseline: `f0e542a848390b76407490c84f14bfad1ed29a29`, matching `origin/main` when discovery started.

## Independent audit execution

- Required model: `x-ai/grok-4.6`
- Provider reported by OpenRouter: `xAI`
- Completed audit response ID: `gen-1787356569-nJ6YxVtUJeEyXNFpBPJE`
- Initial verdict: `REVISE`
- Usage: 12,636 prompt tokens, 17,111 completion tokens including 13,492 reasoning tokens
- Cost reported by OpenRouter: $0.127746

An earlier vault-alias attempt returned HTTP 401 and produced no audit. The first authenticated full-size request then timed out after 300 seconds with an incomplete response and was not counted. The completed audit above used the same evidence, model, verdict rules, and repository-by-repository contract with a tighter output cap.

## Initial Grok findings and dispositions

| ID | Severity | Finding | Disposition | Resulting change |
|---|---|---|---|---|
| F-01 | Blocking | The trigram baseline needed to decide semantic search was itself blocked by the semantic-search decision. | Accepted | Split D-006 into D-006a baseline and D-006b semantic/conversational architecture. WS-05 may implement only the approved baseline before D-006b. |
| F-02 | Important | WS-01 and WS-02 both claimed exclusive migration/RLS ownership. | Accepted | WS-02 is now the only migration, SQL/RLS, snapshot, and generated-type editor. WS-01 supplies the security contract and tests. |
| F-03 | Important | Invoice canonicalization and bottle-scan save ownership overlapped. | Accepted | WS-03 now owns invoice paths only. WS-04 exclusively owns bottle-scan and `save-bottle-scan` behavior. Invoice canonicalization moved after the first schema contract and before expected cases. |
| F-04 | Important | Security-definer RPC hardening had two owners and could land after search expansion. | Accepted | WS-01 specifies the hardening, WS-02 lands its SQL migration, and WS-05 remains blocked until the frozen RPC contract exists. |
| F-05 | Important | Provider and sharing acceptance were unconditional despite unresolved D-007/D-008. | Accepted | PCI-FR-014/015 and AC11/12 are conditional. Core completion does not require a provider adapter or sharing unless the matching decision is approved. FR-010 uses membership-scoped invoice access in the core slice. |
| F-06 | Important | AC8 could be read to require conversational retrieval in the typo-tolerant baseline. | Accepted | AC8 now covers typo/diacritic/ambiguity and structured period/color filters. Conversational compilation is isolated to AC9 after D-006b. |
| F-07 | Important | The first one-label slice was blocked by later multi-object, count, and hierarchy decisions. | Accepted with qualification | The proposed first-slice contract is one label, user-confirmed quantity, existing bins or unplaced state, and no photo-derived counts. WS-00 must record owner approval before these become source requirements. Later expansion remains open. |
| F-08 | Important | Evidence-photo retention, deletion, bucket, URL, and logging policy lacked a decision gate. | Accepted | Added D-010. WS-01 owns the policy/tests, WS-02 owns storage metadata migrations, and WS-04 cannot persist evidence before approval. |
| F-09 | Important | Match ranking, one-tap acceptance, and calibrated confidence were not testable. | Accepted | Added D-011 with candidate/ranking thresholds, warning behavior, correction, and fixture requirements. The current `0.75` warning is not treated as calibration. |
| F-10 | Important | Worker, distributed cost control, and staging repair lacked clear owners. | Accepted | WS-04 owns a bounded synchronous first slice with a documented tenant-aware in-process quota and graceful refusal. Added optional WS-10 for a real worker/distributed limiter. WS-09 owns staging readiness, subject to authorization. |
| F-11 | Advisory | Location selection order differed across documents. | Accepted | Location may be preselected or chosen at confirmation. Returning to capture preserves the last selected location. |
| F-12 | Advisory | Purchase evidence could be read to auto-create a case. | Accepted | Purchase evidence creates an expected-case proposal only unless the owner records a different rule. |
| F-13 | Advisory | Capture session resume persistence was unspecified. | Accepted | The first slice keeps ordered results only while the scan view remains mounted. Offline/refresh resume requires a later approved draft record. |
| F-14 | Advisory | Reusing restaurant tenancy could erase the distinct personal workflow principle. | Accepted | Added an acceptance criterion that restaurant journeys remain unchanged unless the owner approves a shared-domain migration. D-001 retains all three options. |
| F-15 | Advisory | API4AI examples could imply replacing the existing vision provider in the first slice. | Accepted | Phase 2 explicitly extends the current Anthropic path. A different hosted vision vendor requires a later decision, privacy policy, terms, and bake-off. |
| F-16 | Advisory | The canonical drink-alert module was inconsistent in supplied evidence. | Accepted and live-verified | Live `rg` confirmed `src/lib/drink-window/alerts.ts` and its imports from the alert API and insights page. WS-06 now owns that exact file. |
| F-17 | Advisory | WS-00 could add gated later-phase requirements before their decisions existed. | Accepted | WS-00 now lists a narrow candidate first-slice subset and defers case, semantic, provider, and sharing requirements until their decisions are recorded. |

## Candidate repository and dataset audit disposition

Grok audited every candidate named in the PRD. Its conclusions matched the exact-revision review and required no relaxation:

| Candidate | Grok disposition | Package disposition after audit |
|---|---|---|
| CellarBoss | Conditional, behavior study only because GPL-3.0 compatibility is unresolved | Retained as concept evidence only; no code copy |
| Kellerlog | Conditional, ideas only because the README claim lacks a complete license grant | Retained as UX reference only; no code/assets |
| Glou | Conditional, closest pattern fit after exact-file, dependency, security, and attribution review | Retained as highest-priority code-reading candidate; no wholesale transplant |
| WineDB | Conditional, open sample study only; row rights and commercial terms unverified | No production seed; separate provenance and license evaluation required |
| API4AI examples/service | Conditional, MIT sample code separated from hosted vendor terms | Integration pattern only; no service selection |
| OpenWines | Conditional for MIT OCR/Ontology historical study; reject unclear-license image/data repositories | No production import |
| InvenTree | Conditional, domain concepts only | No Django/general inventory adoption |
| WGISD | Reject, noncommercial and wrong visual domain | Excluded from training, evaluation, and redistribution |

## Supported changes not taken

None. Every blocking and important finding was supported by the supplied package and incorporated. Advisory findings were incorporated where they removed ambiguity without adding scope.

## First re-audit execution and dispositions

- Model: `x-ai/grok-4.6`
- Provider reported by OpenRouter: `xAI`
- Response ID: `gen-1787357194-DQak4eX85h2qe0xwNTcN`
- Verdict: `REVISE`
- Usage: 15,724 prompt tokens, 12,883 completion tokens including 11,204 reasoning tokens
- Cost reported by OpenRouter: $0.108554

Grok marked F-01 through F-06, F-08 through F-15, and F-17 resolved. It marked F-07 and F-16 partial, then added four important and two advisory findings.

| ID | Severity | Finding | Disposition | Resulting change |
|---|---|---|---|---|
| F-07 follow-up | Partial | WS-00 and the logical model still tied the first slice to later D-002/D-003/D-005 decisions. | Accepted | WS-00 now requires recorded first-slice constraints, while the logical model explicitly separates existing-bin/unplaced placement from later D-005 hierarchy. |
| F-16 follow-up | Partial | A stale `src/lib/wine-intelligence/alerts.ts` citation remained. | Accepted | The affected-area table now lists the live-verified `src/lib/drink-window/alerts.ts` and `status.ts` paths only. |
| N-01 | Important | WS-00 could source-contract first-slice requirements before D-006a, D-009, D-010, and D-011. | Accepted | WS-00's proceed gate now lists every required first-slice decision and constraint approval explicitly. |
| N-02 | Important | The logical data introduction still made D-005 a first-slice dependency. | Accepted | Logical data is split into a first-slice minimum and later D-005/D-007/D-008 records. |
| N-03 | Important | PCI-FR-002 still allowed first-slice location/container creation. | Accepted | PCI-FR-002 and workflow 1 now limit the first slice to an existing bin or unplaced queue. Creation/hierarchy is gated by D-005. |
| N-04 | Important | Bottle, search, invoice, and schema ownership could still overlap. | Accepted | WS-04 owns bottle-only files, WS-03 invoice-only files, WS-05 TypeScript/API/UI/evals only, and WS-02 remains the sole SQL/index/RPC/migration owner throughout the initiative. |
| N-05 | Advisory | The unresolved meaning of "why did I buy this?" was absent from the PRD. | Accepted | Added it to the PRD risk/decision table; no rationale feature is inferred. |
| N-06 | Advisory | Workflow 1 still implied location must precede photography. | Accepted | Workflow 1 now permits location selection before or at confirmation and preserves the first-slice existing-bin boundary. |

## Clean re-audit

- Model: `x-ai/grok-4.6`
- Provider reported by OpenRouter: `xAI`
- Response ID: `gen-1787357485-0w542mKA7WDS3RddImY7`
- Verdict: `APPROVE`
- New findings: none
- Usage: 16,660 prompt tokens, 16,813 completion tokens including 15,759 reasoning tokens
- Cost reported by OpenRouter: $0.134006

The clean re-audit marked F-07, F-16, and N-01 through N-06 resolved. It confirmed the eight candidate-group dispositions without change. It found the package implementable after the named owner decisions, narrow `app_spec.txt` amendment, and frozen first-slice contracts. It explicitly did not authorize implementation, migrations, staging, deployment, or external code/data import.

## Final verification checklist

- [x] Grok 4.6 clean re-audit returned `APPROVE`.
- [x] Every initial blocking and important finding was incorporated.
- [x] Every external candidate has an explicit disposition and guardrail.
- [x] Transcript reconstruction keeps exploratory ideas and open questions distinct from approved decisions.
- [x] PRD acceptance criteria distinguish core and conditional gates.
- [x] Implementation ownership leaves one schema/migration editor and no overlapping invoice/bottle/search-security ownership.
- [x] The plan aligns to Terroir's existing gauntlet protocol without reusing completed Top-10 acceptance criteria.
- [x] No production code, migration, staging, deployment, commit, or external repository code/data import occurred.
- [x] Final files are readable, contain no unresolved placeholder markers, and match the verified repository baseline.

Final verification result: `PASS`
