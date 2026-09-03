-- Down for 0150.
--
-- Deletes only the unattributed seed rows whose body still matches the legacy
-- field they came from. A seeded note somebody has since edited no longer
-- matches and is left alone — it is now user-authored content, and reverting a
-- seed must not destroy it.
--
-- Restoring the NOT NULL will fail if any unattributed note survives that
-- filter. That is the constraint telling you an edited legacy note exists;
-- decide about it deliberately rather than forcing the column back.

delete from public.wine_notes n
 using public.wines w
 where n.wine_id = w.id
   and n.author_user_id is null
   and w.tasting_notes is not null
   and n.body = btrim(w.tasting_notes);

alter table public.wine_notes
  alter column author_user_id set not null;
