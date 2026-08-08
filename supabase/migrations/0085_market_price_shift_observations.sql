-- TER-CF-169: retain the prior market observation so the UI can distinguish
-- market movement from the separate last-paid-versus-market variance metric.

alter table public.wines
  add column retail_previous_median numeric(10,2),
  add column retail_previous_refreshed_at timestamptz;

comment on column public.wines.retail_previous_median is
  'Immediately previous positive retail median, retained when the current median changes.';
comment on column public.wines.retail_previous_refreshed_at is
  'Observation time associated with retail_previous_median.';

create or replace function public.capture_previous_retail_median()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.retail_median is distinct from old.retail_median
     and old.retail_median is not null
     and old.retail_median > 0 then
    new.retail_previous_median := old.retail_median;
    new.retail_previous_refreshed_at := old.retail_refreshed_at;
  end if;
  return new;
end;
$$;

revoke all on function public.capture_previous_retail_median() from public;

create trigger wines_capture_previous_retail_median
  before update of retail_median on public.wines
  for each row execute function public.capture_previous_retail_median();
