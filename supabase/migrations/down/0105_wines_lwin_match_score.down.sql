-- Reverse of 0105_wines_lwin_match_score.sql

alter table public.wines
  drop column if exists lwin_match_score;
