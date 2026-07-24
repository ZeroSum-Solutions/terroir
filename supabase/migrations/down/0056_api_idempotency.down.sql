-- Reverse of 0056_api_idempotency.sql.

do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname = 'cleanup_api_idempotency_hourly'
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end;
$$;

drop function if exists public.cleanup_api_idempotency();
drop function if exists public.release_api_idempotency(
  uuid,
  text,
  text,
  text
);
drop function if exists public.fail_api_idempotency(
  uuid,
  text,
  text,
  text
);
drop function if exists public.complete_api_idempotency(
  uuid,
  text,
  text,
  text,
  integer,
  jsonb,
  jsonb
);
drop function if exists public.claim_api_idempotency(
  uuid,
  text,
  text,
  text
);
drop table if exists public.api_idempotency;
