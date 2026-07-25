-- Focused acceptance for 0068_reorder_wine_list_sections.sql.
-- Run against an isolated database with migrations through 0068 applied.

begin;

create or replace function pg_temp.expect_failure(
  p_sql text,
  p_sqlstate text
) returns void
language plpgsql
as $$
declare
  v_sqlstate text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    if v_sqlstate <> p_sqlstate then
      raise exception
        'expected SQLSTATE %, received % for %',
        p_sqlstate,
        v_sqlstate,
        p_sql;
    end if;
    return;
  end;
  raise exception 'expected statement to fail: %', p_sql;
end;
$$;

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '66000000-0000-4000-8000-000000000001',
    'manager-0068@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '66000000-0000-4000-8000-000000000002',
    'outsider-0068@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '66000000-0000-4000-8000-000000000003',
    'staff-0068@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  (
    '66100000-0000-4000-8000-000000000001',
    'Section Order Restaurant'
  ),
  (
    '66100000-0000-4000-8000-000000000002',
    'Other Section Restaurant'
  );

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '66000000-0000-4000-8000-000000000001',
    '66100000-0000-4000-8000-000000000001',
    'manager'
  ),
  (
    '66000000-0000-4000-8000-000000000003',
    '66100000-0000-4000-8000-000000000001',
    'staff'
  );

insert into public.wine_lists (id, restaurant_id, name) values
  (
    '66200000-0000-4000-8000-000000000001',
    '66100000-0000-4000-8000-000000000001',
    'Dinner'
  ),
  (
    '66200000-0000-4000-8000-000000000002',
    '66100000-0000-4000-8000-000000000002',
    'Other Dinner'
  );

insert into public.wine_list_sections (
  id,
  wine_list_id,
  name,
  position
) values
  (
    '66300000-0000-4000-8000-000000000001',
    '66200000-0000-4000-8000-000000000001',
    'First',
    0
  ),
  (
    '66300000-0000-4000-8000-000000000002',
    '66200000-0000-4000-8000-000000000001',
    'Second',
    1
  ),
  (
    '66300000-0000-4000-8000-000000000003',
    '66200000-0000-4000-8000-000000000001',
    'Third',
    2
  ),
  (
    '66300000-0000-4000-8000-000000000004',
    '66200000-0000-4000-8000-000000000002',
    'Foreign',
    0
  );

-- Supabase's migration role supplies these table grants by default. State
-- them explicitly so the focused test also runs in a cloned bare database.
grant select, insert, update on public.wine_list_sections to authenticated;
grant select, update on public.wine_lists to authenticated;

