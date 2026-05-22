-- 0034_eightysix_strategy.sql
-- Add eightysix_strategy column to restaurants to control how 86d wines
-- appear on published wine lists:
--   'hide' (default) -- 86d wines are removed from /list/[slug]
--   'mark'           -- 86d wines are shown with gray/strikethrough styling

alter table public.restaurants
  add column eightysix_strategy text not null default 'hide'
  check (eightysix_strategy in ('hide', 'mark'));
