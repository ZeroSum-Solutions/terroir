# Production audit loop — feat/visual-wine-platform (2026-08-25 overnight)

Scope: the full branch diff (main..HEAD) across four dimensions — cross-document
quantitative consistency, commit-message claims vs. artifacts, repo-convention
integration, and safety/licensing — each reviewed by an independent agent and every
finding adversarially re-verified before counting. Complements (does not repeat) the
same night's three-round GPT-5.6 Sol adversarial loop on the two new deliverables
(`docs/evals/vwp-evals.yaml`; `src/lib/wine-intelligence/name-resolver.*`), which ended
REVERIFY: CLOSED.

## Gates (mechanical, run on the branch)

| gate | result |
|---|---|
| `npm run lint` | 0 errors (6 pre-existing warnings, all on files this branch never touched) |
| `npm test` | 1,872 passed / 33 skipped |
| `npm run test:contracts` | pass |
| `npm run snapshot:check` | clean |
| `npm run downs:check` | pass (90 paired downs) |
| `npm run verify:feature-ledger` | pass (269 features) |
| `npm run types:check` | not runnable in the session (Supabase env not exposed); the branch touches no generated types — re-run before landing |

## Confirmed findings and their dispositions (10 confirmed, 0 refuted by verifiers)

1. **Register misquoted spike 9's discrimination number (98 % vs the measured 92 %)** —
   fixed in the register row.
2. **PRD VWP-FR-011 / risk R2 still carried the "WineSensed evaluation benchmark"
   framing spike 4 retracted** — corrected in place with a dated, attributed errata
   note (the PRD is pre-approval; the correction is visible, not silent).
3. **Status doc called the spike-9 replay the resolver's "acceptance harness"** while
   the code/tests correctly label it a tuning fixture — status doc now says TUNING
   harness, SPEC-21 sealed holdout = acceptance.
4. **Register conflated spike 1's two margins** (+18.8 pp was paired with the
   producer-gated p-value; that condition measures +17.2 pp) — both margins now stated.
5. **Stale eval-suite count in the status doc** (69 evals/12 slices from the
   pre-remediation file) — updated to the current 93 evals / 20 sections.
6. **Spike-9 doc quoted the pre-scorer-fix Fanti similarity (0.53) where the artifact
   says 0.59** — corrected with both values labeled.
7. **Contact/account addresses committed in a planning doc** — scrubbed; operational
   account detail moved to the local (out-of-repo) handoff note.
8. **Account-security posture narrative committed in the same doc** — moved out of the
   repo entirely; a pointer remains.
9. **Fixture licensing exposure**: the resolver's tuning fixture embeds 250
   production-catalog rows (LWIN ids + names). LWIN redistribution terms are
   unverified — an owner decision is recorded in `fixtures/generate.py` and gates any
   push of this branch to the public remote. *Resolved 2026-08-26: owner made the
   repo PRIVATE; the note in `generate.py` is downgraded to a release-time check
   (re-verify LWIN terms before any future public release or product exposure).*
10. **Licensing-posture wording contradiction** between the master task list
    ("deliberately ignored this phase") and the PRD's NFR-5 containment — reconciled:
    deferral stands as the owner-stated posture; NFR-5 isolation is the mechanism that
    keeps it reversible, and the task-list header now says so.

Findings 1–8 and 10 are remediated in this commit series; finding 9 is an explicit
owner gate, not silently resolved.

## Reproduce

The four-dimension fan-out + verification ran as a session workflow (script retained in
the session workspace); gates reproduce with the npm commands above.
