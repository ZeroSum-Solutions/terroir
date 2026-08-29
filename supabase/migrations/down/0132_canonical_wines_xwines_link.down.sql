drop function if exists public.match_xwines(text, text, float);

drop index if exists public.canonical_wines_xwines_wine_id_idx;

alter table public.canonical_wines
  drop column if exists xwines_match_score,
  drop column if exists xwines_wine_id;
