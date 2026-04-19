-- 0007_lwin_matching.sql
-- LWIN fuzzy matching functions using pg_trgm trigram indexes
-- already on lwin_catalog (producer, display_name).

-- Single-wine match: returns best LWIN match above threshold
create or replace function public.match_lwin(
  p_producer  text,
  p_name      text,
  p_threshold float default 0.3
)
returns table (
  lwin_id      text,
  display_name text,
  producer     text,
  varietal     text,
  region       text,
  country      text,
  colour       text,
  score        float
)
language sql stable security definer set search_path = public
as $$
  select lc.lwin_id, lc.display_name, lc.producer, lc.varietal,
         lc.region, lc.country, lc.colour,
         (similarity(lower(p_producer), lower(lc.producer)) * 0.6 +
          similarity(lower(p_name), lower(lc.display_name)) * 0.4) as score
  from public.lwin_catalog lc
  where similarity(lower(p_producer), lower(lc.producer)) >= p_threshold
    and similarity(lower(p_name), lower(lc.display_name)) >= p_threshold * 0.7
  order by score desc
  limit 1;
$$;

revoke all on function public.match_lwin(text, text, float) from public;
grant execute on function public.match_lwin(text, text, float) to authenticated;

-- Batch match: loops through wine IDs, matches each against lwin_catalog,
-- updates wine with lwin_id + fills null country/region/varietal.
create or replace function public.match_lwin_batch(p_wine_ids uuid[])
returns table (wine_id uuid, lwin_id text, score float)
language plpgsql security definer set search_path = public
as $$
declare
  w record;
  m record;
begin
  for w in
    select id, producer, name, country, region, varietal
    from public.wines
    where id = any(p_wine_ids) and wines.lwin_id is null
  loop
    select * into m from public.match_lwin(w.producer, w.name);
    if m.lwin_id is not null then
      update public.wines set
        lwin_id  = m.lwin_id,
        country  = coalesce(wines.country, m.country),
        region   = coalesce(wines.region, m.region),
        varietal = coalesce(wines.varietal, m.varietal)
      where id = w.id;

      wine_id := w.id;
      lwin_id := m.lwin_id;
      score   := m.score;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function public.match_lwin_batch(uuid[]) from public;
grant execute on function public.match_lwin_batch(uuid[]) to authenticated;

-- Catalog search: fast trigram search for the add-wine modal autocomplete.
create or replace function public.lwin_search(p_query text, p_limit int default 20)
returns setof public.lwin_catalog
language sql stable security definer set search_path = public
as $$
  select *
  from public.lwin_catalog
  where producer % p_query or display_name % p_query
  order by greatest(
    similarity(lower(producer), lower(p_query)),
    similarity(lower(display_name), lower(p_query))
  ) desc
  limit p_limit;
$$;

revoke all on function public.lwin_search(text, int) from public;
grant execute on function public.lwin_search(text, int) to authenticated;
