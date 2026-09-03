-- 0150_seed_notes_from_tasting_notes.sql
--
-- Moves the legacy free-text `wines.tasting_notes` into the house corpus, and
-- makes an unattributed note representable.
--
-- WHY author_user_id BECOMES NULLABLE
-- -----------------------------------
-- `wines.tasting_notes` carries no author. It is one text column per wine,
-- written by whoever was editing the wine, and nothing recorded who. Seeding it
-- under the restaurant owner's id would put words in a named person's mouth —
-- exactly the small dishonesty the wine page's whole design exists to remove
-- (D7 in docs/superpowers/specs/2026-09-03-wine-page-design.md). A legacy note
-- genuinely has no author, so the column is made to say so.
--
-- This does NOT weaken attribution on new notes. The INSERT policy from 0148
-- still requires `author_user_id = auth.uid()`, and a null fails that check, so
-- no signed-in caller can write an unattributed note. Only the service role —
-- which is what runs this migration — can, and that is the point.
--
-- WHY wines.tasting_notes IS NOT DROPPED
-- --------------------------------------
-- Old code still reads it during the deploy window, and the cellar drawer reads
-- it today. Leaving the column costs nothing; a later migration removes it once
-- no reader remains. Per AGENTS.md non-negotiable #7, this migration has to be
-- safe against a database the old code is still talking to, and it is: it adds
-- rows to a table old code does not know about and relaxes one constraint.
--
-- RE-RUNNABILITY
-- --------------
-- The `not exists` guard makes this safe to re-run, which matters because it is
-- replayed on every local `supabase db reset`. Without it a second run would
-- silently double every seeded note and, with it, every mention count built on
-- them later.

alter table public.wine_notes
  alter column author_user_id drop not null;

comment on column public.wine_notes.author_user_id is
  '0150 — null ONLY for notes seeded from the legacy wines.tasting_notes field, which carried no author. The 0148 INSERT policy still requires author_user_id = auth.uid(), so no signed-in caller can write an unattributed note.';

insert into public.wine_notes (restaurant_id, wine_id, author_user_id, body, created_at)
select w.restaurant_id, w.id, null, btrim(w.tasting_notes), w.created_at
  from public.wines w
 where w.tasting_notes is not null
   and length(btrim(w.tasting_notes)) > 0
   and not exists (
     select 1 from public.wine_notes n
      where n.wine_id = w.id
        and n.author_user_id is null
        and n.body = btrim(w.tasting_notes)
   );
