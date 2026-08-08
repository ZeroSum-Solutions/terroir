-- Reverse TER-025 audited quantity adjustments only when no audit rows exist.

do $$
begin
  if exists (
    select 1 from public.availability_events where direction = 'adjustment'
  ) then
    raise exception 'cannot reverse 0080 while quantity adjustment audit events exist';
  end if;
end
$$;

drop function if exists public.adjust_cellar_quantity_idempotent(uuid,uuid,integer,text,text,text);

alter table public.availability_events
  drop constraint availability_events_direction_check;

alter table public.availability_events
  add constraint availability_events_direction_check
    check (direction in ('eightysixed', 'restored', 'reconcile'));

comment on column public.availability_events.delta is
  'Reconcile: old_remaining_ml - new_remaining_ml. Null for 86/restore events.';
