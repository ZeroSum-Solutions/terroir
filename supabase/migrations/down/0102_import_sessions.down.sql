-- Reverse of 0102_import_sessions.sql
--
-- Plain DROP TABLE: nothing else references import_sessions yet at this
-- point in the migration sequence (import_batches.session_id is added by
-- 0103, which must be downed first — see down/0103's own header).

drop table if exists public.import_sessions;
