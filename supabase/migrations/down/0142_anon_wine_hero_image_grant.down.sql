-- Revoke the single column 0142 published to anon, returning `wines` to
-- 0081's ten-column list.
--
-- Column-level REVOKE is the exact inverse of a column-level GRANT here, so
-- this removes only hero_image_url and leaves 0081's columns untouched.
-- Reverting means published menus stop showing bottle photographs — the
-- images 404 for guests rather than the page failing, because the column
-- simply becomes unreadable and the query that selects it must be reverted
-- with it.
revoke select (hero_image_url) on table public.wines from anon;
