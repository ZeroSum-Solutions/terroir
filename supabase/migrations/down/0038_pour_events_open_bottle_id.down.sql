-- 0038_pour_events_open_bottle_id.down.sql
alter table public.pour_events drop column if exists open_bottle_id;
