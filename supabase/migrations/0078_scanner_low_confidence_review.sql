-- TER-022: a low-confidence scan cannot reach inventory until the caller has
-- explicitly reviewed it. The wrapper locks the scan, checks the persisted
-- provider output, records the reviewer, and delegates the existing atomic
-- idempotent commit in the same transaction.

alter table public.invoice_scans
  add column if not exists low_confidence_reviewed_at timestamptz,
  add column if not exists low_confidence_reviewed_by uuid;

create or replace function public.commit_reviewed_invoice_scan_idempotent(
  p_restaurant_id uuid,
  p_scan_id uuid,
  p_low_confidence_reviewed boolean,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean,
  wine_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_items jsonb;
  v_requires_review boolean := false;
  v_result record;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null or p_scan_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id and scan_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  select final_line_items
  into v_items
  from public.invoice_scans
  where invoice_scans.id = p_scan_id
    and invoice_scans.restaurant_id = p_restaurant_id
  for update;

  if found and jsonb_typeof(v_items) = 'array' then
    select exists (
      select 1
      from jsonb_array_elements(v_items) as entries(item)
      where (
        jsonb_typeof(item -> 'confidence') = 'number'
        and (item ->> 'confidence')::numeric < 0.75
      ) or (
        jsonb_typeof(item -> 'lowFields') = 'array'
        and jsonb_array_length(item -> 'lowFields') > 0
      )
    ) into v_requires_review;
  end if;

  if v_requires_review and not coalesce(p_low_confidence_reviewed, false) then
    return query
    select
      'review_required'::text,
      422,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'low_confidence_review_required',
          'message', 'Review low-confidence scan fields before committing.'
        )
      ),
      false,
      null::uuid[];
    return;
  end if;

  for v_result in
    select *
    from public.commit_invoice_scan_idempotent(
      p_restaurant_id,
      p_scan_id,
      p_idempotency_key,
      p_request_hash
    )
  loop
    if v_result.outcome = 'committed' and v_requires_review then
      update public.invoice_scans
      set
        low_confidence_reviewed_at = clock_timestamp(),
        low_confidence_reviewed_by = v_user_id
      where invoice_scans.id = p_scan_id
        and invoice_scans.restaurant_id = p_restaurant_id;
    end if;

    return query
    select
      v_result.outcome::text,
      v_result.response_status::integer,
      v_result.response_body::jsonb,
      v_result.replayed::boolean,
      v_result.wine_ids::uuid[];
  end loop;
end;
$$;

revoke all on function public.commit_invoice_scan_idempotent(
  uuid,
  uuid,
  text,
  text
) from authenticated;

revoke all on function public.commit_reviewed_invoice_scan_idempotent(
  uuid,
  uuid,
  boolean,
  text,
  text
) from public, anon;

grant execute on function public.commit_reviewed_invoice_scan_idempotent(
  uuid,
  uuid,
  boolean,
  text,
  text
) to authenticated;

comment on function public.commit_reviewed_invoice_scan_idempotent(
  uuid,
  uuid,
  boolean,
  text,
  text
) is
  'Atomically blocks unreviewed low-confidence invoice scans, records review, and commits inventory idempotently.';

comment on column public.invoice_scans.low_confidence_reviewed_at is
  'Timestamp of the explicit review that authorized a low-confidence inventory commit.';

comment on column public.invoice_scans.low_confidence_reviewed_by is
  'Authenticated member who explicitly reviewed a low-confidence scan before commit.';
