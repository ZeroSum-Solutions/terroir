-- TER-020D21 — atomically create and reorder wine-list sections.
--
-- Creation and reorder share a parent-list lock. A new section therefore
-- allocates its position after any in-flight reorder, while reorder persists
-- every submitted position in one statement.

create or replace function public.create_wine_list_section(
  p_restaurant_id uuid,
  p_wine_list_id uuid,
  p_name text
) returns table (
  id uuid,
  wine_list_id uuid,
  name text,
  "position" integer,
  created_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_position integer;
begin
  perform 1
  from public.wine_lists as list
  where list.id = p_wine_list_id
    and list.restaurant_id = p_restaurant_id
  for update;

  if not found then
    raise exception using
      errcode = 'T2105',
      message = 'wine list not found or inaccessible';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using
      errcode = 'T2106',
      message = 'manager role required';
  end if;

  select coalesce(max(section.position), -1) + 1
  into v_position
  from public.wine_list_sections as section
  where section.wine_list_id = p_wine_list_id;

  return query
  insert into public.wine_list_sections (
    wine_list_id,
    name,
    position
  ) values (
    p_wine_list_id,
    p_name,
    v_position
  )
  returning
    wine_list_sections.id,
    wine_list_sections.wine_list_id,
    wine_list_sections.name,
    wine_list_sections.position,
    wine_list_sections.created_at;
end;
$$;

create or replace function public.reorder_wine_list_sections(
  p_ordered_ids uuid[]
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_list_id uuid;
  v_restaurant_id uuid;
  v_input_len integer := coalesce(array_length(p_ordered_ids, 1), 0);
  v_match_count integer;
  v_total_count integer;
begin
  if v_input_len = 0 or v_input_len > 200 then
    raise exception using
      errcode = 'T2101',
      message = 'ordered section id count is invalid';
  end if;

  if v_input_len <> (
    select count(distinct section_id)
    from unnest(p_ordered_ids) as submitted(section_id)
  ) then
    raise exception using
      errcode = 'T2101',
      message = 'ordered section ids must be unique';
  end if;

  select list.id, list.restaurant_id
  into v_list_id, v_restaurant_id
  from public.wine_list_sections as section
  join public.wine_lists as list on list.id = section.wine_list_id
  where section.id = p_ordered_ids[1]
  for update of list;

  if v_list_id is null then
    raise exception using
      errcode = 'T2102',
      message = 'section not found or inaccessible';
  end if;

  if not public.is_member_with_role(v_restaurant_id, 'manager') then
    raise exception using
      errcode = 'T2104',
      message = 'manager role required';
  end if;

  -- Lock every current section in a deterministic order. Concurrent reorders
  -- therefore serialize instead of deadlocking, while concurrent deletes
  -- cannot invalidate the validated set between this check and the update.
  select count(*)
  into v_total_count
  from (
    select section.id
    from public.wine_list_sections as section
    where section.wine_list_id = v_list_id
    order by section.id
    for update
  ) as locked_sections;

  select count(*)
  into v_match_count
  from public.wine_list_sections as section
  where section.id = any(p_ordered_ids)
    and section.wine_list_id = v_list_id;

  if v_match_count <> v_input_len then
    raise exception using
      errcode = 'T2102',
      message = 'all sections must belong to one accessible wine list';
  end if;

  if v_total_count <> v_input_len then
    raise exception using
      errcode = 'T2103',
      message = 'ordered section ids must include the complete wine list';
  end if;

  update public.wine_list_sections as section
  set position = submitted.ordinality - 1
  from unnest(p_ordered_ids) with ordinality
    as submitted(section_id, ordinality)
  where section.id = submitted.section_id
    and section.wine_list_id = v_list_id;
end;
$$;

revoke all on function public.create_wine_list_section(
  uuid,
  uuid,
  text
) from public;
revoke all on function public.create_wine_list_section(
  uuid,
  uuid,
  text
) from anon;
grant execute on function public.create_wine_list_section(
  uuid,
  uuid,
  text
) to authenticated;

revoke all on function public.reorder_wine_list_sections(uuid[])
  from public;
revoke all on function public.reorder_wine_list_sections(uuid[])
  from anon;
grant execute on function public.reorder_wine_list_sections(uuid[])
  to authenticated;

comment on function public.create_wine_list_section(uuid, uuid, text) is
  'Creates a section at the next stable position under the parent-list lock.';

comment on function public.reorder_wine_list_sections(uuid[]) is
  'Atomically persists a validated, same-list section order under existing RLS.';
