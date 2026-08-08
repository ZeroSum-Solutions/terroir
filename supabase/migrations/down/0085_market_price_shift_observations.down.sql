drop trigger if exists wines_capture_previous_retail_median on public.wines;
drop function if exists public.capture_previous_retail_median();

alter table public.wines
  drop column if exists retail_previous_median,
  drop column if exists retail_previous_refreshed_at;
