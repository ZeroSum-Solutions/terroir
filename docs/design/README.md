# Archived design systems — do not build from these

The current design contract is **`DESIGN.md` at the repo root**. It is the only
design document any tooling reads, and the only one enforced by
`pnpm check:design`.

Both files in this directory are superseded predecessors, kept for lineage:

| File | What it was | Why it is dead |
|---|---|---|
| `DESIGN-cantina-2026-08-26.md` | The **Cantina** system, the predecessor palette | Its own tokens — `gold: #786218`, cream `#E3D9CB` — are now explicitly *rejected* by `scripts/check-design-palette.mjs`, which bans brown and cream. Building from this file produces a CI failure. |
| `DESIGN-nocturne-typography-2026-08-29.md` | An intermediate Nocturne draft from the same day as the final | Pre-dates the final token renames (`hairline` / `hairline-strong` here vs. the shipped `rule` / `rule-strong` / `edge`). Its own frontmatter description still says "Didone set in wide capitals" — the direction its own body argues *against*. |

All three documents landed in commit `8c777d5`, "Nocturne: rewrite the design system,
and make it enforceable (#151)".
