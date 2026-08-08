-- Integrated security review: manager-only jobs must enforce their capability
-- at the public RPC boundary, not only in the web route that normally calls it.

create or replace function public.enqueue_background_job(
  p_restaurant_id uuid,
  p_job_type text,
  p_idempotency_key text,
  p_subject_table text default null,
  p_subject_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_max_attempts integer default 3,
  p_run_after timestamptz default now()
)
returns public.background_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requester uuid := auth.uid();
  v_job public.background_jobs;
begin
  if v_requester is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  if p_job_type is null
     or p_job_type not in ('invoice_ocr', 'wine_enrichment', 'wine_list_pdf') then
    raise exception using errcode = '22023', message = 'unsupported background job type';
  end if;

  if p_job_type = 'wine_enrichment' then
    if not public.is_member_with_role(p_restaurant_id, 'manager') then
      raise exception using errcode = '42501', message = 'background job access denied';
    end if;
  elsif not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception using errcode = '42501', message = 'background job access denied';
  end if;

  if p_idempotency_key is null
     or p_idempotency_key <> btrim(p_idempotency_key)
     or char_length(p_idempotency_key) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'invalid idempotency key';
  end if;

  if p_subject_table is not null
     and (
       p_subject_table <> btrim(p_subject_table)
       or char_length(p_subject_table) not between 1 and 64
     ) then
    raise exception using errcode = '22023', message = 'invalid subject table';
  end if;

  if p_metadata is null or pg_column_size(p_metadata) > 1048576 then
    raise exception using errcode = '22023', message = 'invalid background job metadata';
  end if;

  if p_max_attempts not between 1 and 10 then
    raise exception using errcode = '22023', message = 'max attempts must be between 1 and 10';
  end if;

  if p_run_after is null or p_run_after > now() + interval '30 days' then
    raise exception using errcode = '22023', message = 'invalid background job schedule';
  end if;

  insert into public.background_jobs (
    restaurant_id,
    created_by,
    job_type,
    idempotency_key,
    subject_table,
    subject_id,
    metadata,
    max_attempts,
    run_after
  ) values (
    p_restaurant_id,
    v_requester,
    p_job_type,
    p_idempotency_key,
    p_subject_table,
    p_subject_id,
    p_metadata,
    p_max_attempts,
    p_run_after
  )
  on conflict (restaurant_id, job_type, idempotency_key)
    where idempotency_key is not null
  do nothing
  returning * into v_job;

  if v_job.id is null then
    select *
    into v_job
    from public.background_jobs
    where restaurant_id = p_restaurant_id
      and job_type = p_job_type
      and idempotency_key = p_idempotency_key;

    if v_job.id is null
       or v_job.created_by is distinct from v_requester
       or v_job.subject_table is distinct from p_subject_table
       or v_job.subject_id is distinct from p_subject_id
       or v_job.metadata is distinct from p_metadata
       or v_job.max_attempts is distinct from p_max_attempts then
      raise exception using
        errcode = '22023',
        message = 'idempotency key was reused with different job input';
    end if;
  end if;

  return v_job;
end;
$$;

revoke all on function public.enqueue_background_job(
  uuid, text, text, text, uuid, jsonb, integer, timestamptz
) from public, anon;
grant execute on function public.enqueue_background_job(
  uuid, text, text, text, uuid, jsonb, integer, timestamptz
) to authenticated;

comment on function public.enqueue_background_job(
  uuid, text, text, text, uuid, jsonb, integer, timestamptz
) is 'Tenant-bound durable enqueue with job-type-specific authorization; wine enrichment requires manager authority.';
