# Migration numbering history

This is a factual record of a duplicate-migration-number incident and how it
was resolved. It documents what happened; it is not a live index of migration
files. Always check `ls supabase/migrations/` for the current state.

## What happened

On 2026-05-23, two feature slices landed within roughly two hours of each
other and independently claimed the same sequence numbers for their
migrations, because both branched from the same tip and neither was aware of
the other's in-flight migration:

- **`0046` collided:**
  - `42ea0e5` (04:18 +0100) "feat: edit wine metadata, tasting notes, and
    hero image upload" added `supabase/migrations/0046_wines_tasting_notes_hero_image.sql`.
  - `6d1889c` (04:41 +0100) "feat: reconcile shows format, opened_at,
    tracked oz, variance per bottle" added
    `supabase/migrations/0046_reconcile_availability_events.sql`.
- **`0049` collided:**
  - `40a36de` (05:54 +0100) "feat: features #92, #94, #95 - scan review with
    format/currency support" added
    `supabase/migrations/0049_inventory_items_format_currency.sql`.
  - `cdf7d89` (06:11 +0100) "feat: LWIN catalog fallback enrichment with
    colour column (#77)" added `supabase/migrations/0049_wines_colour.sql`.

Both members of each pair merged to shared history with the same numeric
prefix present twice in `supabase/migrations/`.

## How it was resolved

Two repair passes renumbered the migration that had **not yet been applied**
under its original number, moving it forward to an unused slot at the tail of
the sequence. The migration that had already been applied under its original
number kept that number — the fix never renumbers an applied migration.

- `d28d8f0` / `8086a78` (2026-08-07, "fix: repair local Supabase migration
  baseline") — same fix cherry-picked/rebased onto two different branches
  (`fix/ter-00x-migration-baseline` and an integration branch merged into
  `staging`), same author date, different trees/parents. This is parallel
  branch propagation of one logical fix, not a second collision.
- `f923e75` (2026-08-21, "fix: repair migration sequencing and grants",
  merged to `main`) — the version of the fix that landed on `main`.

Net result on `main`:

| Original path | Resolution |
|---|---|
| `0046_wines_tasting_notes_hero_image.sql` | renamed to `0072_wines_tasting_notes_hero_image.sql` |
| `0046_reconcile_availability_events.sql` | kept `0046` (unchanged) |
| `0049_inventory_items_format_currency.sql` | renamed to `0073_inventory_items_format_currency.sql` |
| `0049_wines_colour.sql` | kept `0049`, content trimmed by ~30 lines (the `manual_overrides` column and `add_manual_overrides` RPC were split out; `enrich_wines_batch` in `0049_wines_colour.sql` now extends the "0048 manual-override-aware" RPC instead of redefining it) |

`0038` was also touched in the same repair pass (renamed to
`0038_pour_events_open_bottle_id.sql`, a descriptive-suffix fix, not a number
collision) and a new `0074_public_api_grants.sql` was added alongside the
`main`-branch version of the fix.

As of 2026-08-22, `ls supabase/migrations/` shows exactly one file per
numeric prefix — no duplicates remain on `main`.

## The rule going forward

1. **Never renumber a migration that has already been applied** to any
   environment (local dev counts once teammates have pulled it, staging, or
   production). If two migrations collide on a number and one has already
   been applied, only the *unapplied* one moves — to the next free number at
   the tail of the sequence, never by re-slotting into a gap.
2. **Never parallelize two slices that both write new migrations** without
   coordinating the next number first (e.g. claim the number in the PR
   description, or serialize migration-adding work through one branch at a
   time). This incident happened because two feature branches both forked
   from the same tip and both incremented the sequence independently.
3. Before opening a PR that adds a migration, run
   `ls supabase/migrations/ | sort` against `main` to confirm the chosen
   number isn't already claimed by another in-flight branch.
