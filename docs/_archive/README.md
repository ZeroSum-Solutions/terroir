# Archive — historical evidence only

Nothing in this directory describes the current system. These files are retained as
a record of how the project got here, and several of them contain claims the code now
contradicts. **Do not use anything here to answer a question about how Terroir works
today.**

Current authorities:

| Question | Authority |
|---|---|
| What is the architecture? | `docs/ARCHITECTURE.md` |
| What are the conventions? | `docs/CONVENTIONS.md` |
| What is built and shipped? | `docs/feature-ledger.json` |
| What does the design system say? | `DESIGN.md` (repo root) |
| How do I work in this repo? | `AGENTS.md` (repo root) |

## Contents

| File | Was | Why archived |
|---|---|---|
| `PROJECT.md` | Auto-generated "Project Ledger" | Tool output, not hand-maintained; orphaned — linked from nothing. Redundant with `package.json` and `docs/ARCHITECTURE.md`. |
| `2026-08-21-camera-first-personal-cellar-inventory.md` | Discovery input | Self-labeled "not yet approved for implementation"; superseded by the same-day PRD and by `docs/plans/2026-08-28-camera-first-decisions-recorded.md`. |
| `planning-codebase-2026-05-01/` | Machine-generated scaffold snapshot (5 files) | Generated once on 2026-05-01 and never touched. Predates `src/domains/` and `src/adapters/` entirely. Known false claims: describes a `src/lib`-only tree; names class-variance-authority as the variant convention (CVA is not in this repo); states "no destructive down migrations" when `downs:check` in fact *requires* paired downs; gives the dead `NEXT_PUBLIC_SUPABASE_ANON_KEY`. The still-true parts were salvaged into `docs/CONVENTIONS.md` before archiving. |

## Deliberately NOT archived

`app_spec.txt` and `claude-progress.txt` stay at the repo root despite reading like
stale documents, because **they are machine-read**:

- `scripts/verify-feature-ledger.mjs:15` sets `SOURCE_FILE = "app_spec.txt"` and the
  ledger asserts `sourceFile must be app_spec.txt`. It is the requirement source for
  a CI gate, not a narrative spec.
- `src/lib/feature-ledger/verify-feature-ledger.test.ts` reads both files by path.

Moving either breaks the merge gate. They were moved here on 2026-08-29 and moved
straight back when `pnpm verify:feature-ledger` went red. Their *prose* is drifted —
`app_spec.txt` names the dead env var `NEXT_PUBLIC_SUPABASE_ANON_KEY` and points at
directories that do not exist — but their *structure* is load-bearing. Correct the
drift in place if you correct it at all; do not relocate them.
