-- Reverse of 0055_api_rate_limits.sql.

do $$
declare
  v_job_id bigint;
begin
  select jobid
  into v_job_id
  from cron.job
  where jobname = 'cleanup_api_rate_limit_buckets_hourly';

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;
end;
$$;

drop function if exists public.cleanup_api_rate_limit_buckets();
drop function if exists public.consume_api_rate_limit(text);
drop table if exists public.api_rate_limit_buckets;