do $$
begin
  if has_function_privilege(
    'anon',
    'public.create_wine_list_section(uuid,uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'anon retains section-create execution';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.create_wine_list_section(uuid,uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks section-create execution';
  end if;
  if has_function_privilege(
    'anon',
    'public.reorder_wine_list_sections(uuid[])',
    'EXECUTE'
  ) then
    raise exception 'anon retains section-reorder execution';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.reorder_wine_list_sections(uuid[])',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks section-reorder execution';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '66000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

select public.reorder_wine_list_sections(array[
  '66300000-0000-4000-8000-000000000003'::uuid,
  '66300000-0000-4000-8000-000000000001'::uuid,
  '66300000-0000-4000-8000-000000000002'::uuid
]);
select public.reorder_wine_list_sections(array[
  '66300000-0000-4000-8000-000000000003'::uuid,
  '66300000-0000-4000-8000-000000000001'::uuid,
  '66300000-0000-4000-8000-000000000002'::uuid
]);

do $$
begin
  if (
    select array_agg(id order by position)
    from public.wine_list_sections
    where wine_list_id = '66200000-0000-4000-8000-000000000001'
  ) <> array[
    '66300000-0000-4000-8000-000000000003'::uuid,
    '66300000-0000-4000-8000-000000000001'::uuid,
    '66300000-0000-4000-8000-000000000002'::uuid
  ] then
    raise exception 'repeated section reorder did not converge';
  end if;

  perform pg_temp.expect_failure(
    $sql$
      select public.reorder_wine_list_sections(array[
        '66300000-0000-4000-8000-000000000001'::uuid,
        '66300000-0000-4000-8000-000000000004'::uuid
      ])
    $sql$,
    'T2102'
  );
  perform pg_temp.expect_failure(
    $sql$
      select public.reorder_wine_list_sections(array[
        '66300000-0000-4000-8000-000000000001'::uuid,
        '66300000-0000-4000-8000-000000000001'::uuid
      ])
    $sql$,
    'T2101'
  );
  perform pg_temp.expect_failure(
    $sql$
      select public.reorder_wine_list_sections(array[
        '66300000-0000-4000-8000-000000000003'::uuid,
        '66300000-0000-4000-8000-000000000001'::uuid
      ])
    $sql$,
    'T2103'
  );
end;
$$;

reset role;

do $$
begin
  if (
    select array_agg(id order by position)
    from public.wine_list_sections
    where wine_list_id = '66200000-0000-4000-8000-000000000001'
  ) <> array[
    '66300000-0000-4000-8000-000000000003'::uuid,
    '66300000-0000-4000-8000-000000000001'::uuid,
    '66300000-0000-4000-8000-000000000002'::uuid
  ] then
    raise exception 'failed mixed-list reorder changed positions';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '66000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
select pg_temp.expect_failure(
  $sql$
    select public.reorder_wine_list_sections(array[
      '66300000-0000-4000-8000-000000000001'::uuid
    ])
  $sql$,
  'T2102'
);
select pg_temp.expect_failure(
  $sql$
    select public.create_wine_list_section(
      '66100000-0000-4000-8000-000000000001'::uuid,
      '66200000-0000-4000-8000-000000000001'::uuid,
      'Outsider Section'
    )
  $sql$,
  'T2105'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '66000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;
select pg_temp.expect_failure(
  $sql$
    select public.reorder_wine_list_sections(array[
      '66300000-0000-4000-8000-000000000003'::uuid,
      '66300000-0000-4000-8000-000000000001'::uuid,
      '66300000-0000-4000-8000-000000000002'::uuid
    ])
  $sql$,
  'T2104'
);
select pg_temp.expect_failure(
  $sql$
    select public.create_wine_list_section(
      '66100000-0000-4000-8000-000000000001'::uuid,
      '66200000-0000-4000-8000-000000000001'::uuid,
      'Staff Section'
    )
  $sql$,
  'T2106'
);
reset role;

create or replace function pg_temp.reject_second_section_update_0068()
returns trigger
language plpgsql
as $$
begin
  if new.id = '66300000-0000-4000-8000-000000000002'::uuid then
    raise exception using
      errcode = '40001',
      message = 'forced section reorder failure';
  end if;
  return new;
end;
$$;

create trigger reject_second_section_update_0068
before update on public.wine_list_sections
for each row
execute function pg_temp.reject_second_section_update_0068();

select set_config(
  'request.jwt.claim.sub',
  '66000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
select pg_temp.expect_failure(
  $sql$
    select public.reorder_wine_list_sections(array[
      '66300000-0000-4000-8000-000000000002'::uuid,
      '66300000-0000-4000-8000-000000000003'::uuid,
      '66300000-0000-4000-8000-000000000001'::uuid
    ])
  $sql$,
  '40001'
);
reset role;

do $$
begin
  if (
    select array_agg(id order by position)
    from public.wine_list_sections
    where wine_list_id = '66200000-0000-4000-8000-000000000001'
  ) <> array[
    '66300000-0000-4000-8000-000000000003'::uuid,
    '66300000-0000-4000-8000-000000000001'::uuid,
    '66300000-0000-4000-8000-000000000002'::uuid
  ] then
    raise exception 'forced failure partially changed section positions';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '66000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
select *
from public.create_wine_list_section(
  '66100000-0000-4000-8000-000000000001',
  '66200000-0000-4000-8000-000000000001',
  'Fourth'
);
reset role;

do $$
begin
  if (
    select position
    from public.wine_list_sections
    where wine_list_id = '66200000-0000-4000-8000-000000000001'
      and name = 'Fourth'
  ) <> 3 then
    raise exception 'section create did not allocate the next stable position';
  end if;
end;
$$;

rollback;
